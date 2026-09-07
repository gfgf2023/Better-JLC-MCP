import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRecords } from '../src/evaluation.js';
test('comparison refuses incomplete or unequal experiments and does not fabricate results', () => {
  assert.equal(evaluateRecords([]).status, 'not_run');
  const records = ['original', 'prompts_only', 'fusion'].flatMap(variant => [1, 2, 3].map(repeat => ({ task: 'demo', variant, repeat, model: 'same-model', initialProjectHash: 'a'.repeat(64), callBudget: 100, completed: true, falseSuccesses: 0, autorouteSelections: 0, autorouteExecutions: 0, unexplainedDrc: 0, calls: 20, elapsedSeconds: 60, evidence: ['local-test'] })));
  assert.equal(evaluateRecords(records).groups[0].completed, 3);
  assert.throws(() => evaluateRecords(records.slice(1)), /Incomplete/);
  records[0].model = 'different';
  assert.throws(() => evaluateRecords(records), /Unequal/);
});
