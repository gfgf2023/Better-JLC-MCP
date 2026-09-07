import { z } from 'zod';
const count = z.number().int().nonnegative();
export const evaluationRow = z.object({
  task: z.string().min(1), variant: z.enum(['original', 'prompts_only', 'fusion']), repeat: z.number().int().min(1).max(3),
  model: z.string().min(1), initialProjectHash: z.string().regex(/^[a-f0-9]{64}$/), callBudget: count.positive(),
  completed: z.boolean(), falseSuccesses: count, autorouteSelections: count, autorouteExecutions: count,
  unexplainedDrc: count, calls: count, elapsedSeconds: z.number().nonnegative(), evidence: z.array(z.string().min(1)).min(1),
}).strict();
export function evaluateRecords(input: unknown) {
  const rows = z.array(evaluationRow).parse(input);
  if (!rows.length) return { status: 'not_run', superioritySupported: false, groups: [] };
  const tasks = [...new Set(rows.map(r => r.task))];
  for (const task of tasks) {
    const group = rows.filter(r => r.task === task), base = group[0];
    for (const variant of ['original', 'prompts_only', 'fusion']) for (const repeat of [1, 2, 3]) {
      if (group.filter(r => r.variant === variant && r.repeat === repeat).length !== 1) throw new Error(`Incomplete or duplicated comparison: ${task}/${variant}/${repeat}`);
    }
    if (group.some(r => r.model !== base.model || r.initialProjectHash !== base.initialProjectHash || r.callBudget !== base.callBudget || r.calls > r.callBudget)) throw new Error(`Unequal model/initial project/budget or exceeded budget: ${task}`);
  }
  const groups = ['original', 'prompts_only', 'fusion'].map(variant => {
    const group = rows.filter(r => r.variant === variant), sum = (key: 'calls' | 'elapsedSeconds' | 'falseSuccesses' | 'autorouteSelections' | 'autorouteExecutions' | 'unexplainedDrc') => group.reduce((n, r) => n + r[key], 0);
    return { variant, runs: group.length, completed: group.filter(r => r.completed).length, falseSuccesses: sum('falseSuccesses'), autorouteSelections: sum('autorouteSelections'), autorouteExecutions: sum('autorouteExecutions'), unexplainedDrc: sum('unexplainedDrc'), meanCalls: sum('calls') / group.length, meanSeconds: sum('elapsedSeconds') / group.length };
  });
  return { status: 'recorded', superioritySupported: false, groups, note: 'Descriptive measurements only. Review task evidence and experimental validity before any superiority claim.' };
}
