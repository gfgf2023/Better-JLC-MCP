import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Runtime, Transaction, guardCode, serialized, type Gateway } from '../src/runtime.js';
import { Registry, toMcp } from '../src/registry.js';
import { result, type Target } from '../src/model.js';
import { parseNetlist, readDrc, routeWriteCode } from '../src/eda.js';
import { buildToolkit, inspectPng } from '../src/toolkit.js';
import { PNG } from 'pngjs';
const target: Target = { windowId: 'w', projectId: 'p', documentId: 'd', domain: 'pcb' };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
class Fake implements Gateway {
  writes = 0; partial = false; timeout = false;
  async health() { return { service: 'easyeda-bridge', edaConnected: true }; }
  async listWindows() { return { windows: [{ windowId: 'w' }] }; }
  async execute(code: string) {
    if (code.includes("getProjectFile('easyeda-mcp-backup'")) return { base64: Buffer.from('backup').toString('base64') };
    if (code.includes('source:await')) return { document: { uuid: 'd' }, source: 'source after' };
    if (code.includes('getDocumentSource')) return 'source';
    if (code.includes('MUTATE')) { this.writes++; if (this.timeout) throw new Error('HTTP 500'); return this.partial ? { status: 'partial', changes: [{ kind: 'track', id: 't1' }], error: 'Second segment failed' } : { changes: [{ kind: 'track', id: 't1' }] }; }
    return true;
  }
}
test('same window requests serialize and recover after rejection', async () => { const order: number[] = []; await Promise.allSettled([serialized('queue', async () => { order.push(1); await new Promise(r => setTimeout(r, 10)); order.push(2); throw new Error('x'); }), serialized('queue', async () => { order.push(3); })]); assert.deepEqual(order, [1, 2, 3]); });
test('target mismatch blocks code before any write', async () => { let wrote = false; const eda = { dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'wrong', parentProjectUuid: 'p', documentType: 3 }) }, dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: 'p' }) }, write: () => { wrote = true; } }; await assert.rejects(new AsyncFunction('eda', guardCode(target, 'eda.write(); return true;'))(eda), /TARGET_MISMATCH/); assert.equal(wrote, false); });
test('operations are idempotent and reject changed inputs', async () => { const dir = await mkdtemp(path.join(os.tmpdir(), 'easyeda-')); try { const fake = new Fake(), runtime = new Runtime(fake, dir); const fn = async (tx: Transaction) => { await tx.write('MUTATE'); return result({ done: true }); }; const first = await runtime.mutate(target, 'op1', { x: 1 }, fn); const second = await runtime.mutate(target, 'op1', { x: 1 }, fn); assert.equal(first.status, 'success'); assert.deepEqual(second, first); assert.equal(fake.writes, 1); await assert.rejects(runtime.mutate(target, 'op1', { x: 2 }, fn), /different input/); } finally { await rm(dir, { recursive: true, force: true }); } });
test('partial writes preserve created IDs and never report success', async () => { const dir = await mkdtemp(path.join(os.tmpdir(), 'easyeda-')); try { const fake = new Fake(); fake.partial = true; const output = await new Runtime(fake, dir).mutate(target, 'partial', {}, async tx => { await tx.write('MUTATE'); return result(null); }); assert.equal(output.status, 'partial'); assert.equal(output.changes[0].id, 't1'); assert.equal(toMcp(output).isError, true); } finally { await rm(dir, { recursive: true, force: true }); } });
test('transport failure is unknown, recovery runs, retry does not mutate twice', async () => { const dir = await mkdtemp(path.join(os.tmpdir(), 'easyeda-')); try { const fake = new Fake(); fake.timeout = true; const rt = new Runtime(fake, dir); const fn = async (tx: Transaction) => { await tx.write('MUTATE'); return result(null); }; const output = await rt.mutate(target, 'timeout', {}, fn); assert.equal(output.status, 'unknown'); assert.ok(output.evidence.recoveredState.recoveryPath); await rt.mutate(target, 'timeout', {}, fn); assert.equal(fake.writes, 1); } finally { await rm(dir, { recursive: true, force: true }); } });
test('disabled autorouting and debug cannot be invoked indirectly', async () => { const fake = new Fake(), registry = buildToolkit(new Runtime(fake), new Registry(false, false)); for (const name of ['pcb_auto_route_nets', 'pcb_auto_fanout_and_route', 'pcb_route_differential_pairs', 'pcb_execute_code', 'pcb_agent', 'experimental_route_candidates', 'eda_debug_execute']) { const output = await registry.call(name, {}); assert.equal(output.status, 'failed'); } assert.equal(fake.writes, 0); });
test('schemas reject unexpected fields before handler', async () => { const fake = new Fake(), reg = buildToolkit(new Runtime(fake)); const output = await reg.call('pcb_get_state', { target, code: 'malicious' }); assert.equal(output.status, 'failed'); assert.equal(fake.writes, 0); });
test('boolean DRC is preserved without invented issues', async () => { const tx = new Transaction(target, new Fake()); const out = await readDrc(tx); assert.deepEqual(out, { passed: true, detailsAvailable: false, raw: true }); });
test('canonical netlist ignores unrelated BOM metadata', () => { const a = { components: { c1: { props: { Designator: 'R1' }, pinInfoMap: { '1': { net: 'N' } } } } }; const b = structuredClone(a) as any; b.components.c1.props.Manufacturer = 'changed'; assert.equal(parseNetlist(JSON.stringify(a)).electricalHash, parseNetlist(JSON.stringify(b)).electricalHash); assert.equal(parseNetlist(JSON.stringify(a)).nets[0].pins[0].component, 'R1'); assert.throws(() => parseNetlist('{"components":[]}'), /components object/); });
test('black, white and transparent screenshots rejected', () => { for (const gray of [0, 255]) { const png = new PNG({ width: 64, height: 64 }); for (let i = 0; i < png.data.length; i += 4) { png.data[i] = png.data[i + 1] = png.data[i + 2] = gray; png.data[i + 3] = 255; } assert.equal(inspectPng(PNG.sync.write(png)).valid, false); } });
test('route write reports a failed segment and preserves created IDs', async () => { let calls = 0; const eda = { pcb_PrimitiveLine: { create: async () => { if (++calls === 2) throw new Error('segment failure'); return { getState_PrimitiveId: () => 'first' }; } } }; const code = routeWriteCode({ net: 'N', from: { padId: 'a' }, to: { padId: 'b' }, unit: 'mm', clearance: 0.2, vias: [], segments: [{ layer: 'top', width: 0.2, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] }] }); const out = await new AsyncFunction('eda', code)(eda); assert.equal(out.status, 'partial'); assert.deepEqual(out.changes, [{ kind: 'track', id: 'first' }]); });
