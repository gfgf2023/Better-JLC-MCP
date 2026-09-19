import { z } from 'zod';
import { Registry } from './registry.js';
import { Runtime, type Transaction } from './runtime.js';
import { targetSchema, unitSchema, finite, layerSchema, layers, toMm, result } from './model.js';
import { primitiveModules, readPrimitives, type PrimitiveKind } from './pcb-primitives.js';
import { type PathSource, scaleSource, polygonIslands, sourceEdges } from './polygon.js';
import { readBoard, readDrc, save } from './eda.js';
import { connectivity } from './geometry.js';

const json=JSON.stringify;
const sourceSchema=z.array(z.union([finite,z.enum(['L','ARC','CARC','R','CIRCLE'])])).min(3).max(20000);
const mutation={target:targetSchema,operationId:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),revision:z.string().min(1)};
const id=z.string().min(1);
const padShape=z.discriminatedUnion('shape',[
  z.object({shape:z.literal('rectangle'),width:finite.positive(),height:finite.positive(),cornerRadius:finite.nonnegative().default(0)}).strict(),
  z.object({shape:z.literal('ellipse'),width:finite.positive(),height:finite.positive()}).strict(),
  z.object({shape:z.literal('oblong'),width:finite.positive(),height:finite.positive()}).strict(),
  z.object({shape:z.literal('regular_polygon'),diameter:finite.positive(),sides:z.number().int().min(3).max(128)}).strict(),
]);
const holeSchema=z.union([z.object({shape:z.literal('round'),diameter:finite.positive()}).strict(),z.object({shape:z.literal('slot'),diameter:finite.positive(),length:finite.positive()}).strict()]).nullable();
const padPatch=z.object({x:finite.optional(),y:finite.optional(),rotation:finite.optional(),shape:padShape.optional(),hole:holeSchema.optional(),layer:z.enum(['top','bottom','multi']).optional(),net:z.string().optional(),number:z.string().optional(),plated:z.boolean().optional()}).strict();
const copperPatch=z.object({polygon:sourceSchema.optional(),net:z.string().optional(),layer:layerSchema.optional(),preserveIslands:z.boolean().optional(),priority:z.number().int().nonnegative().optional(),name:z.string().optional()}).strict();

async function beforeEdit(tx:Transaction,a:any){
  const state=await readPrimitives(tx);
  if(state.revision!==a.revision)throw new Error('STALE_REVISION: read pcb_get_edit_context again');
  return state;
}
function selected(state:any,kind:PrimitiveKind,id:string){
  const matches=state.items.filter((v:any)=>v.kind===kind&&v.id===id);
  if(matches.length!==1)throw new Error(`Missing/ambiguous ${kind}:${id}`);
  if(matches[0].properties.PrimitiveLock)throw new Error(`LOCKED_PRIMITIVE:${id}`);
  if(!state.capabilities[kind]?.modify)throw new Error(`CAPABILITY_MISSING:${kind}.modify`);
  return matches[0];
}
function nativePad(patch:any,unit:'mm'|'mil'){
  const n=(v:number)=>toMm(v,unit)/0.0254;
  const p:Record<string,any>={};
  for(const key of ['x','y'])if(patch[key]!==undefined)p[key]=n(patch[key]);
  if(patch.rotation!==undefined)p.rotation=patch.rotation;
  if(patch.layer!==undefined)p.layer=layers[patch.layer as keyof typeof layers];
  if(patch.net!==undefined)p.net=patch.net;
  if(patch.number!==undefined)p.padNumber=patch.number;
  if(patch.plated!==undefined)p.metallization=patch.plated;
  if(patch.shape){const s=patch.shape;
    if(s.shape==='rectangle'){
      if(s.cornerRadius>Math.min(s.width,s.height)/2)throw new Error('Corner radius exceeds pad dimensions');
      p.pad=['RECT',n(s.width),n(s.height),n(s.cornerRadius)];
    }else if(s.shape==='regular_polygon')p.pad=['NGON',n(s.diameter),s.sides];
    else p.pad=[s.shape==='ellipse'?'ELLIPSE':'OVAL',n(s.width),n(s.height)];
  }
  if(patch.hole!==undefined){const h=patch.hole;
    if(h?.shape==='slot'&&h.length<h.diameter)throw new Error('Slot length must be >= diameter');
    p.hole=h===null?null:h.shape==='round'?['ROUND',n(h.diameter)]:['SLOT',n(h.diameter),n(h.length)];
  }
  return p;
}
function nativeCopper(patch:any,unit:'mm'|'mil',kind:'fill'|'pour'){
  const p:Record<string,any>={};
  if(patch.polygon){polygonIslands(patch.polygon);p.complexPolygon=scaleSource(patch.polygon,toMm(1,unit)/0.0254);if(typeof p.complexPolygon[0]==='number')p.complexPolygon.push('L',p.complexPolygon[0],p.complexPolygon[1]);}
  if(patch.net!==undefined)p.net=patch.net;
  if(patch.layer!==undefined)p.layer=layers[patch.layer as 'top'|'bottom'];
  if(kind==='fill'&&['preserveIslands','priority','name'].some(k=>patch[k]!==undefined))throw new Error('Pour-only properties supplied to fixed copper fill');
  if(patch.preserveIslands!==undefined)p.preserveSilos=patch.preserveIslands;
  if(patch.priority!==undefined)p.pourPriority=patch.priority;
  if(patch.name!==undefined)p.pourName=patch.name;
  return p;
}
/** Compare the properties actually requested, without silently accepting API normalization. */
export function matchesProperties(actual:any,expected:any):boolean{
  if(typeof expected==='number')return typeof actual==='number'&&Math.abs(actual-expected)<0.0005; // native mil
  if(Array.isArray(expected))return Array.isArray(actual)&&actual.length===expected.length&&expected.every((v,i)=>matchesProperties(actual[i],v));
  return actual===expected;
}
export function samePath(actual:unknown,expected:unknown,close=true){
  try{
    const remaining=sourceEdges(actual,1,close),requested=sourceEdges(expected,1,close);
    const near=(a:{x:number;y:number},b:{x:number;y:number})=>Math.hypot(a.x-b.x,a.y-b.y)<0.0005;
    if(remaining.length!==requested.length)return false;
    for(const edge of requested){const i=remaining.findIndex(other=>other.constructor===edge.constructor&&((near(edge.start,other.start)&&near(edge.end,other.end))||(near(edge.start,other.end)&&near(edge.end,other.start)))&&near(edge.middle(),other.middle()));if(i<0)return false;remaining.splice(i,1);}
    return true;
  }catch{return false;}
}
function mismatches(item:any,expected:any){
  return Object.entries(expected).filter(([k,v])=>{
    const actual=item?.properties?.[k[0].toUpperCase()+k.slice(1)];
    return k==='complexPolygon'||k==='polygon'?!samePath(actual,v,k==='complexPolygon'):!matchesProperties(actual,v);
  }).map(([k])=>k);
}
async function finish(tx:Transaction,kind:PrimitiveKind,objectId:string,expected:any,before?:any,original?:any){
  await save(tx); const after=await readPrimitives(tx);
  let item=after.items.find((v:any)=>v.kind===kind&&v.id===objectId);
  const fullExpected=original?{...Object.fromEntries(Object.entries(original.properties).filter(([k,v])=>k!=='PrimitiveId'&&v!==undefined).map(([k,v])=>[k[0].toLowerCase()+k.slice(1),v])),...expected}:expected;
  // Drill orientation/offset has no geometry when the pad explicitly has no hole.
  // EDA returns either 0 or NaN (JSON null) for these inactive fields after edits.
  const nonApplicableFields=kind==='pad'&&fullExpected.hole===null?['holeRotation','holeOffsetX','holeOffsetY']:[];
  for(const key of nonApplicableFields)delete fullExpected[key];
  // Some official modify APIs replace the primitive but return its obsolete ID.
  // Resolve only a unique new object with ALL observed unchanged fields preserved.
  let idResolution:any;
  if(!item&&before&&original&&!after.items.some((v:any)=>v.kind===kind&&v.id===original.id)){
    const candidates=after.items.filter((v:any)=>v.kind===kind&&!before.items.some((old:any)=>old.kind===kind&&old.id===v.id)&&!mismatches(v,fullExpected).length);
    idResolution={previousId:original.id,returnedId:objectId,candidateIds:candidates.map((v:any)=>v.id),idsPreserved:false};
    if(candidates.length===1){
      item=candidates[0];idResolution.actualId=item.id;
      for(const change of tx.changes)if(change.id===objectId&&change.previousId===original.id){change.id=item.id;change.returnedId=objectId;}
    }
  }
  const mismatch=item?mismatches(item,fullExpected):['missingPrimitive'];
  return {...result({revision:after.revision,primitive:item,mismatches:mismatch,idResolution,nonApplicableFields,drc:await readDrc(tx),electricalVerified:false,geometryUnit:'mil'}),status:mismatch.length?'partial' as const:'success' as const,next:kind==='pour'?['Rebuild the pour, inspect actual filled islands and DRC. A boundary is not electrical copper evidence.']:['Read current connectivity and inspect the changed region. Editing success is not circuit acceptance.']};
}
function modifyCode(kind:PrimitiveKind,objectId:string,p:any){
  return `const p=${json(p)};${p.complexPolygon?'p.complexPolygon=eda.pcb_MathPolygon.createPolygon(p.complexPolygon);if(!p.complexPolygon)throw new Error("Polygon creation failed");':''}
const v=await eda.${primitiveModules[kind]}.modify(${json(objectId)},p);const id=v?.getState_PrimitiveId();if(!id)throw new Error('Modify returned no primitive');return {id,changes:[{kind:${json(kind+'_edit')},id,previousId:${json(objectId)}}]};`;
}

export function installPcbEditing(registry:Registry,runtime:Runtime){
  const add=(name:string,description:string,schema:z.AnyZodObject,handler:(a:any)=>Promise<any>,mutates=false)=>registry.add({name,category:'pcb_editing',description,schema,handler,mutates});
  add('eda_create_test_pcb','Create a named independent, unlinked PCB in the CURRENT project for explicitly requested testing. Returns documentId; does not replace the existing PCB or activate the new page.',z.object({target:targetSchema,operationId:mutation.operationId,name:z.string().min(1).max(80)}).strict(),a=>runtime.mutate(a.target,a.operationId,a,async tx=>{
    const existing=await tx.read('return await eda.dmt_Pcb.getAllPcbsInfo();');
    if(existing.some((v:any)=>v.name===a.name))throw new Error('PCB name already exists; inspect it instead of creating another');
    const created=await tx.write(`const id=await eda.dmt_Pcb.createPcb();if(!id)throw new Error('Create PCB failed');const changes=[{kind:'test_pcb',id}];try{if(!await eda.dmt_Pcb.modifyPcbName(id,${json(a.name)}))throw new Error('Rename PCB failed');return {id,changes};}catch(e){return {status:'partial',changes,error:String(e)};}`);
    const info=await tx.read(`return await eda.dmt_Pcb.getPcbInfo(${json(created.id)});`);
    return {...result({documentId:created.id,document:info}),status:info?.uuid===created.id&&info?.name===a.name?'success':'partial'};
  }),true);
  add('pcb_get_edit_context','Read editable PCB pads, fixed copper fills, pour boundaries and ALL existing outline primitives. Includes exact native-mil source geometry, edit revision and per-kind API capabilities. 铜皮 焊盘 板框',z.object({target:targetSchema,kinds:z.array(z.enum(['pad','fill','pour','line','arc','polyline','region','poured'])).optional(),ids:z.array(id).optional()}).strict(),async a=>runtime.read(a.target,async tx=>{
    const s=await readPrimitives(tx);
    return result({...s,items:s.items.filter((v:any)=>(!a.kinds||a.kinds.includes(v.kind))&&(!a.ids||a.ids.includes(v.id))),editingSupported:true,fullElectricalVerification:false},a.target);
  }));
  add('pcb_get_pads','Find actual pad IDs, reference/pad-number endpoints, geometry and nets. 焊盘查询',z.object({target:targetSchema,reference:z.string().optional(),net:z.string().optional()}).strict(),async a=>runtime.read(a.target,async tx=>{
    const b=await readBoard(tx);return result({revision:b.revision,unit:'mm',pads:b.pads.filter(p=>(a.reference===undefined||p.component===a.reference)&&(a.net===undefined||p.net===a.net))},a.target);
  }));
  const endpoint=z.object({reference:id,pin:id}).strict();
  add('pcb_resolve_pad_pair','Resolve reference+pin endpoints to real PCB pads, shared net, layer choices and revision. Does not choose a route or via. 按位号引脚定位',z.object({target:targetSchema,from:endpoint,to:endpoint}).strict(),async a=>runtime.read(a.target,async tx=>{
    const b=await readBoard(tx);
    const resolve=(e:any)=>{const found=b.pads.filter(p=>p.component===e.reference&&p.number===e.pin);if(found.length!==1)throw new Error(`Missing/ambiguous pad ${e.reference}.${e.pin}`);return found[0];};
    const from=resolve(a.from),to=resolve(a.to);
    if(from.id===to.id||!from.net||from.net!==to.net)throw new Error('Distinct same-net pads required');
    return result({revision:b.revision,unit:'mm',net:from.net,from,to,commonLayers:from.layers.filter(l=>to.layers.includes(l)),next:['Choose explicit vertices/layers/width/vias, then pcb_check_route.']},a.target);
  }));
  add('pcb_update_pad','Edit an existing BOARD pad by actual ID; preserve unspecified fields and library binding. Component pad edits are board overrides, not footprint-library edits. Read back dimensions/net/hole. 修改焊盘',z.object({...mutation,padId:id,unit:unitSchema,patch:padPatch}).strict(),a=>runtime.mutate(a.target,a.operationId,a,async tx=>{
    const s=await beforeEdit(tx,a),item=selected(s,'pad',a.padId),p=nativePad(a.patch,a.unit);
    if(!Object.keys(p).length)throw new Error('Empty pad patch');
    if(p.pad&&item.properties.SpecialPad?.length)throw new Error('Special pad representation requires a dedicated adapter; other properties remain editable');
    // Native setState_Hole(null) unexpectedly creates a default drilled pad.
    // Do not send redundant null; removing an existing drill is not calibrated.
    if(p.hole===null){if(item.properties.Hole!==null)throw new Error('Removing an existing drill is not verified by the official API');delete p.hole;}
    const edited=await tx.write(modifyCode('pad',a.padId,p));return finish(tx,'pad',edited.id,p,s,item);
  }),true);
  add('pcb_create_pad','Create a standalone PCB pad/test point with explicit shape and optional drill. Does not create or edit a footprint library. 新建焊盘',z.object({...mutation,unit:unitSchema,x:finite,y:finite,rotation:finite.default(0),shape:padShape,hole:holeSchema.default(null),layer:z.enum(['top','bottom','multi']),net:z.string(),number:z.string(),plated:z.boolean().default(true)}).strict(),a=>runtime.mutate(a.target,a.operationId,a,async tx=>{
    const s=await beforeEdit(tx,a);if(!s.capabilities.pad.create)throw new Error('CAPABILITY_MISSING:pad.create');
    const p=nativePad(a,a.unit);
    if(p.layer===12&&!p.hole)throw new Error('Multilayer pad requires explicit drilled hole');
    const created=await tx.write(`const p=${json(p)};const v=await eda.pcb_PrimitivePad.create(p.layer,p.padNumber,p.x,p.y,p.rotation,p.pad,p.net,p.hole,0,0,0,p.metallization,0,undefined,null,null,false);const id=v?.getState_PrimitiveId();if(!id)throw new Error('Pad creation failed');return {id,changes:[{kind:'pad',id}]};`);
    return finish(tx,'pad',created.id,p);
  }),true);
  add('pcb_create_copper','Create fixed copper fill OR refillable pour boundary from a MODEL-specified polygon with lines/arcs. RF radiators normally use fixed fill. Does not auto-route or certify filled connectivity. 新建铜皮 覆铜',z.object({...mutation,kind:z.enum(['fill','pour']),unit:unitSchema,polygon:sourceSchema,net:z.string(),layer:layerSchema,preserveIslands:z.boolean().optional(),priority:z.number().int().nonnegative().optional(),name:z.string().optional()}).strict(),a=>runtime.mutate(a.target,a.operationId,a,async tx=>{
    const s=await beforeEdit(tx,a);if(!s.capabilities[a.kind].create)throw new Error(`CAPABILITY_MISSING:${a.kind}.create`);
    const p=nativeCopper(a,a.unit,a.kind);
    const created=await tx.write(`const p=${json(p)};const polygon=eda.pcb_MathPolygon.createPolygon(p.complexPolygon);if(!polygon)throw new Error('Polygon creation failed');const v=${a.kind==='fill'?"await eda.pcb_PrimitiveFill.create(p.layer,polygon,p.net,0,1,false)":"await eda.pcb_PrimitivePour.create(p.net,p.layer,polygon,'solid',p.preserveSilos??false,p.pourName??'',p.pourPriority??0,1,false)"};const id=v?.getState_PrimitiveId();if(!id)throw new Error('Copper creation failed');return {id,changes:[{kind:${json(a.kind)},id}]};`);
    return finish(tx,a.kind,created.id,p);
  }),true);
  add('pcb_update_copper','Modify explicit fixed fill or pour boundary geometry/net/layer while preserving other properties. Polygon uses mm by default, angles in degrees. 修改铜皮 覆铜',z.object({...mutation,kind:z.enum(['fill','pour']),id,unit:unitSchema,patch:copperPatch}).strict(),a=>runtime.mutate(a.target,a.operationId,a,async tx=>{
    const s=await beforeEdit(tx,a),item=selected(s,a.kind,a.id);const p=nativeCopper(a.patch,a.unit,a.kind);
    if(!Object.keys(p).length)throw new Error('Empty copper patch');
    // Native modify otherwise assigns a new priority, even for a name-only edit.
    if(a.kind==='pour'&&p.pourPriority===undefined&&Number.isFinite(item.properties.PourPriority))p.pourPriority=item.properties.PourPriority;
    const edited=await tx.write(modifyCode(a.kind,a.id,p));return finish(tx,a.kind,edited.id,p,s,item);
  }),true);
  add('pcb_rebuild_pours','Rebuild explicit pour IDs with official rebuildCopperRegion; return actual fill data. This is copper refill, NOT autorouting. Missing API or unknown fill geometry is reported. 重铺铜',z.object({...mutation,ids:z.array(id).min(1).max(50)}).strict(),a=>runtime.mutate(a.target,a.operationId,a,async tx=>{
    const s=await beforeEdit(tx,a);
    for(const id of a.ids){const p=selected(s,'pour',id);if(!p.rebuildAvailable)throw new Error(`CAPABILITY_MISSING:pour ${id}.rebuildCopperRegion`);}
    await tx.write(`const changes=[];try{for(const id of ${json(a.ids)}){const p=await eda.pcb_PrimitivePour.get(id);const filled=await p.rebuildCopperRegion();if(!filled)throw new Error('No filled copper returned:'+id);changes.push({kind:'pour_rebuilt',id});}return {changes};}catch(e){return {status:'partial',changes,error:String(e)};}`);
    await save(tx);const after=await readPrimitives(tx),fills=after.items.filter((v:any)=>v.kind==='poured'&&a.ids.includes(v.properties.PourPrimitiveId));
    const missing=a.ids.filter((id:string)=>!fills.some((v:any)=>v.properties.PourPrimitiveId===id&&v.properties.PourFills?.length));
    return {...result({revision:after.revision,fills,missing,drc:await readDrc(tx),electricalVerified:false,fillPathUnit:'uncalibrated',limitation:'Do not use uncalibrated fill paths as copper or connectivity evidence.'}),status:missing.length?'partial':'success'};
  }),true);
  add('pcb_replace_outline','Replace the existing board-outline line/arc/polyline objects listed by exact IDs with an explicit closed contour. Checks complete ID set and revision; never deletes silkscreen or fills. 编辑已有板框',z.object({...mutation,expectedIds:z.array(id),polygon:sourceSchema,unit:unitSchema}).strict(),a=>runtime.mutate(a.target,a.operationId,a,async tx=>{
    const s=await beforeEdit(tx,a),old=s.items.filter((v:any)=>v.properties.Layer===11);
    if(new Set(a.expectedIds).size!==a.expectedIds.length||json(old.map((v:any)=>v.id).sort())!==json([...a.expectedIds].sort()))throw new Error('OUTLINE_SET_CHANGED: select all existing outline IDs from edit context');
    if(old.some((v:any)=>!['line','arc','polyline'].includes(v.kind)||v.properties.PrimitiveLock))throw new Error('Unsupported or locked existing outline object');
    if(!s.capabilities.polyline.create||old.some((v:any)=>!s.capabilities[v.kind].delete))throw new Error('Outline API unavailable');
    polygonIslands(a.polygon); const source=scaleSource(a.polygon,toMm(1,a.unit)/0.0254);
    // Close explicit line/arc paths for the polyline API, which preserves open paths.
    const {sourceEdges}=await import('./polygon.js');const edges=sourceEdges(source);
    const start=edges[0].start;
    if(typeof source[0]==='number')source.push('L',start.x,start.y);
    const created=await tx.write(`const polygon=eda.pcb_MathPolygon.createPolygon(${json(source)});if(!polygon)throw new Error('Polygon creation failed');const v=await eda.pcb_PrimitivePolyline.create('',11,polygon,1,false);const id=v?.getState_PrimitiveId();if(!id)throw new Error('Outline creation failed');return {id,changes:[{kind:'outline',id}]};`);
    // Verify the new object before deleting any existing outline primitive.
    const staged=await readPrimitives(tx),added=staged.items.find((v:any)=>v.kind==='polyline'&&v.id===created.id);
    if(!added||mismatches(added,{polygon:source}).length)throw new Error('New outline readback differs; old outline retained');
    await tx.write(`const changes=[];try{for(const row of ${json(old.map((v:any)=>({id:v.id,module:primitiveModules[v.kind as PrimitiveKind]})))}){if(!await eda[row.module].delete(row.id))throw new Error('Outline deletion failed:'+row.id);changes.push({kind:'outline_deleted',id:row.id});}return {changes};}catch(e){return {status:'partial',changes,error:String(e)};}`);
    await save(tx);const after=await readPrimitives(tx),left=after.items.filter((v:any)=>v.properties.Layer===11);
    return {...result({revision:after.revision,outline:left,drc:await readDrc(tx)}),status:left.length===1&&left[0].id===created.id?'success':'partial'};
  }),true);
  add('pcb_update_outline_primitive','Edit one existing board-outline line, arc or polyline, preserving other outline/cutouts. Returns the actual ID after readback; official API may replace it. Partial contour edits require subsequent whole-outline validation. 局部修改板框',z.object({...mutation,kind:z.enum(['line','arc','polyline']),id,unit:unitSchema,patch:z.object({startX:finite.optional(),startY:finite.optional(),endX:finite.optional(),endY:finite.optional(),arcAngle:finite.optional(),polygon:sourceSchema.optional()}).strict()}).strict(),a=>runtime.mutate(a.target,a.operationId,a,async tx=>{
    const s=await beforeEdit(tx,a),item=selected(s,a.kind,a.id);
    if(item.properties.Layer!==11)throw new Error('Not a board-outline primitive');
    const keys=Object.keys(a.patch),allowed=a.kind==='polyline'?['polygon']:a.kind==='arc'?['startX','startY','endX','endY','arcAngle']:['startX','startY','endX','endY'];
    if(!keys.length||keys.some(k=>!allowed.includes(k)))throw new Error('Patch fields do not match outline primitive kind');
    const p:Record<string,any>={};for(const k of keys)p[k]=k==='polygon'?scaleSource(a.patch[k],toMm(1,a.unit)/0.0254):k==='arcAngle'?a.patch[k]:toMm(a.patch[k],a.unit)/0.0254;
    if(p.arcAngle!==undefined&&(Math.abs(p.arcAngle)<1e-8||Math.abs(p.arcAngle)>=360))throw new Error('Invalid arc angle');
    if(p.polygon)sourceEdges(p.polygon,1,false);
    const edited=await tx.write(`const p=${json(p)};${p.polygon?'p.polygon=eda.pcb_MathPolygon.createPolygon(p.polygon);if(!p.polygon)throw new Error("Polygon creation failed");':''}const v=await eda.${primitiveModules[a.kind as PrimitiveKind]}.modify(${json(a.id)},p);const id=v?.getState_PrimitiveId();if(!id)throw new Error('Outline modification failed');return {id,changes:[{kind:'outline_edit',id,previousId:${json(a.id)}}]};`);
    return finish(tx,a.kind,edited.id,p,s,item);
  }),true);
  add('pcb_delete_objects','Delete explicitly selected fixed fills, pour boundaries or standalone pads by kind+ID+revision. Refuses locked objects and component pads. 删除指定铜皮独立焊盘',z.object({...mutation,objects:z.array(z.object({kind:z.enum(['fill','pour','pad']),id}).strict()).min(1).max(50)}).strict(),a=>runtime.mutate(a.target,a.operationId,a,async tx=>{
    const s=await beforeEdit(tx,a);
    if(new Set(a.objects.map((o:any)=>`${o.kind}:${o.id}`)).size!==a.objects.length)throw new Error('Duplicate object selection');
    for(const o of a.objects){const item=selected(s,o.kind,o.id);if(!s.capabilities[o.kind].delete)throw new Error('Delete API unavailable');if(o.kind==='pad'&&item.properties.ParentComponentPrimitiveId)throw new Error('Cannot delete component pad through standalone-pad tool');}
    await tx.write(`const changes=[];try{for(const o of ${json(a.objects.map((o:any)=>({...o,module:primitiveModules[o.kind as PrimitiveKind]})))}){if(!await eda[o.module].delete(o.id))throw new Error('Delete failed:'+o.id);changes.push({kind:o.kind+'_deleted',id:o.id});}return {changes};}catch(e){return {status:'partial',changes,error:String(e)};}`);
    await save(tx);const after=await readPrimitives(tx),remaining=a.objects.filter((o:any)=>after.items.some((v:any)=>v.kind===o.kind&&v.id===o.id));
    return {...result({revision:after.revision,remaining,drc:await readDrc(tx),electricalVerified:false}),status:remaining.length?'partial':'success'};
  }),true);
  add('pcb_get_connectivity','Read conductive components, opens, shorts and unsupported geometry. Fixed fills count as copper; pour boundaries do not. 连通性 飞线',z.object({target:targetSchema,net:z.string().optional()}).strict(),a=>runtime.read(a.target,async tx=>{const b=await readBoard(tx);return result({revision:b.revision,...connectivity(b,a.net)},a.target);}));
}
