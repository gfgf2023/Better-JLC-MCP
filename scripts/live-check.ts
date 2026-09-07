import { Runtime } from '../dist/runtime.js';
import { GatewayClient } from '../dist/gateway-client.js';
import { buildToolkit } from '../dist/toolkit.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const gateway = new GatewayClient({ autoSpawn: false });
const runtime = new Runtime(gateway);
const registry = buildToolkit(runtime);
const report: any = { timestamp: new Date().toISOString(), kind: 'live-read-only', checks: [], boardAcceptance: 'not_run' };
try {
  const session: any = await runtime.inspect(process.env.EASYEDA_WINDOW_ID);
  report.connection = { connected: !!session.target, windows: session.health.edaWindowCount };
  if (!session.target) throw new Error('No unambiguous EDA document; connect Gateway and select a document');
  const target = session.target;
  for (const name of ['eda_capabilities', target.domain === 'pcb' ? 'pcb_get_state' : 'sch_get_state', 'eda_run_drc', 'eda_screenshot']) {
    const output = await registry.call(name, { target });
    const summary: any = { tool: name, status: output.status, error: output.error };
    if (name === 'eda_capabilities') summary.capabilities = output.data;
    if (name === 'pcb_get_state') summary.geometry = { components: output.data?.components?.length, pads: output.data?.pads?.length, tracks: output.data?.tracks?.length, unsupported: output.data?.unknown };
    if (name === 'eda_run_drc') summary.drc = output.data;
    if (name === 'eda_screenshot') summary.pixels = { valid: output.evidence?.valid, width: output.evidence?.width, height: output.evidence?.height };
    report.checks.push(summary);
  }
  report.passed = report.checks.every((c: any) => c.status === 'success');
} catch (e: any) { report.passed = false; report.blocker = e.message; }
const directory = path.resolve('reports');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'live-readonly.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
