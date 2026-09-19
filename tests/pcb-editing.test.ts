import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Runtime, type Gateway } from '../src/runtime.js';
import { buildToolkit } from '../src/toolkit.js';
import { primitiveModules, comparePrimitiveSnapshots } from '../src/pcb-primitives.js';
import { point } from '@flatten-js/core';
import { sourceEdges, scaleSource, polygonIslands, joinOutline } from '../src/polygon.js';
import { checkRoute, connectivity } from '../src/geometry.js';
import type { Board, Route } from '../src/model.js';
const target={windowId:'w',projectId:'p',documentId:'d',domain:'pcb' as const};
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;

class Editor implements Gateway{
  rows:Record<string,any[]>={}; calls:string[]=[];failDelete=false;silentModify=false;replaceCopies=0;replaceWrongLayer=false;clearHoleRotation=false;next=1;
  eda:any={};
  constructor(){
    for(const [kind,module]of Object.entries(primitiveModules)){
      this.rows[kind]=[];
      const wrap=(row:any)=>new Proxy({}, {get:(_,prop)=>{
        if(String(prop).startsWith('getState_'))return ()=>row[String(prop).slice(9)];
        if(prop==='rebuildCopperRegion'&&kind==='pour')return async()=>{this.calls.push('rebuild');this.rows.poured=[{PrimitiveId:row.PrimitiveId,PourPrimitiveId:row.PrimitiveId,PourFills:[{id:'f',fill:true,lineWidth:0,path:{getSource:()=>[0,0,'L',1,0,1,1]}}]}];return wrap(this.rows.poured[0]);};
      }});
      this.eda[module]={getAll:async()=>this.rows[kind].map(wrap),get:async(id:string)=>{const row=this.rows[kind].find(v=>v.PrimitiveId===id);return row?wrap(row):undefined;},modify:async(id:string,p:any)=>{
        this.calls.push(`modify:${id}`);const row=this.rows[kind].find(v=>v.PrimitiveId===id);if(!row)return;
        if(kind==='pour'&&p.pourPriority===undefined&&row.PourPriority!==undefined)row.PourPriority++;
        if(!this.silentModify)for(const [key,v]of Object.entries(p))row[key[0].toUpperCase()+key.slice(1)]=v;
        if(this.clearHoleRotation)row.HoleRotation=null;
        if(this.replaceCopies){this.rows[kind]=this.rows[kind].filter(v=>v!==row);for(let i=0;i<this.replaceCopies;i++)this.rows[kind].push({...row,PrimitiveId:`replacement${i}`,...(this.replaceWrongLayer?{Layer:3}:{})});}
        return wrap(row);
      },delete:async(id:string)=>{this.calls.push(`delete:${id}`);if(this.failDelete)return false;this.rows[kind]=this.rows[kind].filter(v=>v.PrimitiveId!==id);return true;},create:async(...args:any[])=>{
        this.calls.push(`create:${kind}`);const row:any={PrimitiveId:`new${this.next++}`,PrimitiveLock:false};
        const fields=kind==='pad'?['Layer','PadNumber','X','Y','Rotation','Pad','Net','Hole','HoleOffsetX','HoleOffsetY','HoleRotation','Metallization']:kind==='fill'?['Layer','ComplexPolygon','Net','FillMode','LineWidth']:kind==='polyline'?['Net','Layer','Polygon','LineWidth']:['Net','Layer','ComplexPolygon','PourFillMethod','PreserveSilos','PourName','PourPriority','LineWidth'];
        fields.forEach((k,i)=>row[k]=args[i]);this.rows[kind].push(row);return wrap(row);
      }};
    }
    this.eda.pcb_MathPolygon={createPolygon:(source:any)=>({getSource:()=>source})};
    this.eda.dmt_SelectControl={getCurrentDocumentInfo:async()=>({uuid:'d',parentProjectUuid:'p',documentType:3})};
    this.eda.dmt_Project={getCurrentProjectInfo:async()=>({uuid:'p'})};
    this.eda.sys_FileManager={getDocumentSource:async()=>JSON.stringify(this.rows),getProjectFile:async()=>new Blob(['test-backup'])};
    this.eda.pcb_Document={save:async()=>true};this.eda.pcb_Drc={check:async()=>[]};
  }
  async execute(code:string){return new AsyncFunction('eda',code)(this.eda);}
  async health(){return {service:'easyeda-bridge',edaConnected:true};}
  async listWindows(){return {windows:[{windowId:'w'}]};}
}
async function fixture(fn:(e:Editor,call:(name:string,args:any)=>Promise<any>,revision:()=>Promise<string>)=>Promise<void>){
  const dir=await mkdtemp(path.join(os.tmpdir(),'pcb-edit-'));try{const e=new Editor(),r=buildToolkit(new Runtime(e,dir));const call=(name:string,args:any)=>r.call(name,{target,...args});const revision=async()=>(await call('pcb_get_edit_context',{})).data.revision;await fn(e,call,revision);}finally{await rm(dir,{recursive:true,force:true});}
}

test('existing component pad edit preserves net, drill, and unspecified geometry; repeated operation does not write twice',()=>fixture(async(e,call,revision)=>{
  e.rows.pad.push({PrimitiveId:'cp1',ParentComponentPrimitiveId:'c',Layer:12,PadNumber:'1',X:100,Y:200,Rotation:0,Pad:['RECT',50,60,0],Net:'RF',Hole:['ROUND',20],Metallization:true});
  const args={operationId:'edit',revision:await revision(),padId:'cp1',patch:{x:5.08}};
  const out=await call('pcb_update_pad',args);assert.equal(out.status,'success',JSON.stringify(out));assert.equal(e.rows.pad[0].X,200);assert.equal(e.rows.pad[0].Net,'RF');assert.deepEqual(e.rows.pad[0].Hole,['ROUND',20]);
  await call('pcb_update_pad',args);assert.equal(e.calls.length,1);
}));
test('stale revision, locked objects, wrong target and invalid pad dimensions produce no edit',()=>fixture(async(e,call,revision)=>{
  e.rows.pad.push({PrimitiveId:'p',PrimitiveLock:true});
  const rev=await revision();
  for(const extra of [{revision:'stale',patch:{x:1}},{revision:rev,patch:{x:1}},{revision:rev,target:{...target,documentId:'other'},patch:{x:1}},{revision:rev,patch:{shape:{shape:'rectangle',width:-1,height:2}}}]){
    const out=await call('pcb_update_pad',{operationId:`bad${Math.random()}`.replace('.',''),padId:'p',...extra});assert.notEqual(out.status,'success');
  }
  assert.equal(e.calls.length,0);
}));
test('silent API normalization/refusal becomes partial instead of success',()=>fixture(async(e,call,revision)=>{
  e.rows.pad.push({PrimitiveId:'p',X:0});e.silentModify=true;
  const out=await call('pcb_update_pad',{operationId:'edit',revision:await revision(),padId:'p',patch:{x:2}});
  assert.equal(out.status,'partial');assert.deepEqual(out.data.mismatches,['x']);
}));

test('inactive hole rotation is explicit evidence for undrilled pads; drilled geometry drift fails',()=>fixture(async(e,call,revision)=>{
  e.clearHoleRotation=true;
  e.rows.pad.push({PrimitiveId:'smd',Hole:null,HoleRotation:0,X:0},{PrimitiveId:'pth',Hole:['SLOT',20,40],HoleRotation:30,X:0});
  const smd=await call('pcb_update_pad',{operationId:'smd-edit',revision:await revision(),padId:'smd',patch:{x:1}});
  assert.equal(smd.status,'success');assert.ok(smd.data.nonApplicableFields.includes('holeRotation'));
  const pth=await call('pcb_update_pad',{operationId:'pth-edit',revision:await revision(),padId:'pth',patch:{x:1}});
  assert.equal(pth.status,'partial');assert.ok(pth.data.mismatches.includes('holeRotation'));
  const calls=e.calls.length;
  assert.equal((await call('pcb_update_pad',{operationId:'remove-drill',revision:await revision(),padId:'pth',patch:{hole:null}})).status,'failed');
  assert.equal(e.calls.length,calls);
}));
test('fixed copper uses Fill API and retains arc angles across mm-to-mil conversion',()=>fixture(async(e,call,revision)=>{
  const polygon:any=[0,0,'L',10,0,'ARC',90,12,2,'L',12,10,0,10];
  const out=await call('pcb_create_copper',{operationId:'fill',revision:await revision(),kind:'fill',net:'RF',layer:'top',polygon});
  assert.equal(out.status,'success',JSON.stringify(out));assert.deepEqual(e.calls,['create:fill']);
  const source=e.rows.fill[0].ComplexPolygon.getSource();assert.equal(source[6],90);assert.ok(Math.abs(source[3]-10/0.0254)<1e-6);
  assert.deepEqual(source.slice(-3),['L',0,0]);
}));
test('pour refill returns fill evidence without claiming electrical verification',()=>fixture(async(e,call,revision)=>{
  e.rows.pour.push({PrimitiveId:'pour',Layer:1,Net:'GND'});
  const out=await call('pcb_rebuild_pours',{operationId:'refill',revision:await revision(),ids:['pour']});
  assert.equal(out.status,'success',JSON.stringify(out));assert.equal(out.data.electricalVerified,false);assert.equal(out.data.fillPathUnit,'uncalibrated');
}));

test('pour patch explicitly preserves the observed priority',()=>fixture(async(e,call,revision)=>{
  e.rows.pour.push({PrimitiveId:'pour',Layer:1,PourPriority:3,PourName:'old'});
  const out=await call('pcb_update_copper',{operationId:'rename',revision:await revision(),kind:'pour',id:'pour',patch:{name:'new'}});
  assert.equal(out.status,'success');assert.equal(e.rows.pour[0].PourPriority,3);
}));
test('outline replacement requires complete observed set and preserves unrelated graphics',()=>fixture(async(e,call,revision)=>{
  e.rows.polyline.push({PrimitiveId:'old',Layer:11,Polygon:{getSource:()=>[0,0,'L',1,0,1,1,0,0]}});
  e.rows.line.push({PrimitiveId:'silk',Layer:3,StartX:0,StartY:0,EndX:1,EndY:1});
  const a={revision:await revision(),polygon:[0,0,'L',10,0,10,10,0,10]};
  assert.notEqual((await call('pcb_replace_outline',{...a,operationId:'bad',expectedIds:[]})).status,'success');assert.equal(e.calls.length,0);
  const out=await call('pcb_replace_outline',{...a,operationId:'ok',expectedIds:['old']});assert.equal(out.status,'success',JSON.stringify(out));
  assert.deepEqual(e.calls,['create:polyline','delete:old']);assert.equal(e.rows.line[0].PrimitiveId,'silk');
}));
test('failed outline deletion reports partial with recoverable created ID',()=>fixture(async(e,call,revision)=>{
  e.rows.polyline.push({PrimitiveId:'old',Layer:11});e.failDelete=true;
  const out=await call('pcb_replace_outline',{operationId:'partial',revision:await revision(),expectedIds:['old'],polygon:[0,0,'L',10,0,10,10,0,10]});
  assert.equal(out.status,'partial');assert.ok(out.changes.some((c:any)=>c.kind==='outline'));assert.equal(e.rows.polyline.length,2);
}));
test('standalone round and slotted pads retain explicit dimensions and mil units',()=>fixture(async(e,call,revision)=>{
  const out=await call('pcb_create_pad',{operationId:'pad',revision:await revision(),unit:'mil',x:100,y:200,shape:{shape:'oblong',width:80,height:100},hole:{shape:'slot',diameter:30,length:50},layer:'multi',net:'GND',number:'TP1'});
  assert.equal(out.status,'success',JSON.stringify(out));assert.equal(e.rows.pad[0].X,100);assert.deepEqual(e.rows.pad[0].Hole,['SLOT',30,50]);
}));

test('outline modify reconciles stale returned ID using unique new geometry and preserved properties',()=>fixture(async(e,call,revision)=>{
  e.rows.polyline.push({PrimitiveId:'old',Layer:11,Net:'',LineWidth:1,Polygon:{getSource:()=>[0,0,'L',1,0]}});e.replaceCopies=1;
  const out=await call('pcb_update_outline_primitive',{operationId:'replace-id',revision:await revision(),kind:'polyline',id:'old',unit:'mil',patch:{polygon:[0,0,'L',2,0]}});
  assert.equal(out.status,'success',JSON.stringify(out));assert.equal(out.data.primitive.id,'replacement0');assert.equal(out.changes[0].id,'replacement0');assert.equal(out.changes[0].previousId,'old');assert.equal(out.data.idResolution.idsPreserved,false);
}));

for(const scenario of ['ambiguous','wrong-layer','existing-only'])test(`stale modify ID cannot resolve ${scenario} geometry`,()=>fixture(async(e,call,revision)=>{
  e.rows.polyline.push({PrimitiveId:'old',Layer:11,Polygon:{getSource:()=>[0,0,'L',1,0]}});
  if(scenario==='existing-only')e.rows.polyline.push({PrimitiveId:'replacement0',Layer:11,Polygon:{getSource:()=>[0,0,'L',2,0]}});
  e.replaceCopies=scenario==='ambiguous'?2:1;e.replaceWrongLayer=scenario==='wrong-layer';
  const out=await call('pcb_update_outline_primitive',{operationId:'replace-id',revision:await revision(),kind:'polyline',id:'old',unit:'mil',patch:{polygon:[0,0,'L',2,0]}});
  assert.equal(out.status,'partial');assert.deepEqual(out.data.mismatches,['missingPrimitive']);
}));

test('delete only explicit standalone objects; component pads and locks are refused',()=>fixture(async(e,call,revision)=>{
  e.rows.pad.push({PrimitiveId:'component-pad',ParentComponentPrimitiveId:'U1'},{PrimitiveId:'free-pad'});e.rows.fill.push({PrimitiveId:'locked',PrimitiveLock:true},{PrimitiveId:'free-fill'});
  for(const [kind,id] of [['pad','component-pad'],['fill','locked']])assert.equal((await call('pcb_delete_objects',{operationId:id,revision:await revision(),objects:[{kind,id}]})).status,'failed');
  assert.equal(e.calls.length,0);
  const out=await call('pcb_delete_objects',{operationId:'delete',revision:await revision(),objects:[{kind:'pad',id:'free-pad'},{kind:'fill',id:'free-fill'}]});
  assert.equal(out.status,'success');assert.deepEqual(e.calls,['delete:free-pad','delete:free-fill']);assert.equal(e.rows.pad[0].PrimitiveId,'component-pad');
}));
test('polygon parser handles closed arcs, rotation, holes and rejects malformed/self-intersecting input',()=>{
  const source:any=[0,0,'L',10,0,'ARC',90,12,2,'L',12,10,0,10];
  const edges=sourceEdges(source);assert.ok(Math.abs(edges[1].length-Math.PI)<1e-8);
  assert.equal(scaleSource(source,2)[6],90);
  assert.equal(polygonIslands(['R',0,10,10,10,0,0])[0].contains(point(5,5)),true);
  assert.throws(()=>sourceEdges([0,0,'ARC',90,1]),/number/);
  assert.throws(()=>polygonIslands([0,0,'L',10,10,0,10,10,0]));
  const rings=polygonIslands([[0,0,'L',10,0,10,10,0,10],[3,3,'L',7,3,7,7,3,7],[20,0,'L',22,0,22,2,20,2]]);
  assert.equal(rings.length,2);assert.equal(rings[0].contains(point(5,5)),false);
});

test('save/reopen comparison catches pour edits even when routing geometry is unknown',()=>{
  const before={unavailable:[],items:[{kind:'pour',id:'p',properties:{Layer:1,ComplexPolygon:[0,0,'L',10,0,10,10,0,0]}}]};
  const after=structuredClone(before);after.items[0].properties.ComplexPolygon[3]=11;
  assert.equal(comparePrimitiveSnapshots(before,after).unchanged,false);
  assert.equal(comparePrimitiveSnapshots(before,structuredClone(before)).unchanged,true);
  after.items=[];assert.equal(comparePrimitiveSnapshots(before,after).unchanged,false);
});

test('reopen ignores drill-only metadata only when both pads have no hole',()=>{
  const snapshot=(hole:any,rotation:any)=>({unavailable:[],items:[{kind:'pad',id:'p',properties:{Hole:hole,HoleRotation:rotation}}]});
  assert.equal(comparePrimitiveSnapshots(snapshot(null,0),snapshot(null,null)).unchanged,true);
  assert.equal(comparePrimitiveSnapshots(snapshot(['ROUND',30],0),snapshot(['ROUND',30],null)).unchanged,false);
  assert.equal(comparePrimitiveSnapshots(snapshot(null,0),snapshot(['ROUND',30],0)).unchanged,false);
});
test('mixed reversed outline arcs join without closing each individual polyline',()=>{
  const poly=joinOutline([[0,0,'L',10,0],[12,2,'ARC',-90,10,0],[12,2,'L',12,10,0,10,0,0]]);
  assert.equal(poly.contains(point(6,5)),true);assert.throws(()=>joinOutline([[0,0,'L',10,0]]),/Open/);
});
test('fixed fill participates in collision and connectivity, holes and separate islands do not connect pads',()=>{
  const b:Board={unit:'mm',revision:'r',components:[],pads:[2,18].map((x,i)=>({id:String(i),number:String(i),x,y:5,net:'N',layers:['top'],shape:'circle',width:1,height:1,rotation:0})),tracks:[],vias:[],outline:[{x:0,y:0},{x:20,y:0},{x:20,y:20},{x:0,y:20}],keepouts:[],unknown:[],copper:[{id:'c',net:'N',layer:'top',source:[1,4,'L',19,4,19,6,1,6]}]};
  assert.equal(connectivity(b).passed,true);
  b.copper![0].source=[[1,4,'L',3,4,3,6,1,6],[17,4,'L',19,4,19,6,17,6]];assert.equal(connectivity(b).passed,false);
  b.copper=[{id:'foreign',net:'GND',layer:'top',source:[9,4,'L',11,4,11,6,9,6]}];
  const r:Route={net:'N',from:{padId:'0'},to:{padId:'1'},unit:'mm',clearance:0.2,vias:[],segments:[{layer:'top',width:0.2,points:[{x:2,y:5},{x:18,y:5}]}]};
  assert.equal(checkRoute(b,r).passed,false);
});
