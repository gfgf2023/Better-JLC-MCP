import { Runtime } from '../dist/runtime.js';
import { GatewayClient } from '../dist/gateway-client.js';
import { buildToolkit } from '../dist/toolkit.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Explicit tool calls only; this runner does not generate placements or routes.
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const runtime = new Runtime(new GatewayClient({ autoSpawn: false }));
const session = await runtime.inspect(input.windowId);
if (!session.target) throw new Error('Select a connected document first');
if (session.project.uuid !== input.projectId) throw new Error('Runner target project mismatch');
const registry = buildToolkit(runtime);
const responses = [];
for (const step of input.steps) {
  const args = { target: session.target, ...step.arguments };
  const response = await registry.call(step.name, args);
  responses.push({ name: step.name, response });
  console.log(JSON.stringify({ name: step.name, response }));
  if (response.status !== 'success') break;
}
await mkdir(path.resolve('reports/private'), { recursive: true });
await writeFile(path.resolve(`reports/private/${path.basename(process.argv[2])}.result.json`), JSON.stringify(responses, null, 2));
if (responses.some(r => r.response.status !== 'success')) process.exitCode = 1;
