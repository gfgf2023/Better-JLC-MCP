import { Runtime } from '../dist/runtime.js';
import { GatewayClient } from '../dist/gateway-client.js';
import { buildToolkit } from '../dist/toolkit.js';
import { routeCoverage } from '../dist/geometry.js';
import { readFile, writeFile } from 'node:fs/promises';

const plan = JSON.parse(await readFile(process.argv[2], 'utf8'));
const runtime = new Runtime(new GatewayClient({ autoSpawn: false }));
const session = await runtime.inspect();
if (!process.env.EASYEDA_TEST_PROJECT_ID || session.target?.projectId !== process.env.EASYEDA_TEST_PROJECT_ID || session.target.domain !== 'pcb') throw new Error('Explicit test project and active PCB required');
const reg = buildToolkit(runtime), records = [];
const call = async (name, args = {}) => {
  const response = await reg.call(name, { target: session.target, ...args });
  records.push({ name, response });
  await writeFile('reports/private/pcb-validation.json', JSON.stringify(records, null, 2));
  console.log(JSON.stringify({ name, status: response.status, error: response.error, evidence: response.evidence, ...(response.status !== 'success' ? { missing: response.data?.missing, coverage: response.data?.coverage } : {}) }));
  if (response.status !== 'success') throw new Error(`Stopped: ${name} ${response.status}`);
  return response.data;
};
let board = await call('pcb_get_state');
if (plan.outline && !board.outline.length) await call('pcb_create_outline', { operationId: `${plan.id}-outline`, points: plan.outline });
if (plan.moves) {
  board = await call('pcb_get_state');
  await call('pcb_move_components', { operationId: `${plan.id}-placement`, revision: board.revision, moves: plan.moves });
}
for (const [i, path] of (plan.routes ?? []).entries()) {
  board = await call('pcb_get_state');
  const endpoint = ref => {
    const [component, number] = ref.split('.');
    const found = board.pads.filter(p => p.component === component && p.number === number);
    if (found.length !== 1) throw new Error(`Missing/ambiguous ${ref}`);
    return found[0];
  };
  const from = endpoint(path.from), to = endpoint(path.to);
  const route = { net: from.net, from: { padId: from.id }, to: { padId: to.id }, unit: 'mm', clearance: path.clearance ?? 0.2, vias: path.vias ?? [], segments: path.segments.map((s, j) => ({ layer: s.layer, width: s.width, points: [...(j === 0 ? [{ x: from.x, y: from.y }] : []), ...s.points, ...(j === path.segments.length - 1 ? [{ x: to.x, y: to.y }] : [])] })) };
  if (routeCoverage(board, route).passed) { console.log(JSON.stringify({ route: i, skipped: 'Exact copper path already present on readback' })); continue; }
  const check = await call('pcb_check_route', { route });
  if (!check.passed) { console.log(JSON.stringify(check)); throw new Error('Explicit path failed precheck; no fallback'); }
  await call('pcb_apply_route', { operationId: `${plan.id}-route-${i}`, revision: check.revision, route });
}
board = await call('pcb_get_state');
await writeFile('reports/private/pcb-state.json', JSON.stringify({ data: board }, null, 2));
await call('eda_screenshot', { region: plan.region ?? { left: -2, right: 42, top: 2, bottom: -32 } });
await call('pcb_design_health_report');
