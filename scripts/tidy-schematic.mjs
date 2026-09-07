import { Runtime } from '../dist/runtime.js';
import { buildToolkit } from '../dist/toolkit.js';
import { hash } from '../dist/model.js';
import { readdir, readFile, writeFile } from 'node:fs/promises';
const rt = new Runtime(), session = await rt.inspect();
if (session.target?.domain !== 'schematic' || session.target.projectId !== process.env.EASYEDA_TEST_PROJECT_ID) throw new Error('Test schematic required');
const reg = buildToolkit(rt), target = session.target;
const call = async (name, args = {}) => { const r = await reg.call(name, { target, ...args }); if (r.status !== 'success') throw new Error(JSON.stringify(r)); return r.data; };
let state = await call('sch_get_state');
const initial = await call('sch_get_netlist');
const dir = `${rt.stateDir}/${hash(target)}`;
for (const file of await readdir(dir)) {
  if (!file.endsWith('.json')) continue;
  const record = JSON.parse(await readFile(`${dir}/${file}`, 'utf8'));
  const ids = (record.result?.changes ?? []).filter(c => c.kind === 'net_port' && state.components.some(v => v.id === c.id)).map(c => c.id);
  if (!ids.length) continue;
  await call('sch_remove_created_objects', { operationId: `tidy-${record.operationId}`, sourceOperationId: record.operationId, primitiveIds: ids });
  if ((await call('sch_get_netlist')).electricalHash !== initial.electricalHash) throw new Error('Electrical change after port removal; stopped');
}
state = await call('sch_get_state');
const attrs = await call('sch_get_attributes', { parentIds: state.wires.map(w => w.id) });
const moves = [];
for (const w of state.wires) {
  const attr = attrs.find(a => a.parentId === w.id && a.key === 'Name' && a.visible);
  if (!attr) continue;
  const coords = w.nativeLine;
  if (coords.length !== 4) continue;
  const ends = [{ x: coords[0] * 0.254, y: coords[1] * 0.254 }, { x: coords[2] * 0.254, y: coords[3] * 0.254 }];
  const pin = state.components.filter(c => c.designator).flatMap(c => c.pins).find(p => ends.some(e => Math.hypot(e.x-p.x,e.y-p.y)<0.001));
  if (!pin) continue;
  moves.push({ id: attr.id, x: (ends[0].x+ends[1].x)/2, y: (ends[0].y+ends[1].y)/2+0.508, rotation: 0, resetFont: true, alignMode: Math.cos(pin.rotation*Math.PI/180)<0 ? 'RIGHT_BOTTOM' : 'LEFT_BOTTOM' });
}
await call('sch_arrange_attributes', { operationId: 'sample-text-layout-v2', moves });
const after = await call('sch_get_netlist');
const screenshot = await call('eda_screenshot', { region: { left: -12, right: 245, top: -18, bottom: -134 } });
await writeFile('reports/private/schematic-tidy.json', JSON.stringify({ unchanged: initial.electricalHash === after.electricalHash, netlist: after, screenshot: screenshot.file }, null, 2));
console.log(JSON.stringify({ unchanged: initial.electricalHash === after.electricalHash, screenshot: screenshot.file }));
