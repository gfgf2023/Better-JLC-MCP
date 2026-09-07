import { z } from 'zod';
import { PNG } from 'pngjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Registry } from './registry.js';
import { Runtime } from './runtime.js';
import { pointSchema, finite, targetSchema, unitSchema, routeSchema, layerSchema, layers, native, toMm, hash, result, type Result, type Target } from './model.js';
import { connectivity, checkRoute, routeCoverage } from './geometry.js';
import { readBoard, readSchematic, readDrc, readNetlist, save, routeWriteCode, libraryProperties, verifyNetContracts, compareBoardSnapshots } from './eda.js';
import { workflows, memoryRules } from './workflows.js';

const targeted = { target: targetSchema };
const mutation = { ...targeted, operationId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) };
const json = JSON.stringify;
const errorResult = (message: string, evidence: any, target?: Target): Result => ({ ...result(null, target), status: 'failed', error: message, evidence, next: ['Correct the reported issue and inspect the current document.'] });
const assertDomain = (target: Target, domain: Target['domain']) => { if (target.domain !== domain) throw new Error(`${domain} document required`); };
const ensureRevision = (actual: string, expected: string) => { if (actual !== expected) throw new Error('STALE_REVISION: Read current document and re-plan'); };

export function buildToolkit(runtime: Runtime, registry = new Registry()) {
  const add = (name: string, category: string, description: string, schema: z.AnyZodObject, handler: (a: any) => Promise<Result>, options: any = {}) => registry.add({ name, category, description, schema, handler, ...options });
  add('eda_session', 'session', 'Inspect bridge, windows, active project, document and boards. Use returned target unchanged on subsequent tools.', z.object({ windowId: z.string().optional() }).strict(), async a => result(await runtime.inspect(a.windowId)), { direct: true });
  add('eda_workflow', 'guidance', 'Read the workflow for the current design stage, including placement, image feedback and recovery.', z.object({ stage: z.enum(['start', 'schematic', 'placement', 'routing', 'review', 'recovery']) }).strict(), async a => result({ stage: a.stage, instructions: workflows[a.stage as keyof typeof workflows], memoryRules }), { direct: true });
  add('eda_capabilities', 'session', 'Inspect method availability; existence is not a successful behavioral test.', z.object(targeted).strict(), async ({ target }) => result(await runtime.read(target, tx => tx.read(`const names=['pcb_PrimitiveLine.create','pcb_Drc.check','sch_PrimitiveComponent.create','sch_PrimitiveComponent.getAllPinsByPrimitiveId','sch_PrimitiveWire.create','sch_ManufactureData.getNetlistFile','pcb_Document.importChanges','sys_FileManager.getProjectFile','sys_FileManager.getDocumentSource','dmt_EditorControl.getCurrentRenderedAreaImage']; return Object.fromEntries(names.map(name=>{const [m,f]=name.split('.');return [name,typeof eda[m]?.[f]==='function'];}));`)), target));
  add('eda_open_document', 'session', 'Activate an explicit document in the same project and return its new target. Does not infer documents from tab titles.', z.object({ ...targeted, documentId: z.string().min(1), domain: z.enum(['pcb', 'schematic']) }).strict(), async a => {
    const data = await runtime.read(a.target, tx => tx.read(`const tab=await eda.dmt_EditorControl.openDocument(${json(a.documentId)}); if(!tab) throw new Error('Document failed to open'); if(!await eda.dmt_EditorControl.activateDocument(tab)) throw new Error('Activation failed'); return await eda.dmt_SelectControl.getCurrentDocumentInfo();`));
    if (data.uuid !== a.documentId || data.parentProjectUuid !== a.target.projectId || data.documentType !== (a.domain === 'pcb' ? 3 : 1)) throw new Error('Opened document did not match requested target');
    const target = { ...a.target, documentId: a.documentId, domain: a.domain };
    return result({ document: data, target }, target);
  }, { direct: true });
  add('eda_create_test_project', 'project', 'Create and open a NEW test project after backing up current target. Creates linked schematic and PCB, returning UUIDs.', z.object({ ...mutation, name: z.string().min(1).max(80), teamId: z.string().optional() }).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => {
    await save(tx);
    const data = await tx.write(`const id=await eda.dmt_Project.createProject(${json(a.name)},undefined,${json(a.teamId)}); if(!id) throw new Error('Project creation failed'); const changes=[{kind:'project',id}]; try {if(!await eda.dmt_Project.openProject(id)) throw new Error('Open failed'); const schematicId=await eda.dmt_Schematic.createSchematic('Main'); const pcbId=await eda.dmt_Pcb.createPcb('Main'); if(!schematicId||!pcbId) throw new Error('Document creation failed'); const boardId=await eda.dmt_Board.createBoard(schematicId,pcbId); const pages=await eda.dmt_Schematic.getAllSchematicPagesInfo(); const existing=pages.find(p=>p.parentSchematicUuid===schematicId); const pageId=existing?.uuid || await eda.dmt_Schematic.createSchematicPage(schematicId); const tab=await eda.dmt_EditorControl.openDocument(pageId); await eda.dmt_EditorControl.activateDocument(tab); return {status:'success',changes,projectId:id,schematicId,pcbId,boardId,pageId,document:await eda.dmt_SelectControl.getCurrentDocumentInfo()};} catch(e){return {status:'partial',changes,error:String(e)}}`);
    return result({ ...data, target: { windowId: a.target.windowId, projectId: data.projectId, documentId: data.pageId, domain: 'schematic' } });
  }), { mutates: true });
  add('sch_create_page', 'schematic', 'Create a page in an existing schematic UUID. Explicitly activate the returned page.', z.object({ ...mutation, schematicId: z.string() }).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => result(await tx.write(`const rows=await eda.dmt_Schematic.getAllSchematicsInfo(); if(!rows.some(s=>s.uuid===${json(a.schematicId)})) throw new Error('Schematic not in target project'); const id=await eda.dmt_Schematic.createSchematicPage(${json(a.schematicId)}); if(!id) throw new Error('Page creation failed');return {changes:[{kind:'page',id}],pageId:id};`))), { mutates: true });
  add('lib_search_devices', 'library', 'Search official library devices by keyword or LCSC part number. Returns real bindings; prices and stock are not inferred.', z.object({ ...targeted, query: z.string().min(1), lcsc: z.boolean().default(false), page: z.number().int().positive().default(1), limit: z.number().int().min(1).max(50).default(10) }).strict(), async a => result(await runtime.read(a.target, tx => tx.read(a.lcsc ? `return await eda.lib_Device.getByLcscIds([${json(a.query)}]);` : `return await eda.lib_Device.search(${json(a.query)},undefined,undefined,undefined,${a.limit},${a.page});`)), a.target), { direct: true });
  add('sch_get_state', 'schematic', 'Read components, footprint bindings, actual world pin coordinates and wires in mm, including rotated/mirrored pins.', z.object(targeted).strict(), async a => result(await runtime.read(a.target, readSchematic), a.target), { direct: true });
  add('sch_place_component', 'schematic', 'Place a real library device and assign reference/value. Uses existing footprint binding; read pins afterwards.', z.object({ ...mutation, libraryUuid: z.string().min(1), deviceUuid: z.string().min(1), reference: z.string().min(1), value: z.string().optional(), ...pointSchema.shape, unit: unitSchema, rotation: finite.default(0), mirror: z.boolean().default(false), subPart: z.string().default('') }).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => {
    const state = await readSchematic(tx);
    if (state.components.some((c: any) => c.designator === a.reference)) throw new Error('Reference already exists');
    const device = await tx.read(`return await eda.lib_Device.get(${json(a.deviceUuid)},${json(a.libraryUuid)});`);
    const properties = libraryProperties(device, a.reference, a.value);
    const x = native(toMm(a.x, a.unit), 'schematic'), y = native(toMm(a.y, a.unit), 'schematic');
    await tx.write(`const c=await eda.sch_PrimitiveComponent.create(${json(device)},${x},${y},${json(a.subPart || device.subPartNames?.[0] || '')},${a.rotation},${a.mirror},true,true);const id=c?.getState_PrimitiveId();if(!id)throw new Error('Creation returned no ID');const changes=[{kind:'component',id}];try{const updated=await eda.sch_PrimitiveComponent.modify(id,${json(properties)});if(!updated)throw new Error('Reference update failed');return {status:'success',changes};}catch(e){return {status:'partial',changes,error:String(e)}}`);
    await save(tx);
    const after = await readSchematic(tx), placed = after.components.find((c: any) => c.designator === a.reference);
    if (!placed) throw new Error('Placed reference missing on readback');
    return result({ component: placed, drc: await readDrc(tx), footprintVerified: !!placed.footprint });
  }), { mutates: true });
  const pin = z.object({ reference: z.string().min(1), pin: z.string().min(1) }).strict();
  const resolvePin = (state: any, endpoint: any) => {
    const pins = state.components.filter((c: any) => c.designator === endpoint.reference).flatMap((c: any) => c.pins.filter((p: any) => p.number === endpoint.pin));
    if (pins.length !== 1 || pins[0].noConnect) throw new Error(`Ambiguous, missing or no-connect pin: ${endpoint.reference}.${endpoint.pin}`);
    return pins[0];
  };
  add('sch_connect_pins', 'schematic', 'Connect exact reference/pin endpoints through MODEL-supplied vertices. Resolves real coordinates and verifies actual netlist.', z.object({ ...mutation, net: z.string().min(1), from: pin, to: pin, via: z.array(pointSchema).max(100).default([]), unit: unitSchema }).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => {
    const before = await readSchematic(tx), from = resolvePin(before, a.from), to = resolvePin(before, a.to);
    if (a.from.reference === a.to.reference && a.from.pin === a.to.pin) throw new Error('Identical endpoints');
    const vertices = [from, ...a.via.map((p: any) => ({ x: toMm(p.x, a.unit), y: toMm(p.y, a.unit) })), to];
    const line = vertices.flatMap((p: any) => [native(p.x, 'schematic'), native(p.y, 'schematic')]);
    await tx.write(`const wire=await eda.sch_PrimitiveWire.create(${json(line)},${json(a.net)});const id=wire?.getState_PrimitiveId();if(!id)throw new Error('Wire creation failed');return {changes:[{kind:'wire',id}]};`);
    await save(tx);
    const netlist = await readNetlist(tx), net = netlist.nets.find(n => n.net === a.net);
    const matches = (e: any) => net?.pins.some(p => p.component === e.reference && p.pin === e.pin);
    const verified = !!matches(a.from) && !!matches(a.to);
    return { ...result({ netlist, drc: await readDrc(tx) }), status: verified ? 'success' : 'partial', evidence: { connectionVerified: verified }, next: verified ? [] : ['Inspect exported pin mappings; connection was not verified.'] };
  }), { mutates: true });
  add('sch_add_net_label', 'schematic', 'Connect a named wire stub to an exact pin; optionally add a port symbol. Overlapping endpoints alone are NOT connected. Verify actual netlist afterwards.', z.object({ ...mutation, endpoint: pin, net: z.string().min(1), port: z.boolean().default(false), direction: z.enum(['IN', 'OUT', 'BI']).default('BI'), stubMm: finite.positive().default(5.08) }).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => {
    const state = await readSchematic(tx), p = resolvePin(state, a.endpoint);
    const angle = p.rotation * Math.PI / 180, end = { x: p.x + a.stubMm * Math.cos(angle), y: p.y + a.stubMm * Math.sin(angle) };
    if (state.components.some((c: any) => !c.designator && Math.hypot(c.x - end.x, c.y - end.y) < 0.001)) throw new Error('Existing label/port at stub endpoint');
    await tx.write(`const changes=[];try{const w=await eda.sch_PrimitiveWire.create(${json([native(p.x, 'schematic'), native(p.y, 'schematic'), native(end.x, 'schematic'), native(end.y, 'schematic')])},${json(a.net)});if(!w)throw new Error('Stub creation failed');changes.push({kind:'wire',id:w.getState_PrimitiveId()});if(${a.port}){const c=await eda.sch_PrimitiveComponent.createNetPort(${json(a.direction)},${json(a.net)},${native(end.x, 'schematic')},${native(end.y, 'schematic')},${p.rotation});if(!c)throw new Error('Port creation failed');changes.push({kind:'net_port',id:c.getState_PrimitiveId()});}return {status:'success',changes};}catch(e){return {status:'partial',changes,error:String(e)}}`);
    await save(tx);
    const netlist = await readNetlist(tx), verified = netlist.nets.find(n => n.net === a.net)?.pins.some(p => p.component === a.endpoint.reference && p.pin === a.endpoint.pin);
    return { ...result({ state: await readSchematic(tx), netlist, drc: await readDrc(tx) }), status: verified ? 'success' : 'partial' };
  }), { mutates: true });
  add('sch_add_annotation', 'schematic', 'Add non-electrical section title or design note using the editor default font; compare electrical netlists before/after.', z.object({ ...mutation, text: z.string().min(1).max(2000), ...pointSchema.shape, unit: unitSchema }).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => {
    assertDomain(a.target, 'schematic'); const before = await readNetlist(tx);
    await tx.write(`const c=await eda.sch_PrimitiveText.create(${native(toMm(a.x, a.unit), 'schematic')},${native(toMm(a.y, a.unit), 'schematic')},${json(a.text)});if(!c)throw new Error('Text creation failed');return {changes:[{kind:'text',id:c.getState_PrimitiveId()}]};`);
    await save(tx); const after = await readNetlist(tx);
    if (before.electricalHash !== after.electricalHash || before.componentCount !== after.componentCount) throw new Error('Unexpected electrical change after annotation');
    return result({ electricalUnchanged: true, netlist: after });
  }), { mutates: true });
  add('sch_get_netlist', 'verification', 'Export actual JLCEDA netlist with canonical pin/net mapping. Does not estimate connectivity from proximity.', z.object(targeted).strict(), async a => { assertDomain(a.target, 'schematic'); return result(await runtime.read(a.target, readNetlist), a.target); });
  add('sch_get_attributes', 'schematic', 'Read actual text attributes of explicit parent primitives in mm. Hidden attributes retain null coordinates.', z.object({ ...targeted, parentIds: z.array(z.string()).min(1).max(100) }).strict(), async a => runtime.read(a.target, async tx => {
    assertDomain(a.target, 'schematic');
    return result(await tx.read(`const out=[];for(const id of ${json(a.parentIds)})for(const a of await eda.sch_PrimitiveAttribute.getAll(id))out.push({id:a.getState_PrimitiveId(),parentId:id,key:a.getState_Key(),value:a.getState_Value(),x:a.getState_X()===null?null:a.getState_X()*0.254,y:a.getState_Y()===null?null:a.getState_Y()*0.254,visible:a.getState_ValueVisible(),alignMode:a.getState_AlignMode()});return out;`), a.target);
  }));
  add('sch_arrange_attributes', 'schematic', 'Move explicit visible text attributes only, optionally restoring the editor default font. Values, bindings and electrical properties cannot change. Compares netlist before/after.', z.object({ ...mutation, moves: z.array(z.object({ id: z.string(), ...pointSchema.shape, resetFont: z.boolean().default(false), rotation: finite.optional(), alignMode: z.enum(['LEFT_TOP','LEFT_MIDDLE','LEFT_BOTTOM','CENTER_TOP','CENTER_MIDDLE','CENTER_BOTTOM','RIGHT_TOP','RIGHT_MIDDLE','RIGHT_BOTTOM']).optional() }).strict()).min(1).max(100) }).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => {
    assertDomain(a.target, 'schematic'); const before = await readNetlist(tx);
    const align: Record<string, number> = { LEFT_TOP: 1, LEFT_MIDDLE: 2, LEFT_BOTTOM: 3, CENTER_TOP: 4, CENTER_MIDDLE: 5, CENTER_BOTTOM: 6, RIGHT_TOP: 7, RIGHT_MIDDLE: 8, RIGHT_BOTTOM: 9 };
    const moves = a.moves.map(({ resetFont, ...m }: any) => ({ ...m, ...(resetFont ? { fontSize: null } : {}), alignMode: m.alignMode ? align[m.alignMode] : undefined, x: native(m.x, 'schematic'), y: native(m.y, 'schematic') }));
    await tx.write(`const changes=[];try{for(const m of ${json(moves)}){const {id,...props}=m;const attr=await eda.sch_PrimitiveAttribute.get(id);if(!attr||attr.getState_ValueVisible()!==true)throw new Error('Attribute missing or hidden');if(!await eda.sch_PrimitiveAttribute.modify(id,props))throw new Error('Attribute move failed');changes.push({kind:'attribute_layout',id});}return {changes};}catch(e){return {status:'partial',changes,error:String(e)}}`);
    await save(tx); const after = await readNetlist(tx);
    return { ...result({ electricalUnchanged: before.electricalHash === after.electricalHash, netlist: after }), status: before.electricalHash === after.electricalHash ? 'success' : 'partial' };
  }), { mutates: true });
  add('sch_verify', 'verification', 'Verify intended pin/net contracts, nonempty netlist and native schematic DRC.', z.object({ ...targeted, expected: z.array(z.object({ net: z.string(), pins: z.array(pin).min(1) }).strict()).default([]) }).strict(), async a => runtime.read(a.target, async tx => {
    const netlist = await readNetlist(tx), drc = await readDrc(tx), state = await readSchematic(tx);
    const contracts = verifyNetContracts(netlist, a.expected);
    const duplicates = state.wires.filter((w: any, i: number) => state.wires.findIndex((other: any) => other.net === w.net && json(other.nativeLine) === json(w.nativeLine)) !== i).map((w: any) => w.id);
    return { ...result({ netlist, drc, ...contracts, duplicateWires: duplicates }, a.target), status: contracts.passed && !duplicates.length && drc.passed === true ? 'success' : 'failed' };
  }));
  add('pcb_import_schematic', 'pcb', 'Import a schematic DOCUMENT UUID into PCB and verify real components and pads appeared.', z.object({ ...mutation, schematicId: z.string().min(1), expectedReferences: z.array(z.string()).min(1) }).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => {
    const before = await readBoard(tx);
    await tx.write(`const list=await eda.dmt_Schematic.getAllSchematicsInfo();if(!list.some(s=>s.uuid===${json(a.schematicId)}))throw new Error('Schematic UUID not in current project');return await eda.pcb_Document.importChanges(${json(a.schematicId)});`);
    await save(tx); const after = await readBoard(tx);
    const missing = a.expectedReferences.filter((ref: string) => !after.components.some(c => c.designator === ref && c.footprint && after.pads.some(p => p.component === ref)));
    return { ...result({ beforeCount: before.components.length, board: after, missing }), status: missing.length ? 'partial' : 'success', next: missing.length ? ['The editor may be awaiting Import Changes confirmation. Complete that UI step, then read pcb_get_state and verify references/pad nets; do not blindly replay importChanges.'] : [] };
  }), { mutates: true });
  add('pcb_get_state', 'pcb', 'Read real pads, tracks, vias, components and outline in mm, with revision and explicit unsupported geometry.', z.object(targeted).strict(), async a => result(await runtime.read(a.target, readBoard), a.target), { direct: true });
  add('pcb_get_routing_context', 'routing', 'Read net endpoints, copper, obstacles, outline and connectivity before the MODEL chooses a path. No autorouting.', z.object({ ...targeted, net: z.string().min(1) }).strict(), async a => runtime.read(a.target, async tx => {
    const board = await readBoard(tx), endpoints = board.pads.filter(p => p.net === a.net);
    if (!endpoints.length) throw new Error('No pads for requested net');
    return result({ ...board, endpoints, connectivity: connectivity(board, a.net), guidance: workflows.routing }, a.target);
  }), { direct: true });
  add('pcb_check_route', 'routing', 'Check explicit MODEL-supplied path against copper, pad shapes, board edges and layer transitions. Read-only; never plans or applies routes.', z.object({ ...targeted, route: routeSchema }).strict(), async a => runtime.read(a.target, async tx => { const board = await readBoard(tx); return result({ revision: board.revision, ...checkRoute(board, a.route) }, a.target); }), { direct: true });
  add('pcb_apply_route', 'routing', 'Apply MODEL-supplied path after fresh geometry/revision checks. Read back actual IDs and connectivity, then DRC. No autorouter.', z.object({ ...mutation, revision: z.string().min(1), route: routeSchema }).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => {
    const board = await readBoard(tx); ensureRevision(board.revision, a.revision);
    const checked = checkRoute(board, a.route);
    if (!checked.passed) return errorResult('Route failed precheck; nothing was written', checked, a.target);
    const beforeDrc = await readDrc(tx);
    await tx.write(routeWriteCode(checked.route)); await save(tx);
    const after = await readBoard(tx), ids = new Set([...after.tracks, ...after.vias].map(v => v.id));
    const missing = tx.changes.filter(c => !ids.has(c.id)), conn = connectivity(after, checked.route.net), drc = await readDrc(tx);
    const endpointsConnected = conn.nets.some(n => n.islands.some(g => g.includes(checked.route.from.padId) && g.includes(checked.route.to.padId)));
    const coverage = routeCoverage(after, checked.route);
    const verified = coverage.passed && endpointsConnected && !conn.shorts.length && !conn.unknown.length;
    return { ...result({ revision: after.revision, connectivity: conn, drc, beforeDrc, missing, coverage }), status: verified ? 'success' : 'partial', evidence: { endpointsConnected, pathReadback: coverage.passed, idsPreserved: !missing.length, drcPassed: drc.passed }, next: ['Inspect a local eda_screenshot before the next net.', ...(missing.length ? ['EDA may merge tracks. Missing IDs cannot be used for rollback; inspect the current copper before corrective edits.'] : []), ...(drc.passed ? [] : ['Review DRC; application success is not board acceptance.'])] };
  }), { direct: true, mutates: true });
  add('pcb_net_connectivity_check', 'verification', 'Compute conductive components and shorts. Track count is not connectivity evidence.', z.object({ ...targeted, net: z.string().optional() }).strict(), async a => result(await runtime.read(a.target, async tx => connectivity(await readBoard(tx), a.net)), a.target));
  add('pcb_move_components', 'placement', 'Move explicit unlocked components using current revision; read actual pad positions afterwards.', z.object({ ...mutation, revision: z.string(), unit: unitSchema, moves: z.array(z.object({ reference: z.string(), ...pointSchema.shape, rotation: finite.optional() }).strict()).min(1).max(30) }).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => {
    const before = await readBoard(tx); ensureRevision(before.revision, a.revision);
    const moves = a.moves.map((m: any) => { const matches = before.components.filter(c => c.designator === m.reference); if (matches.length !== 1 || matches[0].locked) throw new Error(`Missing, ambiguous or locked ${m.reference}`); return { id: matches[0].id, x: native(toMm(m.x, a.unit), 'pcb'), y: native(toMm(m.y, a.unit), 'pcb'), rotation: m.rotation ?? matches[0].rotation }; });
    await tx.write(`const changes=[];try{for(const m of ${json(moves)}){const v=await eda.pcb_PrimitiveComponent.modify(m.id,{x:m.x,y:m.y,rotation:m.rotation});if(!v)throw new Error('Move failed');changes.push({kind:'component_move',id:m.id});}return {status:'success',changes};}catch(e){return {status:'partial',changes,error:String(e)}}`);
    await save(tx); const after = await readBoard(tx);
    const mismatches = moves.filter((m: any) => { const c = after.components.find(c => c.id === m.id); return !c || Math.hypot(c.x - m.x * 0.0254, c.y - m.y * 0.0254) > 0.00001 || Math.abs(c.rotation - m.rotation) > 0.00001; });
    return { ...result({ board: after, drc: await readDrc(tx), mismatches, nextStage: 'placement' }), status: mismatches.length ? 'partial' : 'success' };
  }), { mutates: true });
  add('pcb_create_outline', 'pcb', 'Create a closed straight-segment BOARD_OUTLINE on an empty outline. Not a silkscreen frame.', z.object({ ...mutation, points: z.array(pointSchema).min(3).max(100), unit: unitSchema }).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => {
    const before = await readBoard(tx); if (before.outline.length) throw new Error('Outline already exists');
    const points = a.points.map((p: any) => ({ x: native(toMm(p.x, a.unit), 'pcb'), y: native(toMm(p.y, a.unit), 'pcb') }));
    await tx.write(`const pts=${json(points)},changes=[];try{for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length];const line=await eda.pcb_PrimitiveLine.create('',${layers.outline},a.x,a.y,b.x,b.y,1,false);if(!line)throw new Error('Outline creation failed');changes.push({kind:'outline',id:line.getState_PrimitiveId()});}return {status:'success',changes};}catch(e){return {status:'partial',changes,error:String(e)}}`);
    await save(tx); return result(await readBoard(tx));
  }), { mutates: true });
  add('pcb_delete_route_primitives', 'routing', 'Delete only explicit track/via IDs created by a recorded operation in this target. Never deletes unrelated selection.', z.object({ ...mutation, sourceOperationId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), primitiveIds: z.array(z.string()).min(1) }).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => {
    const record = JSON.parse(await readFile(path.join(runtime.stateDir, hash(a.target), `${a.sourceOperationId}.json`), 'utf8'));
    const selected = a.primitiveIds.map((id: string) => { const c = record.result?.changes?.find((v: any) => v.id === id && ['track', 'via'].includes(v.kind)); if (!c) throw new Error('ID not created by that operation'); return c; });
    await tx.write(`const changes=[];for(const item of ${json(selected)}){const api=item.kind==='track'?eda.pcb_PrimitiveLine:eda.pcb_PrimitiveVia;if(!await api.delete(item.id))return {status:'partial',changes,error:'Delete failed'};changes.push({kind:'deleted',id:item.id});}return {status:'success',changes};`);
    await save(tx); return result({ board: await readBoard(tx), drc: await readDrc(tx) });
  }), { mutates: true });
  add('pcb_review_layout', 'placement', 'Check explicit distance/orientation constraints and list unresolved engineering/visual checks.', z.object({ ...targeted, constraints: z.array(z.discriminatedUnion('kind', [z.object({ kind: z.literal('distance'), from: z.string(), to: z.string(), maxMm: finite.positive(), reason: z.string() }).strict(), z.object({ kind: z.literal('orientation'), reference: z.string(), degrees: finite, reason: z.string() }).strict()])).default([]) }).strict(), async a => runtime.read(a.target, async tx => {
    const b = await readBoard(tx);
    const find = (ref: string) => { const found = b.components.filter(v => v.designator === ref); if (found.length !== 1) throw new Error(`Missing/ambiguous reference ${ref}`); return found[0]; };
    const reports = a.constraints.map((c: any) => { if (c.kind === 'distance') { const x = find(c.from), y = find(c.to), actualMm = Math.hypot(x.x - y.x, x.y - y.y); return { ...c, actualMm, passed: actualMm <= c.maxMm, metric: 'component-origin distance, not loop length' }; } const comp = find(c.reference); return { ...c, actual: comp.rotation, passed: ((comp.rotation - c.degrees) % 360 + 360) % 360 < 0.01 }; });
    return result({ revision: b.revision, reports, geometryLimitations: b.unknown, layoutApproved: false, remaining: ['Inspect full board and critical regions.', 'Check connector escape channels.', 'Verify decoupling, crystal and feedback loops from pads and datasheets.', 'Check ground continuity and returns after copper fill.'], guidance: workflows.placement }, a.target);
  }));
  add('eda_run_drc', 'verification', 'Run native DRC; preserves boolean-only results and never invents issue details.', z.object(targeted).strict(), async a => result(await runtime.read(a.target, readDrc), a.target), { direct: true });
  add('sch_restore_device_metadata', 'schematic', 'Restore value/manufacturer/supplier metadata from a verified source library device. Keeps placed symbol and footprint bindings intact.', z.object({ ...mutation, reference: z.string(), libraryUuid: z.string(), deviceUuid: z.string() }).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => {
    const before = await readSchematic(tx), matches = before.components.filter((c: any) => c.designator === a.reference);
    if (matches.length !== 1) throw new Error('Missing or ambiguous reference');
    const c = matches[0], device = await tx.read(`return await eda.lib_Device.get(${json(a.deviceUuid)},${json(a.libraryUuid)});`);
    if (c.device?.name !== device?.name) throw new Error('Source device name differs from placed device');
    const props = libraryProperties(device, a.reference);
    await tx.write(`const c=await eda.sch_PrimitiveComponent.modify(${json(c.id)},${json(props)});if(!c)throw new Error('Metadata update failed');return {changes:[{kind:'metadata',id:c.getState_PrimitiveId()}]};`);
    await save(tx); const updated = (await readSchematic(tx)).components.find((v: any) => v.id === c.id);
    if (json(updated?.footprint) !== json(c.footprint) || updated?.supplierId !== props.supplierId) throw new Error('Metadata readback mismatch');
    return result({ component: updated, drc: await readDrc(tx) });
  }), { mutates: true });
  add('eda_save', 'project', 'Save exact target document and return source hash for later readback.', z.object(mutation).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => { await save(tx); return result({ saved: true, sourceHash: hash(await tx.read('return await eda.sys_FileManager.getDocumentSource();')) }); }), { mutates: true });
  add('eda_reopen_and_verify', 'verification', 'Save, close and reopen the exact target document. Compare actual PCB geometry or schematic electrical hash and run DRC.', z.object(mutation).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => {
    const read = () => a.target.domain === 'pcb' ? readBoard(tx) : readNetlist(tx);
    const before: any = await read(); await save(tx);
    await tx.write(`if(!await eda.dmt_EditorControl.closeDocument(doc.tabId))throw new Error('Close failed');const tab=await eda.dmt_EditorControl.openDocument(target.documentId);if(!tab||!await eda.dmt_EditorControl.activateDocument(tab))throw new Error('Reopen failed');return {reopened:true};`);
    const after: any = await read(), comparison = a.target.domain === 'pcb' ? compareBoardSnapshots(before, after) : { unchanged: before.electricalHash === after.electricalHash };
    return { ...result({ reopened: true, ...comparison, before, after, drc: await readDrc(tx) }), status: comparison.unchanged ? 'success' : 'partial' };
  }), { mutates: true });
  add('eda_screenshot', 'visual', 'Capture target image and optional local region in mm. Returns native MCP image and pixel validity evidence; inspect it visually.', z.object({ ...targeted, region: z.object({ left: finite, right: finite, top: finite, bottom: finite }).strict().optional() }).strict(), async a => runtime.read(a.target, async tx => {
    if (a.region) { const r = a.region; await tx.read(`return await eda.dmt_EditorControl.zoomToRegion(${native(r.left, a.target.domain)},${native(r.right, a.target.domain)},${native(r.top, a.target.domain)},${native(r.bottom, a.target.domain)},doc.tabId);`); }
    await new Promise(resolve => setTimeout(resolve, 1500));
    const image = await tx.read(`const file=await eda.dmt_EditorControl.getCurrentRenderedAreaImage(doc.tabId);if(!file)throw new Error('Screenshot unavailable');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return {base64:btoa(binary),mimeType:file.type||'image/png',document:doc};`);
    const pixels = inspectPng(Buffer.from(image.base64, 'base64'));
    if (!pixels.valid) return errorResult('Blank or invalid screenshot', pixels, a.target);
    const directory = path.join(runtime.stateDir, 'screenshots'); await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${Date.now()}-${hash(a.target).slice(0, 12)}.png`); await writeFile(file, Buffer.from(image.base64, 'base64'));
    return { ...result({ image, file }, a.target), evidence: { ...pixels, capturedAt: new Date().toISOString(), sourceHash: hash(await tx.read('return await eda.sys_FileManager.getDocumentSource();')) }, next: ['Visually verify identity, loops, labels and ground returns. Pixel validity is not design acceptance.'] };
  }), { direct: true });
  add('pcb_bom_export', 'export', 'Return actual PCB BOM as rows and CSV. No invented stock or manufacturer data.', z.object(targeted).strict(), async a => runtime.read(a.target, async tx => {
    const board = await readBoard(tx), rows = board.components.map(c => ({ reference: c.designator, value: c.value ?? '', footprint: c.footprint?.name ?? c.footprint?.uuid ?? '' }));
    const csv = ['reference,value,footprint', ...rows.map(r => [r.reference, r.value, r.footprint].map(v => `"${String(v).replaceAll('"', '""')}"`).join(','))].join('\r\n');
    return result({ rows, csv }, a.target);
  }));
  add('pcb_design_health_report', 'verification', 'Actual connectivity/DRC evidence. Unknown geometry and unresolved review cannot produce design acceptance.', z.object(targeted).strict(), async a => runtime.read(a.target, async tx => {
    const board = await readBoard(tx), conn = connectivity(board), drc = await readDrc(tx), memory = await runtime.memory(a.target);
    return result({ electricalChecksPassed: conn.passed && drc.passed === true, designAccepted: false, connectivity: conn, drc, componentCount: board.components.length, padCount: board.pads.length, unresolved: memory.unresolved, manualReviewRequired: ['Placement/mechanical constraints', 'Ground/return paths', 'Datasheet-specific constraints'], guidance: workflows.review }, a.target);
  }));
  add('sch_remove_created_objects', 'recovery', 'Remove explicitly identified schematic objects from one recorded operation. Used to recover a failed placement/connection; never removes unrelated objects.', z.object({ ...mutation, sourceOperationId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), primitiveIds: z.array(z.string()).min(1) }).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => {
    assertDomain(a.target, 'schematic');
    const record = JSON.parse(await readFile(path.join(runtime.stateDir, hash(a.target), `${a.sourceOperationId}.json`), 'utf8'));
    const modules: Record<string, string> = { component: 'sch_PrimitiveComponent', net_port: 'sch_PrimitiveComponent', wire: 'sch_PrimitiveWire', text: 'sch_PrimitiveText' };
    const selected = a.primitiveIds.map((id: string) => { const item = record.result?.changes?.find((c: any) => c.id === id && modules[c.kind]); if (!item) throw new Error('Object was not created by that operation'); return { id, module: modules[item.kind] }; });
    await tx.write(`const changes=[];for(const item of ${json(selected)}){if(!await eda[item.module].delete(item.id))return {status:'partial',changes,error:'Deletion failed'};changes.push({kind:'deleted',id:item.id});}return {status:'success',changes};`);
    await save(tx); return result({ state: await readSchematic(tx), drc: await readDrc(tx) });
  }), { mutates: true });
  const memorySchema = z.object({ constraints: z.array(z.string()), decisions: z.array(z.string()), unresolved: z.array(z.string()), observations: z.array(z.object({ api: z.string(), version: z.string(), reproduction: z.string(), evidence: z.string(), verified: z.boolean() }).strict()) }).strict();
  add('eda_memory', 'memory', 'Read project constraints, decisions, unresolved issues and versioned observations.', z.object(targeted).strict(), async a => result(await runtime.memory(a.target), a.target));
  add('eda_update_memory', 'memory', 'Replace project memory with explicit constraints and evidence-tagged observations. Does not edit the EDA document.', z.object({ ...targeted, memory: memorySchema }).strict(), async a => result(await runtime.memory(a.target, a.memory), a.target), { mutates: true });
  add('experimental_route_candidates', 'experimental', 'EXPERIMENTAL read-only single-net L-path candidates, each geometry checked. Never applies routes or crosses obstacles as fallback.', z.object({ ...targeted, fromPad: z.string(), toPad: z.string(), layer: layerSchema, widthMm: finite.positive(), clearanceMm: finite.nonnegative().default(0.2) }).strict(), async a => runtime.read(a.target, async tx => {
    const board = await readBoard(tx), from = board.pads.find(p => p.id === a.fromPad), to = board.pads.find(p => p.id === a.toPad);
    if (!from || !to || from.net !== to.net) throw new Error('Same-net endpoints required');
    const candidates = [[from, { x: from.x, y: to.y }, to], [from, { x: to.x, y: from.y }, to]].map(points => checkRoute(board, { unit: 'mm', net: from.net, from: { padId: from.id }, to: { padId: to.id }, segments: [{ layer: a.layer, width: a.widthMm, points: points.map(p => ({ x: p.x, y: p.y })).filter((p, i, list) => i === 0 || Math.hypot(p.x - list[i - 1].x, p.y - list[i - 1].y) > 0.000001) }], vias: [], clearance: a.clearanceMm }));
    return result({ candidates: candidates.filter(c => c.passed), rejected: candidates.filter(c => !c.passed).map(c => ({ conflicts: c.conflicts, unknown: c.unknown })), applied: false }, a.target);
  }), { experimental: true });
  add('eda_debug_execute', 'debug', 'Unsafe debug escape hatch, off by default. Arbitrary code is not sandboxed; enabling it opts out of routing guarantees.', z.object({ ...mutation, code: z.string().min(1).max(20000) }).strict(), a => runtime.mutate(a.target, a.operationId, a, async tx => result(await tx.write(a.code))), { raw: true, mutates: true });
  if (process.env.EASYEDA_COMPAT === '1') installCompatibility(registry, runtime);
  return registry;
}

export function inspectPng(buffer: Buffer) {
  const png = PNG.sync.read(buffer); let min = 255, max = 0, colored = 0;
  for (let i = 0; i < png.data.length; i += 4) { if (!png.data[i + 3]) continue; const v = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3; min = Math.min(min, v); max = Math.max(max, v); if (v > 5 && v < 250) colored++; }
  return { width: png.width, height: png.height, range: max - min, coloredPixels: colored, valid: png.width >= 32 && png.height >= 32 && max - min > 12 };
}
function installCompatibility(registry: Registry, runtime: Runtime) {
  const aliases: Record<string, string> = { pcb_bridge_status: 'eda_session', pcb_list_eda_windows: 'eda_session', pcb_run_drc: 'eda_run_drc', sch_run_drc: 'eda_run_drc', pcb_screenshot: 'eda_screenshot', pcb_get_feature_support: 'eda_capabilities' };
  for (const [oldName, newName] of Object.entries(aliases)) { const tool = registry.tools.get(newName)!; registry.add({ ...tool, name: oldName, direct: true, description: `Compatibility alias: ${tool.description}`, handler: a => registry.call(newName, a) }); }
  registry.add({ name: 'pcb_route_track', category: 'compatibility', direct: true, mutates: true, description: 'Legacy mil adapter. Requires pinned target and real endpoint pads; uses the same safe path executor.', schema: z.object({ ...mutation, revision: z.string(), net: z.string(), points: z.array(pointSchema).min(2), layer: z.union([z.literal(1), z.literal(2)]), width: finite.positive(), clearance: finite.nonnegative().default(8) }).strict(), handler: async a => {
    const board = await runtime.read(a.target, readBoard);
    const findPad = (point: any) => { const matches = board.pads.filter(p => p.net === a.net && Math.hypot(p.x - toMm(point.x, 'mil'), p.y - toMm(point.y, 'mil')) < 1e-6); if (matches.length !== 1) throw new Error('Legacy endpoint is not one real pad'); return { padId: matches[0].id }; };
    return registry.call('pcb_apply_route', { target: a.target, operationId: a.operationId, revision: a.revision, route: { net: a.net, from: findPad(a.points[0]), to: findPad(a.points.at(-1)), unit: 'mil', clearance: a.clearance, vias: [], segments: [{ layer: a.layer === 1 ? 'top' : 'bottom', width: a.width, points: a.points }] } });
  } });
}
