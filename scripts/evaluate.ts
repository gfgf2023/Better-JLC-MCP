import { readFile } from 'node:fs/promises';
import { evaluateRecords } from '../src/evaluation.js';
console.log(JSON.stringify(evaluateRecords(JSON.parse(await readFile(process.argv[2] ?? 'examples/evaluation-records.json', 'utf8'))), null, 2));
