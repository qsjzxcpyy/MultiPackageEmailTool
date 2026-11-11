import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export async function writeMailSnapshot(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), {mode:0o600});
  try {
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, filename); break; }
      catch (error) {
        if (!['EPERM','EACCES','EBUSY'].includes(error.code) || attempt >= 19) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  } finally { await fs.rm(temporary,{force:true}); }
}
const atomicJson = writeMailSnapshot;
function deliveryIdentity(row) {
  return JSON.stringify([
    ...[row.订单号, row.来源, row.收件邮箱, row.邮件内容].map(value => String(value ?? '').trim()),
    row.发件邮箱.trim().toLowerCase(),
  ]);
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export function launchBundledWorker(executable, manifest) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--web-worker', manifest], {windowsHide:true, stdio:'ignore'});
    child.once('error', () => reject(new Error('无法启动发送模块，请检查 internal/bin/mail_worker.exe 是否完整。')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('发送模块异常退出，请核对逐条记录。')));
  });
}

export class MailJobs {
  constructor({dataDir, workerPath, launchWorker} = {}) {
    this.dataDir = path.resolve(dataDir);
    this.launchWorker = launchWorker ?? (input => launchBundledWorker(workerPath, input.manifestPath));
    this.active = new Map();
    this.queue = Promise.resolve();
  }
  directory(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('无效的发送批次。');
    return path.join(this.dataDir, id);
  }
  exclusive(action) {
    const task = this.queue.then(action, action);
    this.queue = task.catch(() => {});
    return task;
  }
  async create(rows, workbook) {
    return this.exclusive(async () => {
      const identity = rows.map(row => [row.订单号, row.来源, row.收件邮箱.trim(), row.邮件内容.trim(), row.发件邮箱.trim().toLowerCase()]);
      identity.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      const directory = this.directory(id);
      await fs.mkdir(directory, {recursive:true});
      try { await fs.access(path.join(directory, 'batch.json')); }
      catch {
        await fs.copyFile(workbook, path.join(directory, 'final.xlsx'));
        await atomicJson(path.join(directory, 'batch.json'), {id, createdAt:new Date().toISOString(), rows});
      }
      return this.get(id);
    });
  }
  async get(id) {
    const directory = this.directory(id);
    const meta = JSON.parse(await fs.readFile(path.join(directory, 'batch.json'), 'utf8'));
    let progress = {phase:'ready', records:[]};
    try { progress = JSON.parse(await fs.readFile(path.join(directory, 'progress.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let phase = progress.phase;
    if (phase === 'running' && !this.active.has(id) && !alive(progress.pid)) {
      phase = 'stopped';
      await fs.rm(path.join(directory, 'credentials.txt'), {force:true});
    }
    const statuses = new Set(['pending', 'sending', 'sent', 'failed', 'uncertain']);
    const records = meta.rows.map((row, index) => {
      const item = progress.records?.[index];
      let status = statuses.has(item?.status) ? item.status : 'pending';
      let detail = item?.detail || '尚未发送';
      if ((phase === 'stopped' || phase === 'error') && status === 'sending') {
        status = 'uncertain'; detail = '发送中断，请先核对发件箱或服务商后台，未自动补发';
      }
      return {...row, status, detail, attempts:item?.attempts || 0, updated:item?.updated || ''};
    });
    const counts = {total:records.length, pending:0, sending:0, sent:0, failed:0, uncertain:0};
    for (const row of records) counts[row.status]++;
    return {id, createdAt:meta.createdAt, phase, error:progress.error || '', counts, records};
  }
  async list() {
    let directories;
    try { directories = await fs.readdir(this.dataDir); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const batches = [];
    for (const id of directories.filter(name => /^[a-f0-9]{64}$/.test(name))) {
      const batch = await this.get(id);
      const {records, ...summary} = batch;
      batches.push(summary);
    }
    return batches.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  async start(id, credentials) {
    return this.exclusive(async () => {
      const batch = await this.get(id);
      const history = await this.list();
      if (batch.phase === 'running' || this.active.size || history.some(item => item.phase === 'running')) {
        throw new Error('已有邮件正在发送，请等待完成。');
      }
      if (!batch.counts.pending && !batch.counts.failed) throw new Error('没有可发送记录；已成功和待核对记录不会重复发送。');
      if (!credentials.length) throw new Error('请选择包含发件邮箱授权码的 TXT 文件。');
      const identities = new Set(batch.records.map(deliveryIdentity));
      for (const previous of history) {
        if (previous.id === id || (!previous.counts.sent && !previous.counts.uncertain)) continue;
        // Join full persisted delivery identities; row positions can differ between batches.
        const historical = await this.get(previous.id);
        const overlap = historical.records.find(row =>
          (row.status === 'sent' || row.status === 'uncertain') && identities.has(deliveryIdentity(row)));
        if (overlap) {
          throw new Error(`跨批次重复邮件：订单 ${overlap.订单号} 在其他批次已有成功或待核对记录，已停止整批发送，请先核对历史记录。`);
        }
      }
      const directory = this.directory(id);
      const input = {manifestPath:path.join(directory, 'manifest.json'),
        workbook:path.join(directory, 'final.xlsx'), authPath:path.join(directory, 'credentials.txt'),
        stateDir:path.join(directory, 'journal'), progressPath:path.join(directory, 'progress.json'),
        expectedRows:batch.records.map(row => [row.收件邮箱.trim(), row.邮件内容.trim(), row.发件邮箱.trim().toLowerCase()])};
      try {
        await fs.writeFile(input.authPath, credentials, {mode:0o600});
        await atomicJson(input.manifestPath, input);
        await atomicJson(input.progressPath, {phase:'running',pid:process.pid,records:batch.records});
      } catch (error) {
        await fs.rm(input.authPath, {force:true});
        throw error;
      }
      const task = Promise.resolve().then(() => this.launchWorker(input)).catch(async () => {
        let latest;
        try { latest = JSON.parse(await fs.readFile(input.progressPath,'utf8')); } catch { latest = {records:batch.records}; }
        await atomicJson(input.progressPath, {...latest, phase:'stopped', error:'发送模块已停止，请核对逐条结果后再处理未成功的记录。'});
      }).finally(async () => {
        // A worker which exits without a terminal snapshot cannot imply success.
        try {
          const latest = JSON.parse(await fs.readFile(input.progressPath,'utf8'));
          if (latest.phase === 'running') await atomicJson(input.progressPath, {...latest,phase:'stopped',error:'发送中断，请核对结果。'});
        } finally {
          await fs.rm(input.authPath, {force:true});
          this.active.delete(id);
        }
      });
      this.active.set(id, task);
      return {...batch, phase:'running', error:''};
    });
  }
  async waitForIdle() { await this.queue; await Promise.all([...this.active.values()]); }
}
