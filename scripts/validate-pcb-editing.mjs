// Explicitly authorized live write test. Input file supplies target + unique prefix.
// Creates an independent test PCB; never edits copper in the input PCB.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { Runtime } from '../dist/runtime.js';
import { GatewayClient } from '../dist/gateway-client.js';
import { buildToolkit } from '../dist/toolkit.js';
import { hash } from '../dist/model.js';

const input=JSON.parse(await readFile(process.argv[2],'utf8'));
if(!/^[a-zA-Z0-9_-]{1,70}$/.test(input.operationPrefix))throw Error('Unique operationPrefix required');
const runtime=new Runtime(new GatewayClient({autoSpawn:false}));
const registry=buildToolkit(runtime), original=input.target;
const report={date:new Date().toISOString(),steps:[],originalDocumentUnchanged:false};
const contentHash=source=>hash(source.split('\n').map(line=>{
  const [head,body]=line.split('||');
  if(head==='{"type":"DOCHEAD"}'&&body){const end=body.lastIndexOf('}')+1;const metadata=JSON.parse(body.slice(0,end));delete metadata.client;delete metadata.updateTime;delete metadata.version;return head+'||'+JSON.stringify(metadata)+body.slice(end);}
  return line;
}).join('\n'));
let target=original;
let seq=0;
const call=async(name,args={})=>{
  const output=await registry.call(name,{target,...args});
  report.steps.push({name,...output});
  console.log(JSON.stringify({name,status:output.status,error:output.error,data:name==='pcb_rebuild_pours'?{electricalVerified:output.data?.electricalVerified}:undefined}));
  await mkdir('reports/private',{recursive:true});
  await writeFile(`reports/private/${input.operationPrefix}.json`,JSON.stringify(report,null,2));
  if(output.status!=='success')throw Error(`${name}: ${output.status}`);
  return output;
};
const op=()=>`${input.operationPrefix}-${++seq}`;
const revision=async()=>(await call('pcb_get_edit_context')).data.revision;
const originalHash=await runtime.read(original,async tx=>contentHash(await tx.read('return await eda.sys_FileManager.getDocumentSource();')));
try{
  const testDocumentId=input.testDocumentId??(await call('eda_create_test_pcb',{operationId:op(),name:`MCP-Editing-${input.operationPrefix}`})).data.documentId;
  report.testDocumentId=testDocumentId;
  const opened=await call('eda_open_document',{documentId:testDocumentId,domain:'pcb'});target=opened.data.target;
  const empty=await call('pcb_get_edit_context');
  const expectedInitial=input.expectedInitialOutlineIds??[],resumePad=input.resumePadId;
  if(empty.data.items.length!==expectedInitial.length+(resumePad?1:0)||empty.data.items.some(v=>v.id===resumePad?v.kind!=='pad':!expectedInitial.includes(v.id)||v.properties.Layer!==11))throw Error('Test PCB is not empty or its reconciled selection differs');
  const outline=await call('pcb_replace_outline',{operationId:op(),revision:await revision(),expectedIds:expectedInitial,polygon:[0,0,'L',30,0,30,20,0,20],unit:'mm'});
  let outlineId=outline.data.outline[0].id;
  const padId=resumePad??(await call('pcb_create_pad',{operationId:op(),revision:await revision(),unit:'mm',x:5,y:5,shape:{shape:'rectangle',width:2.54,height:2.54},hole:null,layer:'top',net:'TEST',number:'1'})).data.primitive.id;
  await call('pcb_update_pad',{operationId:op(),revision:await revision(),padId,unit:'mm',patch:{x:6,shape:{shape:'rectangle',width:2.54,height:2.54,cornerRadius:0}}});
  const fill=await call('pcb_create_copper',{operationId:op(),revision:await revision(),kind:'fill',unit:'mm',net:'TEST',layer:'top',polygon:[4,4,'L',8,4,8,6,4,6]});
  const fillId=fill.data.primitive.id;
  await call('pcb_update_copper',{operationId:op(),revision:await revision(),kind:'fill',id:fillId,unit:'mm',patch:{polygon:[4,4,'L',9,4,9,6,4,6]}});
  const pour=await call('pcb_create_copper',{operationId:op(),revision:await revision(),kind:'pour',unit:'mm',net:'TEST',layer:'top',polygon:[1,1,'L',29,1,29,19,1,19]});
  await call('pcb_update_copper',{operationId:op(),revision:await revision(),kind:'pour',id:pour.data.primitive.id,patch:{name:'Isolated editing validation'}});
  await call('pcb_rebuild_pours',{operationId:op(),revision:await revision(),ids:[pour.data.primitive.id]});
  const changedOutline=await call('pcb_update_outline_primitive',{operationId:op(),revision:await revision(),kind:'polyline',id:outlineId,unit:'mm',patch:{polygon:[0,0,'L',31,0,31,20,0,20,0,0]}});outlineId=changedOutline.data.primitive.id;
  await call('pcb_replace_outline',{operationId:op(),revision:await revision(),expectedIds:[outlineId],unit:'mm',polygon:[0,0,'L',30,0,30,20,0,20]});
  await call('pcb_delete_objects',{operationId:op(),revision:await revision(),objects:[{kind:'fill',id:fillId}]});
  await call('eda_reopen_and_verify',{operationId:op()});
  await call('eda_screenshot');
}finally{
  if(target.documentId!==original.documentId){const back=await registry.call('eda_open_document',{target,documentId:original.documentId,domain:'pcb'});if(back.status!=='success')throw Error('Could not return to original PCB');}
  const afterHash=await runtime.read(original,async tx=>contentHash(await tx.read('return await eda.sys_FileManager.getDocumentSource();')));
  report.originalDocumentUnchanged=afterHash===originalHash;
  report.originalComparison='Document source excluding only generated DOCHEAD client/updateTime/version';
  await mkdir('reports/private',{recursive:true});await writeFile(`reports/private/${input.operationPrefix}.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({originalDocumentUnchanged:report.originalDocumentUnchanged,testDocumentId:report.testDocumentId}));
}
