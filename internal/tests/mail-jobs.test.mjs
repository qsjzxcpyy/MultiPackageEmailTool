import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MailJobs, writeMailSnapshot } from '../../mail_jobs.mjs';

const rows = [1, 2, 3].map(n => ({订单号: `TEST-${n}`, 来源: 'ZE', 收件邮箱: `buyer${n}@example.com`, 发件邮箱: 'demo@qq.com', 邮件内容: `Synthetic body ${n}`}));
async function setup(t, launchWorker) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-jobs-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const workbook = path.join(root, 'input.xlsx');
  await fs.writeFile(workbook, 'synthetic placeholder; fake worker never reads workbook');
  const dataDir = path.join(root, 'history');
  return {root, workbook, dataDir, jobs:new MailJobs({dataDir, launchWorker})};
}
test('generation is pending; history and content survive reload; duplicate output reuses batch', async t => {
  let starts = 0;
  const {jobs, dataDir, workbook} = await setup(t, () => { starts++; });
  const batch = await jobs.create(rows, workbook);
  assert.equal(batch.counts.pending, 3);
  assert.equal(starts, 0);
  assert.equal((await jobs.create(rows, workbook)).id, batch.id);
  assert.equal((await jobs.create([...rows].reverse(), workbook)).id, batch.id);
  const restored = await new MailJobs({dataDir}).get(batch.id);
  assert.equal(restored.records[0].订单号, 'TEST-1');
  assert.equal(restored.records[0].邮件内容, 'Synthetic body 1');
});
test('explicit send streams outcomes, prevents concurrent sends and hides credentials', async t => {
  let finish;
  let manifest;
  const {jobs, root, workbook} = await setup(t, async input => {
    manifest = input;
    await new Promise(resolve => {finish = resolve;});
    await writeMailSnapshot(input.progressPath, {phase:'completed', records: rows.map((row, i) => ({row:i+2, recipient:row.收件邮箱, sender:row.发件邮箱, status:['sent','failed','uncertain'][i], attempts:1, detail:['服务器已接收','SMTP 拒绝，状态码 550','连接中断或超时（submit）'][i]}))});
  });
  const batch = await jobs.create(rows, workbook);
  await jobs.start(batch.id, Buffer.from('demo@qq.com----fake-secret'));
  await assert.rejects(jobs.start(batch.id, Buffer.from('ignored')), /正在发送/);
  finish();
  await jobs.waitForIdle();
  const result = await jobs.get(batch.id);
  assert.deepEqual(result.counts, {total:3, pending:0, sending:0, sent:1, failed:1, uncertain:1});
  assert.equal(result.phase, 'completed');
  assert.doesNotMatch(JSON.stringify(result), /fake-secret/);
  await assert.rejects(fs.access(manifest.authPath));
  assert.equal((await jobs.list()).length, 1);
  await assert.rejects(jobs.get('../outside'), /批次/);
});
test('worker failure keeps confirmed successes and marks interrupted submission uncertain', async t => {
  const {jobs, workbook} = await setup(t, async input => {
    await writeMailSnapshot(input.progressPath, {phase:'running', records:[{row:2,status:'sent',detail:'accepted'}, {row:3,status:'sending',detail:'submitting'}, {row:4,status:'pending',detail:'waiting'}]});
    throw new Error('worker exited');
  });
  const batch = await jobs.create(rows, workbook);
  await jobs.start(batch.id, Buffer.from('fake'));
  await jobs.waitForIdle();
  const result = await jobs.get(batch.id);
  assert.equal(result.phase, 'stopped');
  assert.equal(result.counts.sent, 1);
  assert.equal(result.counts.uncertain, 1);
  assert.equal(result.counts.pending, 1);
});
test('restart does not send automatically; a dead worker leaves interrupted rows for verification', async t => {
  const {jobs, workbook, dataDir} = await setup(t);
  const batch = await jobs.create(rows, workbook);
  const directory = path.join(dataDir,batch.id);
  await fs.writeFile(path.join(directory,'credentials.txt'),'fictional orphan credential');
  await writeMailSnapshot(path.join(directory,'progress.json'),{phase:'running',pid:2147483647,records:[{status:'sent'},{status:'sending'},{status:'pending'}]});
  let starts = 0;
  const restored = await new MailJobs({dataDir,launchWorker:()=>{starts++;}}).get(batch.id);
  assert.equal(starts,0);
  assert.equal(restored.phase,'stopped');
  assert.equal(restored.counts.sent,1);
  assert.equal(restored.counts.uncertain,1);
  assert.equal(restored.counts.pending,1);
  await assert.rejects(fs.access(path.join(directory,'credentials.txt')));
});

for (const status of ['sent', 'uncertain', 'sending']) {
  test(`cross-batch ${status} overlap blocks the whole changed set before worker launch`, async t => {
    const {jobs, workbook, dataDir} = await setup(t);
    const historicalRows = [rows[1], rows[0]];
    const previous = await jobs.create(historicalRows, workbook);
    await writeMailSnapshot(path.join(dataDir, previous.id, 'progress.json'), {
      phase:status === 'sending' ? 'running' : 'completed', pid:2147483647,
      records:historicalRows.map((row, index) => ({
        row:index + 2, recipient:row.收件邮箱, sender:row.发件邮箱,
        status:index === 1 ? status : 'failed', attempts:1,
      })),
    });
    let starts = 0;
    const restored = new MailJobs({dataDir, launchWorker:async () => { starts++; }});
    const current = await restored.create([rows[0], rows[2]], workbook);
    assert.notEqual(current.id, previous.id);
    await assert.rejects(async () => {
      try { await restored.start(current.id, Buffer.from('fictional-code')); }
      finally { await restored.waitForIdle(); }
    }, /跨批次/);
    assert.equal(starts, 0);
    assert.equal((await restored.get(current.id)).counts.pending, 2);
    for (const filename of ['credentials.txt', 'manifest.json', 'progress.json']) {
      await assert.rejects(fs.access(path.join(dataDir, current.id, filename)), {code:'ENOENT'});
    }
  });
}

test('cross-batch identity normalizes surrounding whitespace and sender case', async t => {
  let starts = 0;
  const {jobs, workbook, dataDir} = await setup(t, async () => { starts++; });
  const previous = await jobs.create([rows[0]], workbook);
  await writeMailSnapshot(path.join(dataDir, previous.id, 'progress.json'), {
    phase:'completed', records:[{status:'sent'}],
  });
  const padded = Object.fromEntries(Object.entries(rows[0]).map(([key, value]) =>
    [key, `  ${key === '发件邮箱' ? value.toUpperCase() : value}  `]));
  const current = await jobs.create([padded], workbook);
  assert.notEqual(current.id, previous.id);
  await assert.rejects(async () => {
    try { await jobs.start(current.id, Buffer.from('fictional-code')); }
    finally { await jobs.waitForIdle(); }
  }, /跨批次/);
  assert.equal(starts, 0);
});

for (const [field, value] of [
  ['订单号', 'DIFFERENT-ORDER'], ['来源', 'DIFFERENT-SOURCE'],
  ['收件邮箱', 'different@example.invalid'], ['邮件内容', 'Different synthetic body'],
  ['发件邮箱', 'different@example.invalid'],
]) {
  test(`cross-batch identity allows a different ${field}`, async t => {
    let starts = 0;
    const {jobs, workbook, dataDir} = await setup(t, async input => {
      starts++;
      await writeMailSnapshot(input.progressPath, {phase:'completed', records:[{status:'sent'}]});
    });
    const previous = await jobs.create([rows[0]], workbook);
    await writeMailSnapshot(path.join(dataDir, previous.id, 'progress.json'), {
      phase:'completed', records:[{status:'sent'}],
    });
    const current = await jobs.create([{...rows[0], [field]:value}], workbook);
    await jobs.start(current.id, Buffer.from('fictional-code'));
    await jobs.waitForIdle();
    assert.equal(starts, 1);
    assert.equal((await jobs.get(current.id)).counts.sent, 1);
  });
}

test('cross-batch matching uses full historical row identity instead of current position', async t => {
  let starts = 0;
  const {jobs, workbook, dataDir} = await setup(t, async input => {
    starts++;
    await writeMailSnapshot(input.progressPath, {
      phase:'completed', records:[{status:'sent'}, {status:'sent'}],
    });
  });
  const previous = await jobs.create([rows[1], rows[0]], workbook);
  await writeMailSnapshot(path.join(dataDir, previous.id, 'progress.json'), {
    phase:'completed', records:[{status:'sent'}, {status:'failed'}],
  });
  const current = await jobs.create([rows[0], rows[2]], workbook);
  await jobs.start(current.id, Buffer.from('fictional-code'));
  await jobs.waitForIdle();
  assert.equal(starts, 1);
  assert.equal((await jobs.get(current.id)).counts.sent, 2);
});

test('same-batch retry remains available with sent and uncertain rows in its own history', async t => {
  let starts = 0;
  const {jobs, workbook, dataDir} = await setup(t, async input => {
    starts++;
    await writeMailSnapshot(input.progressPath, {
      phase:'completed', records:[{status:'sent'}, {status:'sent'}, {status:'uncertain'}],
    });
  });
  const batch = await jobs.create(rows, workbook);
  await writeMailSnapshot(path.join(dataDir, batch.id, 'progress.json'), {
    phase:'completed', records:[{status:'sent'}, {status:'failed'}, {status:'uncertain'}],
  });
  const reordered = await jobs.create([...rows].reverse(), workbook);
  assert.equal(reordered.id, batch.id);
  await jobs.start(reordered.id, Buffer.from('fictional-code'));
  await jobs.waitForIdle();
  assert.equal(starts, 1);
  const result = await jobs.get(batch.id);
  assert.equal(result.counts.sent, 2);
  assert.equal(result.counts.uncertain, 1);
});
