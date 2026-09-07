import { Runtime } from '../dist/runtime.js';
import { buildToolkit } from '../dist/toolkit.js';
import { verifyNetContracts } from '../dist/eda.js';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
const rt = new Runtime(), reg = buildToolkit(rt);
let session = await rt.inspect();
if (session.target?.projectId !== process.env.EASYEDA_TEST_PROJECT_ID) throw new Error('Explicit test project required');
const spec = JSON.parse(await readFile('examples/attiny-sensor.json', 'utf8'));
const expected = Object.entries(spec.nets).map(([net, pins]) => ({ net, pins: pins.map(p => { const [reference, pin] = p.split('.'); return { reference, pin }; }) }));
const call = (name, args = {}) => reg.call(name, { target: session.target, ...args });
const open = async (documentId, domain) => { const r = await call('eda_open_document', { documentId, domain }); if (r.status !== 'success') throw new Error(JSON.stringify(r)); session = await rt.inspect(); };
await mkdir('reports/evidence', { recursive: true });
const boardInfo = session.boards[0];
await open(boardInfo.schematic.page[0].uuid, 'schematic');
const schematic = await call('sch_verify', { expected });
if (!schematic.data?.netlist) throw new Error(JSON.stringify(schematic));
const schImage = await call('eda_screenshot', { region: { left: -12, right: 245, top: -18, bottom: -134 } });
if (schImage.status !== 'success') throw new Error(JSON.stringify(schImage));
await copyFile(schImage.data.file, 'reports/evidence/schematic.png');
await writeFile('reports/evidence/netlist.json', JSON.stringify({ componentCount: schematic.data.netlist.componentCount, nets: schematic.data.netlist.nets }, null, 2));
await open(boardInfo.pcb.uuid, 'pcb');
const pcbState = await call('pcb_get_state');
if (pcbState.status !== 'success') throw new Error(JSON.stringify(pcbState));
const b = pcbState.data;
const pcbNets = [...new Set(b.pads.map(p => p.net))].map(net => ({ net, pins: b.pads.filter(p => p.net === net).map(p => ({ component: p.component, pin: p.number })) }));
const contracts = verifyNetContracts({ components: b.components.map(c => ({ designator: c.designator })), nets: pcbNets, empty: !b.components.length }, expected);
const health = await call('pcb_design_health_report');
const bom = await call('pcb_bom_export');
if (health.status !== 'success' || bom.status !== 'success') throw new Error('Readback/export failed');
await writeFile('reports/evidence/bom.csv', bom.data.csv);
const pcbImage = await call('eda_screenshot', { region: { left: -2, right: 42, top: 2, bottom: -32 } });
if (pcbImage.status !== 'success') throw new Error(JSON.stringify(pcbImage));
await copyFile(pcbImage.data.file, 'reports/evidence/pcb.png');
const reopened = JSON.parse(await readFile('reports/private/reopen-pcb-verified.json', 'utf8'));
const report = {
  timestamp: new Date().toISOString(), version: '3.2.149', kind: 'real-EDA-test',
  schematic: { components: schematic.data.netlist.componentCount, nets: schematic.data.netlist.netCount, expectedPinsPassed: schematic.data.passed, missing: schematic.data.missing, unexpected: schematic.data.unexpected, drc: schematic.data.drc, screenshot: 'evidence/schematic.png' },
  pcb: { components: b.components.length, pads: b.pads.length, tracks: b.tracks.length, vias: b.vias.length, outlineVertices: b.outline.length, nets: health.data.connectivity.nets.map(n => ({ net: n.net, status: n.status, padCount: n.padCount, islands: n.islands.length })), shorts: health.data.connectivity.shorts.length, unknown: health.data.connectivity.unknown, netContracts: contracts, connectivityPassed: health.data.connectivity.passed, drc: health.data.drc, reopened: reopened.data?.unchanged === true, screenshot: 'evidence/pcb.png' },
  autorouteExecutions: 0,
  comparison: 'not_run',
  acceptance: 'partial',
  limitations: ['Schematic API returns one warning category without detail; user reports no visible errors.', 'Official importChanges required user confirmation before components appeared.', 'createProject failed in local mode; used user-authorized existing empty project.', 'Ground return quality and manufacturing suitability have not been accepted.', 'No three-arm repeated model comparison has been run.'],
};
await writeFile('reports/live-design.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
