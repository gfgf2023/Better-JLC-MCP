import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDrc, readSchematic, libraryProperties, parseNetlist, verifyNetContracts } from '../src/eda.js';
import { Transaction, type Gateway } from '../src/runtime.js';
const target = { windowId: 'w', projectId: 'p', documentId: 'd', domain: 'schematic' as const };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
test('DRC aggregate counts are not individual issue details', async () => {
  const tx = new Transaction(target, { execute: async () => [{ type: 'warn', count: 1 }] } as unknown as Gateway);
  const report = await readDrc(tx);
  assert.equal(report.passed, false);
  assert.equal(report.detailsAvailable, false);
  assert.equal('issues' in report, false);
});
test('library Value and supplier metadata are retained without copying bindings', () => {
  const properties = libraryProperties({ name: 'part', property: { supplierId: 'C15849', otherProperty: { Value: '1uF', Name: '={Value}', Footprint: 'source-binding', '3D Model': 'model' } } }, 'C2');
  assert.equal(properties.name, '={Value}');
  assert.equal(properties.otherProperty.Value, '1uF');
  assert.equal(properties.supplierId, 'C15849');
  assert.equal('Footprint' in properties.otherProperty, false);
  assert.equal('3D Model' in properties.otherProperty, false);
});
test('netlist exports actual value instead of a display expression', () => {
  const output = parseNetlist(JSON.stringify({ components: { a: { props: { Designator: 'C2', Name: '={Value}', Value: '1uF' }, pinInfoMap: {} }, b: { props: { Designator: 'U1', Name: '={Manufacturer Part}', 'Manufacturer Part': 'ATtiny85' }, pinInfoMap: {} } } }));
  assert.deepEqual(output.components.map(c => c.value), ['1uF', 'ATtiny85']);
});
test('schematic reader uses rotated world pin positions exactly once', async () => {
  const state = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [`getState_${k}`, () => v]));
  const eda = {
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'd', parentProjectUuid: 'p', documentType: 1 }) },
    dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: 'p' }) },
    sch_PrimitiveComponent: { getAll: async () => [state({ PrimitiveId: 'c', Designator: 'U1', X: 100, Y: 100, Rotation: 90 })], getAllPinsByPrimitiveId: async () => [state({ PrimitiveId: 'pin', PinNumber: '1', X: 100, Y: 120, Rotation: 270 })] },
    sch_PrimitiveWire: { getAll: async () => [] },
  };
  const tx = new Transaction(target, { execute: (code: string) => new AsyncFunction('eda', code)(eda) } as Gateway);
  const output = await readSchematic(tx);
  assert.deepEqual([output.components[0].pins[0].x, output.components[0].pins[0].y], [25.4, 30.48]);
  assert.equal(output.components[0].pins[0].rotation, 270);
});
test('expected nets reject extra shorted pins and duplicate references', () => {
  const actual = parseNetlist(JSON.stringify({ components: {
    a: { props: { Designator: 'R1' }, pinInfoMap: { 1: { net: 'N' }, 2: { net: 'N' } } },
    b: { props: { Designator: 'R1' }, pinInfoMap: {} },
  } }));
  const report = verifyNetContracts(actual, [{ net: 'N', pins: [{ reference: 'R1', pin: '1' }] }]);
  assert.equal(report.passed, false);
  assert.deepEqual(report.missing, []);
  assert.equal(report.unexpected[0].pin, '2');
  assert.deepEqual(report.duplicateReferences, ['R1']);
});
