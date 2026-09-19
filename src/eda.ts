import { hash, native, layers, type Board, type Pad, type Layer, type Route } from './model.js';
import { assembleOutline } from './geometry.js';
import { Transaction } from './runtime.js';
import { primitiveReader } from './pcb-primitives.js';
import { scaleSource, polygonIslands, joinOutline, type PathSource } from './polygon.js';

// This function is serialized into the EDA runtime; keep every helper inside it.
function pcbRead(eda: any, extraReader: any) {
  return (async () => {
    const get = (v: any, name: string) => { const fn = v[`getState_${name}`]; return typeof fn === 'function' ? fn.call(v) : undefined; };
    const rows = async (module: string, fields: string[]) => {
      if (typeof eda[module]?.getAll !== 'function') throw new Error(`CAPABILITY_MISSING:${module}.getAll`);
      return (await eda[module].getAll()).map((v: any) => Object.fromEntries(fields.map(f => [f, get(v, f)])));
    };
    const components = await rows('pcb_PrimitiveComponent', ['PrimitiveId', 'Designator', 'Name', 'OtherProperty', 'ManufacturerId', 'SupplierId', 'X', 'Y', 'Rotation', 'PrimitiveLock', 'Footprint', 'Pads']);
    const pads = await rows('pcb_PrimitivePad', ['PrimitiveId', 'Net', 'PadNumber', 'X', 'Y', 'Layer', 'Pad', 'Rotation', 'Metallization', 'SpecialPad']);
    const lines = await rows('pcb_PrimitiveLine', ['PrimitiveId', 'Net', 'Layer', 'StartX', 'StartY', 'EndX', 'EndY', 'LineWidth']);
    const vias = await rows('pcb_PrimitiveVia', ['PrimitiveId', 'Net', 'X', 'Y', 'Diameter', 'HoleDiameter', 'ViaType']);
    const primitives = await extraReader(eda);
    return { components, pads, lines, vias, unsupported: primitives.unavailable.map((k:string)=>`${k}: reader unavailable`), primitives: primitives.items };
  })();
}

export async function readBoard(tx: Transaction): Promise<Board> {
  if (tx.target.domain !== 'pcb') throw new Error('PCB target required');
  const raw = await tx.read(`const __name=(fn)=>fn; return (${pcbRead.toString()})(eda, ${primitiveReader.toString()});`);
  const mm = (v: number) => { if (!Number.isFinite(v)) throw new Error('Invalid geometry returned by EDA'); return v * 0.0254; };
  const copperLayers = (layer: number, plated = true): Layer[] => layer === layers.top ? ['top'] : layer === layers.bottom ? ['bottom'] : layer === layers.multi && plated ? ['top', 'bottom'] : [];
  const components = raw.components.map((c: any) => ({ id: c.PrimitiveId, designator: c.Designator ?? '', name: c.Name ?? '', value: [c.OtherProperty?.Value, c.ManufacturerId, c.Name?.startsWith('={') ? undefined : c.Name].find(v => v !== undefined && v !== null && v !== ''), supplierId: c.SupplierId, x: mm(c.X), y: mm(c.Y), rotation: c.Rotation, locked: !!c.PrimitiveLock, footprint: c.Footprint, pads: c.Pads }));
  const unknown: string[] = [...raw.unsupported];
  const pads: Pad[] = raw.pads.map((v: any) => {
    const shape = v.Pad ?? [], kind = shape[0];
    const supported = kind === 'RECT' ? 'rectangle' : kind === 'ELLIPSE' && shape[1] === shape[2] ? 'circle' : kind === 'OVAL' ? 'oblong' : 'unknown';
    const parent = components.find((c: any) => c.pads?.some((p: any) => p.primitiveId === v.PrimitiveId || c.id + p.primitiveId === v.PrimitiveId));
    const special = Array.isArray(v.SpecialPad) ? v.SpecialPad.length > 0 : !!v.SpecialPad;
    return { id: v.PrimitiveId, net: v.Net ?? '', number: v.PadNumber, component: parent?.designator, x: mm(v.X), y: mm(v.Y), layers: copperLayers(v.Layer, v.Metallization), shape: special ? 'unknown' : supported, width: typeof shape[1] === 'number' ? mm(shape[1]) : 0, height: typeof shape[2] === 'number' ? mm(shape[2]) : 0, cornerRadius: kind === 'RECT' ? mm(shape[3] ?? 0) : 0, rotation: v.Rotation ?? 0, plated: v.Metallization };
  });
  const tracks = raw.lines.filter((v: any) => v.Layer === 1 || v.Layer === 2).map((v: any) => ({ id: v.PrimitiveId, net: v.Net ?? '', layer: v.Layer === 1 ? 'top' as const : 'bottom' as const, start: { x: mm(v.StartX), y: mm(v.StartY) }, end: { x: mm(v.EndX), y: mm(v.EndY) }, width: mm(v.LineWidth) }));
  for (const v of raw.lines) if (v.Layer >= 15 && v.Layer <= 46) unknown.push(`Inner layer track ${v.PrimitiveId}`);
  const outline = assembleOutline(raw.lines.filter((v: any) => v.Layer === 11).map((v: any) => ({ start: { x: mm(v.StartX), y: mm(v.StartY) }, end: { x: mm(v.EndX), y: mm(v.EndY) } })));
  const vias = raw.vias.map((v: any) => {
    if (v.ViaType !== 0) unknown.push(`Unverified via span ${v.PrimitiveId}:${v.ViaType}`);
    return { id: v.PrimitiveId, net: v.Net ?? '', x: mm(v.X), y: mm(v.Y), diameter: mm(v.Diameter), drill: mm(v.HoleDiameter), layers: v.ViaType === 0 ? ['top', 'bottom'] as Layer[] : [] };
  });
  const copper: NonNullable<Board['copper']> = [], outlinePaths: PathSource[] = [];
  const keepouts: Board['keepouts'] = [];
  for (const item of raw.primitives ?? []) {
    const v=item.properties, l=v.Layer, relevant=l===1||l===2||l===11||l===12||(l>=15&&l<=46);
    if (['pad','poured'].includes(item.kind)) continue;
    if (!relevant) { if(l===undefined)unknown.push(`Missing layer: ${item.kind}:${item.id}`); continue; }
    try {
      if(l===11 && ['line','arc','polyline'].includes(item.kind)){
        const source = item.kind==='line'?[v.StartX,v.StartY,'L',v.EndX,v.EndY]:item.kind==='arc'?[v.StartX,v.StartY,'ARC',v.ArcAngle,v.EndX,v.EndY]:v.Polygon;
        outlinePaths.push(scaleSource(source,0.0254));
      } else if (item.kind==='fill'&&(l===1||l===2)&&v.FillMode===0){
        const nested=Array.isArray(v.ComplexPolygon?.[0]);
        const source=nested?v.ComplexPolygon.map((s:PathSource)=>scaleSource(s,0.0254)):scaleSource(v.ComplexPolygon,0.0254);
        polygonIslands(source); copper.push({id:item.id,net:v.Net??'',layer:l===1?'top':'bottom',source});
      } else if (item.kind==='region'&&(l===1||l===2||l===12)&&Array.isArray(v.RuleType)&&v.RuleType.includes(5)){
        const source=scaleSource(v.ComplexPolygon,0.0254);polygonIslands(source);
        keepouts.push({id:item.id,layers:l===12?['top','bottom']:[l===1?'top':'bottom'],polygon:[],source});
      } else if(item.kind==='line'&&(l===1||l===2)){
        // Already normalized as tracks above.
      } else if(item.kind==='pour')unknown.push(`Pour ${item.id}: boundary editable; actual filled copper/freshness not verified`);
      else unknown.push(`Unsupported geometry: ${item.kind}:${item.id}:layer=${l}`);
    } catch(error:any){unknown.push(`${item.kind}:${item.id}: ${error.message}`);}
  }
  if(outlinePaths.length){try{joinOutline(outlinePaths);}catch(e:any){unknown.push(e.message);}}
  return { unit: 'mm', revision: hash(raw), components, pads, tracks, vias, outline, ...(outlinePaths.length?{outlinePaths}:{}), copper, keepouts, unknown };
}

function schematicRead(eda: any) {
  return (async () => {
    const get = (v: any, name: string) => v[`getState_${name}`]?.();
    const components = [];
    for (const c of await eda.sch_PrimitiveComponent.getAll()) {
      const id = get(c, 'PrimitiveId');
      const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id);
      components.push({ id, designator: get(c, 'Designator'), name: get(c, 'Name'), net: get(c, 'Net'), value: get(c, 'OtherProperty')?.Value, supplierId: get(c, 'SupplierId'), x: get(c, 'X') * 0.254, y: get(c, 'Y') * 0.254, rotation: get(c, 'Rotation'), mirror: get(c, 'Mirror'), footprint: get(c, 'Footprint'), device: get(c, 'Component'), addIntoPcb: get(c, 'AddIntoPcb'), pins: (pins ?? []).map((p: any) => ({ id: get(p, 'PrimitiveId'), number: get(p, 'PinNumber'), name: get(p, 'PinName'), x: get(p, 'X') * 0.254, y: get(p, 'Y') * 0.254, rotation: get(p, 'Rotation'), noConnect: get(p, 'NoConnected') })) });
    }
    const wires = (await eda.sch_PrimitiveWire.getAll()).map((w: any) => ({ id: get(w, 'PrimitiveId'), net: get(w, 'Net'), nativeLine: get(w, 'Line') }));
    return { unit: 'mm', components, wires };
  })();
}
export async function readSchematic(tx: Transaction) {
  if (tx.target.domain !== 'schematic') throw new Error('Schematic target required');
  const state = await tx.read(`const __name=(fn)=>fn; return (${schematicRead.toString()})(eda);`);
  return { ...state, revision: hash(state) };
}
export async function readDrc(tx: Transaction) {
  const module = tx.target.domain === 'pcb' ? 'pcb_Drc' : 'sch_Drc';
  const raw = await tx.read(`return await eda.${module}.check(false,false,true);`);
  if (typeof raw === 'boolean') return { passed: raw, detailsAvailable: false, raw };
  if (Array.isArray(raw)) {
    const summaryOnly = raw.length > 0 && raw.every(v => typeof v?.type === 'string' && typeof v?.count === 'number' && Object.keys(v).length === 2);
    return { passed: raw.length === 0, detailsAvailable: !summaryOnly, ...(summaryOnly ? { counts: raw } : { issues: raw }), raw };
  }
  return { passed: null, detailsAvailable: false, raw, limitation: 'Unrecognized DRC response' };
}
export async function save(tx: Transaction) {
  return tx.write(tx.target.domain === 'pcb' ? `return await eda.pcb_Document.save(${JSON.stringify(tx.target.documentId)});` : 'return await eda.sch_Document.save();');
}
export function routeWriteCode(route: Route): string {
  const payload = { net: route.net, segments: route.segments.map(s => ({ layer: layers[s.layer], width: native(s.width, 'pcb'), points: s.points.map(p => ({ x: native(p.x, 'pcb'), y: native(p.y, 'pcb') })) })), vias: route.vias.map(v => ({ x: native(v.x, 'pcb'), y: native(v.y, 'pcb'), drill: native(v.drill, 'pcb'), diameter: native(v.diameter, 'pcb') })) };
  return `const payload=${JSON.stringify(payload)}; const changes=[]; try { for(const v of payload.vias) { const created=await eda.pcb_PrimitiveVia.create(payload.net,v.x,v.y,v.drill,v.diameter); if(!created?.getState_PrimitiveId()) throw new Error('Via returned no ID'); changes.push({kind:'via',id:created.getState_PrimitiveId()}); } for(const s of payload.segments) for(let i=1;i<s.points.length;i++) { const a=s.points[i-1],b=s.points[i]; const created=await eda.pcb_PrimitiveLine.create(payload.net,s.layer,a.x,a.y,b.x,b.y,s.width,false); if(!created?.getState_PrimitiveId()) throw new Error('Track returned no ID'); changes.push({kind:'track',id:created.getState_PrimitiveId()}); } return {status:'success',changes}; } catch(error) { return {status:'partial',changes,error:String(error)}; }`;
}
export async function readNetlist(tx: Transaction) {
  const text = await tx.read(`const file=await eda.sch_ManufactureData.getNetlistFile('verification','JLCEDA'); if(!file?.text) throw new Error('Netlist export unavailable'); return await file.text();`);
  return parseNetlist(text);
}
export function parseNetlist(text: string) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw.components !== 'object' || !raw.components || Array.isArray(raw.components)) throw new Error('Unsupported netlist: expected components object');
  const components: any[] = [], nets: Record<string, { component: string; pin: string }[]> = {};
  for (const [id, value] of Object.entries(raw.components)) {
    const c: any = value;
    const designator = c.props?.Designator ?? c.props?.designator ?? c.attributes?.Designator ?? c.designator ?? c.name ?? id;
    if (!c.pinInfoMap || typeof c.pinInfoMap !== 'object') throw new Error(`Missing pinInfoMap for ${id}`);
    const props = c.props ?? {};
    const displayName = props.Name ?? c.name;
    const template = typeof displayName === 'string' ? /^=\{([^}]+)\}$/.exec(displayName) : null;
    const actualValue = props.Value ?? (template ? props[template[1]] : displayName);
    components.push({ id, designator, value: actualValue, footprint: props.Footprint ?? c.footprint });
    for (const [pinId, info] of Object.entries(c.pinInfoMap)) {
      const pin: any = info;
      if (typeof pin.net === 'string' && pin.net) (nets[pin.net] ??= []).push({ component: designator, pin: String(pin.pinNumber ?? pin.number ?? pinId) });
    }
  }
  const canonical = Object.entries(nets).sort(([a], [b]) => a.localeCompare(b)).map(([net, pins]) => ({ net, pins: pins.sort((a, b) => `${a.component}.${a.pin}`.localeCompare(`${b.component}.${b.pin}`)) }));
  return { componentCount: components.length, netCount: canonical.length, components, nets: canonical, electricalHash: hash(canonical), empty: components.length === 0 };
}

export function libraryProperties(device: any, reference: string, value?: string) {
  if (!device?.property) throw new Error('Library device has no properties');
  const props = device.property, source = props.otherProperty ?? {};
  const reserved = /^(Symbol|Footprint|3D Model|Device|Designator|Name|Manufacturer|Manufacturer Part|Supplier|Supplier Part|Add into BOM|Convert to PCB)$/;
  const otherProperty = Object.fromEntries(Object.entries(source).filter(([key]) => !reserved.test(key) && !key.startsWith('3D Model')));
  if (value !== undefined) otherProperty.Value = value;
  return { designator: reference, name: source.Name || props.name || device.name, manufacturer: props.manufacturer ?? '', manufacturerId: props.manufacturerId ?? '', supplier: props.supplier ?? '', supplierId: props.supplierId ?? '', otherProperty };
}

export function verifyNetContracts(netlist: ReturnType<typeof parseNetlist>, expected: { net: string; pins: { reference: string; pin: string }[] }[]) {
  const missing = expected.flatMap(n => n.pins.filter(p => !netlist.nets.find(v => v.net === n.net)?.pins.some(v => v.component === p.reference && v.pin === p.pin)).map(p => ({ net: n.net, ...p })));
  const unexpected = expected.flatMap(n => (netlist.nets.find(v => v.net === n.net)?.pins ?? []).filter(p => !n.pins.some(v => v.reference === p.component && v.pin === p.pin)).map(p => ({ net: n.net, ...p })));
  const duplicateReferences = netlist.components.map(c => c.designator).filter((ref, i, refs) => refs.indexOf(ref) !== i);
  return { missing, unexpected, duplicateReferences, passed: !netlist.empty && !missing.length && !unexpected.length && !duplicateReferences.length };
}

export function compareBoardSnapshots(before: Board, after: Board, tolerance = 0.00001) {
  const differences: string[] = []; let maxNumericDrift = 0;
  const visit = (a: any, b: any, path: string) => {
    if (path === 'revision' || Object.is(a, b)) return;
    if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) {
      const delta = Math.abs(a - b); maxNumericDrift = Math.max(maxNumericDrift, delta);
      if (delta > tolerance) differences.push(path);
    } else if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) visit(a[key], b[key], path ? `${path}.${key}` : key);
    } else differences.push(path);
  };
  visit(before, after, '');
  return { unchanged: !differences.length, tolerance, maxNumericDrift, differences };
}
