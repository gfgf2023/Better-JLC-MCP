import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBoard, compareBoardSnapshots } from '../src/eda.js';
import { Runtime, Transaction, type Gateway } from '../src/runtime.js';
import { buildToolkit } from '../src/toolkit.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hash } from '../src/model.js';
const target = { windowId: 'w', projectId: 'p', documentId: 'd', domain: 'pcb' as const };
test('real adapter recognizes empty special shape and composite pad IDs', async () => {
  const raw = { components: [{ PrimitiveId: 'c', Designator: 'R1', X: 0, Y: 0, Pads: [{ primitiveId: 'e1' }] }], pads: [{ PrimitiveId: 'ce1', Net: 'N', PadNumber: '1', X: 0, Y: 0, Layer: 1, Pad: ['RECT', 40, 20, 2], SpecialPad: [] }], lines: [], vias: [], unsupported: [] };
  const board = await readBoard(new Transaction(target, { execute: async () => raw } as unknown as Gateway));
  assert.equal(board.pads[0].shape, 'rectangle');
  assert.equal(board.pads[0].component, 'R1');
  assert.equal(board.pads[0].cornerRadius, 0.0508);
  const reopened = structuredClone(board); reopened.revision = 'other'; reopened.pads[0].x += 0.000001;
  assert.equal(compareBoardSnapshots(board, reopened).unchanged, true);
  reopened.pads[0].x += 0.001;
  assert.equal(compareBoardSnapshots(board, reopened).unchanged, false);
  reopened.pads[0].x = 0; reopened.pads[0].net = 'GND';
  assert.equal(compareBoardSnapshots(board, reopened).unchanged, false);
});
test('an independently held window lock prevents any document call', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'easyeda-lock-'));
  try {
    await mkdir(path.join(dir, 'locks', hash(target.windowId)), { recursive: true });
    let calls = 0;
    const runtime = new Runtime({ execute: async () => { calls++; } } as unknown as Gateway, dir);
    await assert.rejects(runtime.read(target, tx => tx.read('return true;')), /WINDOW_BUSY/);
    assert.equal(calls, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('named labels create a real wire from the actual rotated pin, not overlapping ports', async () => {
  const writes: string[] = [];
  const fake = {
    mutate: async (_target: any, _id: any, _args: any, fn: any) => fn({
      target: { ...target, domain: 'schematic' },
      read: async (code: string) => {
        if (code.includes('schematicRead')) return { components: [{ designator: 'U1', pins: [{ number: '1', x: 10, y: 10, rotation: 90 }] }], wires: [] };
        if (code.includes('getNetlistFile')) return JSON.stringify({ components: { c: { props: { Designator: 'U1' }, pinInfoMap: { 1: { net: 'N' } } } } });
        if (code.includes('Drc.check')) return [];
        throw new Error('Unexpected read');
      },
      write: async (code: string) => { writes.push(code); return true; },
    }),
  };
  const out = await buildToolkit(fake as Runtime).call('sch_add_net_label', { target: { ...target, domain: 'schematic' }, operationId: 'label', endpoint: { reference: 'U1', pin: '1' }, net: 'N' });
  assert.equal(out.status, 'success');
  let vertices: number[] | undefined;
  const eda = { sch_PrimitiveWire: { create: async (line: number[]) => { vertices = line; return { getState_PrimitiveId: () => 'w1' }; } }, sch_PrimitiveComponent: { createNetPort: () => { throw new Error('Unexpected overlapping port'); } } };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const executed = await new AsyncFunction('eda', writes[0])(eda);
  assert.equal(executed.status, 'success');
  assert.ok(vertices);
  assert.ok(Math.abs(vertices[0] - vertices[2]) < 0.00001);
  assert.ok(Math.abs(vertices[3] - vertices[1] - 20) < 0.00001);
});
