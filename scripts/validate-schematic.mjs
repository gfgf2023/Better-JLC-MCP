import { Runtime } from '../dist/runtime.js';
import { GatewayClient } from '../dist/gateway-client.js';
import { buildToolkit } from '../dist/toolkit.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const spec = JSON.parse(await readFile('examples/attiny-sensor.json', 'utf8'));
const runtime = new Runtime(new GatewayClient({ autoSpawn: false }));
const session = await runtime.inspect();
if (!process.env.EASYEDA_TEST_PROJECT_ID || session.target?.projectId !== process.env.EASYEDA_TEST_PROJECT_ID || session.target.domain !== 'schematic') throw new Error('Explicit EASYEDA_TEST_PROJECT_ID must match the active test schematic');
const registry = buildToolkit(runtime), records = [];
const call = async (name, args) => {
  const response = await registry.call(name, { target: session.target, ...args });
  records.push({ name, response });
  console.log(JSON.stringify({ name, ref: args.reference ?? args.endpoint, status: response.status, error: response.error, drc: response.data?.drc }));
  await mkdir('reports/private', { recursive: true });
  await writeFile('reports/private/schematic-e2e.json', JSON.stringify(records, null, 2));
  if (response.status !== 'success') throw new Error(`Stopped after ${name}: ${response.status}`);
  return response.data;
};
const state = await call('sch_get_state', {});
for (const component of spec.components) {
  if (!state.components.some(c => c.designator === component.reference)) await call('sch_place_component', { ...component, part: undefined, libraryUuid: spec.libraryUuid, operationId: `sample-place-${component.reference}` });
  await call('sch_restore_device_metadata', { reference: component.reference, libraryUuid: spec.libraryUuid, deviceUuid: component.deviceUuid, operationId: `sample-metadata-${component.reference}` });
}
for (const [net, pins] of Object.entries(spec.nets)) {
  for (const endpoint of pins) {
    const [reference, pin] = endpoint.split('.');
    const current = await call('sch_get_netlist', {});
    if (current.nets.some(n => n.net === net && n.pins.some(p => p.component === reference && p.pin === pin))) continue;
    await call('sch_add_net_label', { endpoint: { reference, pin }, net, operationId: `sample-label-${reference}-${pin}` });
  }
}
const expected = Object.entries(spec.nets).map(([net, endpoints]) => ({ net, pins: endpoints.map(e => { const [reference, pin] = e.split('.'); return { reference, pin }; }) }));
await call('eda_update_memory', { memory: { constraints: spec.constraints, decisions: ['AVR internal oscillator', 'Two-layer board'], unresolved: ['Manufacturing review and ground return verification'], observations: [{ api: 'sch_PrimitiveComponent.createNetPort', version: '3.2.149', reproduction: 'Place port directly at component pin', evidence: 'DRC endpoint overlap; solved by explicit wire stub', verified: true }] } });
await call('eda_screenshot', { region: { left: 0, right: 235, top: -20, bottom: -130 } });
await call('sch_verify', { expected });
