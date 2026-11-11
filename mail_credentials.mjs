import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeMailSnapshot } from './mail_jobs.mjs';

function validateCredentials(raw) {
  let text;
  try { text = new TextDecoder('utf-8', {fatal:true}).decode(raw); }
  catch { text = new TextDecoder('gb18030', {fatal:true}).decode(raw); }
  const senders = new Map();
  for (const [index, line] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const separator = line.indexOf('----');
    const sender = line.slice(0, separator).trim().toLowerCase();
    const secret = line.slice(separator + 4).trim();
    if (separator < 1 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(sender) || !secret
      || (senders.has(sender) && senders.get(sender) !== secret)) {
      throw new Error(`授权码文件第 ${index + 1} 行格式不正确，请使用“发件邮箱----授权码”。`);
    }
    senders.set(sender, secret);
  }
  if (!senders.size) throw new Error('授权码文件为空，请检查文件格式。');
  return senders.size;
}

export class MailCredentials {
  constructor({dataDir,defaultFiles=[]}) {
    this.dataDir = path.resolve(dataDir);
    this.defaultFiles = defaultFiles;
    this.queue = Promise.resolve();
  }
  async initialize() {
    const task = this.queue.then(async () => {
      try { await fs.access(path.join(this.dataDir,'current.json')); return; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const filename of this.defaultFiles) {
        let raw;
        try { raw = await fs.readFile(filename); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        await this.write(raw,path.basename(filename));
        return;
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async write(raw, filename) {
    const senderCount = validateCredentials(raw);
    await fs.mkdir(this.dataDir,{recursive:true});
    // Commit metadata last. A failed upload never replaces the active file.
    const stored = `authorization-${randomUUID()}.txt`;
    const target = path.join(this.dataDir,stored);
    let previous;
    try { previous = JSON.parse(await fs.readFile(path.join(this.dataDir,'current.json'),'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      await fs.writeFile(target,raw,{mode:0o600});
      await writeMailSnapshot(path.join(this.dataDir,'current.json'), {stored,filename:path.basename(filename),senderCount,updatedAt:new Date().toISOString()});
    } catch (error) { await fs.rm(target,{force:true}); throw error; }
    if (previous?.stored && /^authorization-[a-f0-9-]+\.txt$/.test(previous.stored)) await fs.rm(path.join(this.dataDir,previous.stored),{force:true});
  }
  async save(raw,filename='授权码.txt') {
    const task = this.queue.then(() => this.write(raw,filename));
    this.queue = task.catch(() => {});
    await task;
    return this.status();
  }
  async metadata() {
    await this.initialize();
    try { return JSON.parse(await fs.readFile(path.join(this.dataDir,'current.json'),'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async status() {
    const value = await this.metadata();
    if (!value) return {ready:false,filename:'',senderCount:0};
    const senderCount = validateCredentials(await fs.readFile(path.join(this.dataDir,value.stored)));
    const {stored,...publicFields} = value;
    return {ready:true,...publicFields,senderCount};
  }
  async read() {
    const value = await this.metadata();
    if (!value) throw new Error('未找到默认授权码文件，请上传授权码 TXT 并保存。');
    return fs.readFile(path.join(this.dataDir,value.stored));
  }
}
