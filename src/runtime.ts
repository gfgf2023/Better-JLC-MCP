import { mkdir, readFile, writeFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { GatewayClient } from './gateway-client.js';
import { targetSchema, documentTypes, hash, result, type Target, type Result } from './model.js';

export interface Gateway { execute(code: string, windowId?: string): Promise<any>; health(): Promise<any>; listWindows(): Promise<any>; }
export class OperationError extends Error { constructor(message: string, public details?: any) { super(message); } }
export function guardCode(target: Target, code: string): string {
  return `const target=${JSON.stringify(target)}; const doc=await eda.dmt_SelectControl.getCurrentDocumentInfo(); const project=await eda.dmt_Project.getCurrentProjectInfo(); if(!doc || doc.uuid!==target.documentId || doc.parentProjectUuid!==target.projectId || project?.uuid!==target.projectId || doc.documentType!==${documentTypes[target.domain]}) throw new Error('TARGET_MISMATCH'); ${code}`;
}
const queues = new Map<string, Promise<unknown>>();
export async function serialized<T>(windowId: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(windowId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  queues.set(windowId, current);
  try { return await current; } finally { if (queues.get(windowId) === current) queues.delete(windowId); }
}
export class Transaction {
  changes: any[] = [];
  wrote = false;
  constructor(public target: Target, public gateway: Gateway) {}
  read(code: string): Promise<any> { return this.gateway.execute(guardCode(this.target, code), this.target.windowId); }
  async write(code: string): Promise<any> {
    this.wrote = true;
    const data = await this.read(code);
    if (data === undefined || data === null || data === false) throw new OperationError('Write returned no verified result');
    if (data.changes) this.changes.push(...data.changes);
    if (data.status === 'partial' || data.status === 'failed') throw new OperationError('Write only partially completed', data);
    return data;
  }
}
export class Runtime {
  private backups = new Map<string, string>();
  constructor(public gateway: Gateway = new GatewayClient(), public stateDir = path.resolve(process.env.EASYEDA_STATE_DIR ?? '.easyeda-mcp')) {}
  private async exclusive<T>(windowId: string, fn: () => Promise<T>): Promise<T> {
    return serialized(windowId, async () => {
      const directory = path.join(this.stateDir, 'locks');
      await mkdir(directory, { recursive: true });
      const lock = path.join(directory, hash(windowId));
      try { await mkdir(lock); }
      catch (error: any) {
        if (error.code === 'EEXIST') throw new Error('WINDOW_BUSY: Another process holds this window lock. After a crash, inspect EDA and remove the empty stale lock directory manually.');
        throw error;
      }
      try { return await fn(); } finally { await rmdir(lock); }
    });
  }
  async inspect(windowId?: string) {
    const health = await this.gateway.health();
    if (health.service !== 'easyeda-bridge' || !health.edaConnected) throw new Error('Official bridge is not connected');
    const list = await this.gateway.listWindows();
    const id = windowId ?? (list.windows.length === 1 ? list.windows[0].windowId : undefined);
    if (!id || !list.windows.some((w: any) => w.windowId === id)) return { health, windows: list.windows, next: 'Supply a windowId from this list.' };
    return this.exclusive(id, async () => {
      const project = await this.gateway.execute('return await eda.dmt_Project.getCurrentProjectInfo();', id);
      const document = await this.gateway.execute('return await eda.dmt_SelectControl.getCurrentDocumentInfo();', id);
      const boards = await this.gateway.execute('return await eda.dmt_Board.getAllBoardsInfo();', id);
      return { health, windowId: id, project, document, boards, target: document?.uuid && project?.uuid && [1, 3].includes(document.documentType) ? { windowId: id, projectId: project.uuid, documentId: document.uuid, domain: document.documentType === 3 ? 'pcb' : 'schematic' } : undefined };
    });
  }
  async read<T>(target: Target, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    targetSchema.parse(target);
    return this.exclusive(target.windowId, () => fn(new Transaction(target, this.gateway)));
  }
  async mutate(target: Target, operationId: string, request: unknown, fn: (tx: Transaction) => Promise<Result>): Promise<Result> {
    targetSchema.parse(target);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(operationId)) throw new Error('Invalid operationId');
    return this.exclusive(target.windowId, async () => {
      const dir = path.join(this.stateDir, hash(target)), file = path.join(dir, `${operationId}.json`), fingerprint = hash(request);
      await mkdir(dir, { recursive: true });
      let existing: any;
      try { existing = JSON.parse(await readFile(file, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('operationId already used with different input');
        if (existing.result) return existing.result;
        return { ...result(null, target), status: 'unknown', error: 'Previous execution is unresolved; do not replay it.', evidence: { operationId }, next: ['Read the current document and reconcile the previous operation.'] };
      }
      const tx = new Transaction(target, this.gateway);
      const record: any = { operationId, fingerprint, target, startedAt: new Date().toISOString() };
      await writeFile(file, JSON.stringify(record, null, 2), { flag: 'wx' });
      try {
        const source = await tx.read('return await eda.sys_FileManager.getDocumentSource();');
        if (typeof source !== 'string' || !source.length) throw new Error('Document backup unavailable; write not started');
        const sourcePath = path.join(dir, `${operationId}.source.bak`);
        await writeFile(sourcePath, source, { flag: 'wx' });
        const backupKey = `${target.windowId}:${target.projectId}`;
        let projectBackup = this.backups.get(backupKey);
        if (!projectBackup) {
          const backup = await tx.read(`const file=await eda.sys_FileManager.getProjectFile('easyeda-mcp-backup',undefined,'epro2'); if(!file) throw new Error('Project backup unavailable'); const bytes=new Uint8Array(await file.arrayBuffer()); let binary=''; for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192)); return {base64:btoa(binary)};`);
          projectBackup = path.join(dir, `${operationId}.epro2`);
          if (!backup?.base64) throw new Error('Empty project backup');
          await writeFile(projectBackup, Buffer.from(backup.base64, 'base64'), { flag: 'wx' });
          this.backups.set(backupKey, projectBackup);
        }
        record.backup = { sourcePath, projectBackup, sourceHash: hash(source) };
        await writeFile(file, JSON.stringify(record, null, 2));
        const output = await fn(tx);
        output.target = target;
        output.changes = tx.changes;
        output.evidence = { ...output.evidence, backup: record.backup, operationId };
        record.result = output;
      } catch (error: any) {
        let recoveredState: any;
        try { recoveredState = await tx.read('return {document:await eda.dmt_SelectControl.getCurrentDocumentInfo(),source:await eda.sys_FileManager.getDocumentSource()};');
          if (recoveredState?.source) { const recoveryPath = path.join(dir, `${operationId}.recovery.source`); await writeFile(recoveryPath, recoveredState.source); recoveredState = { document: recoveredState.document, sourceHash: hash(recoveredState.source), recoveryPath }; }
        } catch (recoveryError: any) { recoveredState = { error: recoveryError.message }; }
        record.result = { ...result(null, target), changes: tx.changes, status: tx.wrote ? (error.details?.status === 'partial' ? 'partial' : 'unknown') : 'failed', error: error.message, evidence: { details: error.details, recoveredState, backup: record.backup, operationId }, next: tx.wrote ? ['Inspect the recovered state before any further edits. Do not replay this operationId.'] : ['Correct the precondition and use a new operationId.'] };
      }
      record.completedAt = new Date().toISOString();
      await writeFile(file, JSON.stringify(record, null, 2));
      return record.result;
    });
  }
  async memory(target: Target, update?: unknown) {
    const file = path.join(this.stateDir, 'memory', `${hash(target.projectId)}.json`);
    if (update !== undefined) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(update, null, 2)); }
    try { return JSON.parse(await readFile(file, 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') return { constraints: [], decisions: [], unresolved: [], observations: [] }; throw e; }
  }
}
