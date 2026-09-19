import { type Transaction } from './runtime.js';
import { hash } from './model.js';

export const primitiveModules = { pad:'pcb_PrimitivePad', fill:'pcb_PrimitiveFill', pour:'pcb_PrimitivePour', line:'pcb_PrimitiveLine', arc:'pcb_PrimitiveArc', polyline:'pcb_PrimitivePolyline', region:'pcb_PrimitiveRegion', poured:'pcb_PrimitivePoured' } as const;
export type PrimitiveKind = keyof typeof primitiveModules;
// Serialized into the official Gateway. Polygon classes must be converted to source arrays there.
export function primitiveReader(eda: any) {
  return (async()=>{
    const fields: Record<string,string[]> = {
      pad:['PrimitiveId','Layer','PadNumber','Pad','SpecialPad','X','Y','Rotation','Net','Hole','HoleOffsetX','HoleOffsetY','HoleRotation','Metallization','PadType','PrimitiveLock','ParentComponentPrimitiveId'],
      fill:['PrimitiveId','Layer','ComplexPolygon','Net','FillMode','LineWidth','PrimitiveLock'],
      pour:['PrimitiveId','Layer','ComplexPolygon','Net','PourFillMethod','PreserveSilos','PourName','PourPriority','LineWidth','PrimitiveLock'],
      line:['PrimitiveId','Layer','Net','StartX','StartY','EndX','EndY','LineWidth','PrimitiveLock'],
      arc:['PrimitiveId','Layer','Net','StartX','StartY','EndX','EndY','ArcAngle','LineWidth','PrimitiveLock'],
      polyline:['PrimitiveId','Layer','Net','Polygon','LineWidth','PrimitiveLock'],
      region:['PrimitiveId','Layer','ComplexPolygon','RuleType','PrimitiveLock'],
      poured:['PrimitiveId','PourPrimitiveId','PourFills'],
    };
    const names:Record<string,string>={pad:'Pad',fill:'Fill',pour:'Pour',line:'Line',arc:'Arc',polyline:'Polyline',region:'Region',poured:'Poured'};
    const items:any[]=[], capabilities:Record<string,any>={}, unavailable:string[]=[];
    for(const [kind, fs] of Object.entries(fields)){
      const api=eda['pcb_Primitive'+names[kind]];
      capabilities[kind]=Object.fromEntries(['getAll','create','modify','delete'].map(m=>[m,typeof api?.[m]==='function']));
      if(!capabilities[kind].getAll){unavailable.push(kind);continue;}
      for(const primitive of await api.getAll()){
        const properties:Record<string,any>={};
        for(const f of fs){const value=primitive['getState_'+f]?.(); properties[f]=value?.getSource?value.getSource():f==='PourFills'?value?.map((fill:any)=>({...fill,path:fill.path?.getSource?.()})):value;}
        items.push({kind,id:properties.PrimitiveId,properties,...(kind==='pour'?{rebuildAvailable:typeof primitive.rebuildCopperRegion==='function'}:{})});
      }
    }
    return {items,capabilities,unavailable};
  })();
}
export async function readPrimitives(tx:Transaction){
  if(tx.target.domain!=='pcb')throw new Error('PCB target required');
  const raw=await tx.read(`const __name=(fn)=>fn; return (${primitiveReader.toString()})(eda);`);
  return {...raw,revision:hash(raw),unit:'mil',note:'Raw primitive property coordinates are PCB native mil. Poured fill path units are not calibrated and are not used as electrical evidence.'};
}

/** Persistence evidence includes editable objects omitted by the routing model. */
export function comparePrimitiveSnapshots(before:any,after:any){
  const differences:string[]=[],nonApplicableFields:string[]=[];let maxNativeDrift=0;
  const visit=(a:any,b:any,path:string,tolerance:number)=>{
    if(Object.is(a,b))return;
    if(typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)){
      const delta=Math.abs(a-b);if(tolerance)maxNativeDrift=Math.max(maxNativeDrift,delta);if(delta>tolerance)differences.push(path);
    }else if(a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)){
      for(const k of new Set([...Object.keys(a),...Object.keys(b)]))visit(a[k],b[k],`${path}.${k}`,tolerance);
    }else differences.push(path);
  };
  const rows=(s:any)=>new Map<string,any>(s.items.map((v:any)=>{
    const row=structuredClone(v);
    if(row.kind==='pad'&&row.properties.Hole===null)for(const key of ['HoleRotation','HoleOffsetX','HoleOffsetY']){delete row.properties[key];nonApplicableFields.push(`${v.id}.${key}`);}
    return [`${v.kind}:${v.id}`,row];
  }));
  const left=rows(before),right=rows(after);
  for(const key of new Set([...left.keys(),...right.keys()]))visit(left.get(key),right.get(key),key,key.startsWith('poured:')?0:0.0005);
  visit(before.unavailable,after.unavailable,'unavailable',0);
  return {unchanged:!differences.length,differences,nativeMilTolerance:0.0005,maxNativeDrift,pouredComparison:'exact, units uncalibrated',unavailable:after.unavailable,nonApplicableFields:[...new Set(nonApplicableFields)]};
}
