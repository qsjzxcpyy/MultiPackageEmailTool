import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MailCredentials } from '../../mail_credentials.mjs';

test('existing local file is selected by default; replacements persist without returning secrets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'mail-credentials-test-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const source = path.join(root,'existing.txt');
  const dataDir = path.join(root,'settings');
  await fs.writeFile(source,'demo@qq.com----fictional-default');
  const store = new MailCredentials({dataDir,defaultFiles:[source]});
  const status = await store.status();
  assert.equal(status.ready,true);
  assert.equal(status.senderCount,1);
  assert.doesNotMatch(JSON.stringify(status),/fictional-default/);
  assert.match((await store.read()).toString(),/fictional-default/);
  await store.save(Buffer.from('demo@qq.com----fictional-new\nother@163.com----fictional-other'),'replacement.txt');
  await fs.writeFile(source,'demo@qq.com----fictional-old');
  const restored = new MailCredentials({dataDir,defaultFiles:[source]});
  assert.equal((await restored.status()).filename,'replacement.txt');
  assert.equal((await restored.status()).senderCount,2);
  assert.match((await restored.read()).toString(),/fictional-new/);
  await assert.rejects(restored.save(Buffer.from('malformed'),'broken.txt'),/格式/);
  assert.match((await restored.read()).toString(),/fictional-new/);
});

test('missing default file is reported without invoking any sender', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'mail-credentials-empty-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const store = new MailCredentials({dataDir:root,defaultFiles:[]});
  assert.equal((await store.status()).ready,false);
  await assert.rejects(store.read(),/授权码/);
});

test('sender count follows direct edits to the active authorization file without re-upload', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'mail-credentials-edited-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const store = new MailCredentials({dataDir:root});
  await store.save(Buffer.from('one@example.com----FICTIONAL-ONE'),'授权码.txt');
  const {stored} = JSON.parse(await fs.readFile(path.join(root,'current.json'),'utf8'));
  const activeFile = path.join(root,stored);
  await fs.appendFile(activeFile,'\ntwo@example.com----FICTIONAL-TWO');
  const status = await store.status();
  assert.equal(status.senderCount,2);
  assert.equal(status.ready,true);
  assert.equal(status.filename,'授权码.txt');
  assert.doesNotMatch(JSON.stringify(status),/FICTIONAL|one@example|two@example|authorization-/);
  await fs.writeFile(activeFile,'two@example.com----FICTIONAL-TWO\nTWO@EXAMPLE.COM----FICTIONAL-TWO');
  assert.equal((await store.status()).senderCount,1);
  await fs.writeFile(activeFile,'malformed');
  await assert.rejects(store.status(),/格式/);
});
