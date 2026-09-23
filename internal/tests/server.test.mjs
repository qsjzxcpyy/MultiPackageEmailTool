import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';
import { createApp, formatErrorMessage, resolvePort } from '../../server.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cloudFixturePath = path.join(projectRoot, 'Drop Shipping Order List20260825203710.xlsx');
const erpFixturePath = path.join(projectRoot, '推单前检查', 'order-1787646003.xlsx');
const currentCloudFixturePath = path.join(projectRoot, '8月28-29推单多包裹', 'Drop Shipping Order List20260831000608.xlsx');
const currentErpFixturePath = path.join(projectRoot, '8月28-29推单多包裹', 'order-1788160744.xlsx');

async function startApp(t, options = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-package-server-test-'));
  const server = createApp({ rootDir: appRoot, tempDir: temporaryRoot, ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  t.after(async () => {
    await server.shutdown();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  return { baseUrl: `http://127.0.0.1:${port}`, temporaryRoot };
}

async function uploadFile(url, filePath, filename = path.basename(filePath)) {
  return fetch(url, {
    method: 'POST',
    headers: { 'X-Filename': filename },
    body: await fs.readFile(filePath),
  });
}

test('health endpoint reports the local service', async (t) => {
  const { baseUrl } = await startApp(t);

  const response = await fetch(`${baseUrl}/api/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    stage: 'idle',
    version: '20260923-collapse-order-lists',
  });
});

test('error responses preserve a useful processing error message', () => {
  assert.equal(formatErrorMessage(new Error('Unsupported carrier for order TEST: Fedex / UPS')),
    'Unsupported carrier for order TEST: Fedex / UPS');
  assert.equal(formatErrorMessage({}), 'The workbook could not be processed.');
});

test('explicit launcher port takes precedence over the environment', () => {
  assert.equal(resolvePort({ argv: ['--port', '8788'], envPort: '8787' }), 8788);
  assert.equal(resolvePort({ argv: [], envPort: '8788' }), 8788);
  assert.equal(resolvePort({ argv: ['--port', 'not-a-port'], envPort: '8787' }), 8787);
});

test('static application routes serve the browser workspace', async (t) => {
  const { baseUrl } = await startApp(t);

  for (const [route, contentType] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/styles.css', 'text/css']]) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), new RegExp(contentType));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('shutdown removes the current run directory', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-package-shutdown-test-'));
  const server = createApp({ rootDir: appRoot, tempDir: temporaryRoot });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await uploadFile(`http://127.0.0.1:${port}/api/cloud`, cloudFixturePath);
  const runDirectories = await fs.readdir(temporaryRoot);
  assert.equal(runDirectories.length, 1);
  await server.shutdown();
  assert.deepEqual(await fs.readdir(temporaryRoot), []);
  await fs.rm(temporaryRoot, { recursive: true, force: true });
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
});

test('cloud upload returns aggregated order preview and ERP download', async (t) => {
  const { baseUrl } = await startApp(t);

  const response = await uploadFile(`${baseUrl}/api/cloud`, cloudFixturePath);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.stats.multiPackageOrders, 79);
  assert.equal(body.stats.twoPackageOrders, 55);
  assert.equal(body.stats.threePackageOrders, 24);
  assert.equal(body.stats.totalTrackingNumbers, 182);
  assert.equal(body.preview.length, 79);
  assert.equal(typeof body.preview[0].source, 'string');
  assert.deepEqual(Object.keys(body.preview[0]).sort(), [
    'carrier',
    'emailBody',
    'order',
    'packageCount',
    'source',
    'trackingNumbers',
  ]);
  assert.match(body.downloads.erpOrderList, /\/api\/download\//);
});

test('ERP upload before cloud upload is rejected', async (t) => {
  const { baseUrl } = await startApp(t);

  const response = await uploadFile(`${baseUrl}/api/erp`, erpFixturePath);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'CLOUD_UPLOAD_REQUIRED',
      message: 'Upload a cloud warehouse file before uploading an ERP file.',
    },
  });
});

test('current unmatched ERP fixture produces no sendable rows', async (t) => {
  const { baseUrl } = await startApp(t);
  await uploadFile(`${baseUrl}/api/cloud`, cloudFixturePath);

  const response = await uploadFile(`${baseUrl}/api/erp`, erpFixturePath);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.stats.sendableRows, 0);
  assert.equal(body.stats.reviewRows, 79);
  assert.match(body.downloads.final, /\/api\/download\//);
  assert.match(body.downloads.review, /\/api\/download\//);
});

test('upload rejects a file that is not an xlsx workbook', async (t) => {
  const { baseUrl } = await startApp(t);

  const response = await fetch(`${baseUrl}/api/cloud`, {
    method: 'POST',
    headers: { 'X-Filename': 'orders.csv' },
    body: 'not a workbook',
  });

  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'UNSUPPORTED_FILE_TYPE',
      message: 'Only .xlsx files are supported.',
    },
  });
});

test('download rejects an identifier that was not generated for the current run', async (t) => {
  const { baseUrl } = await startApp(t);

  const response = await fetch(`${baseUrl}/api/download/not-a-generated-file`);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'DOWNLOAD_NOT_FOUND',
      message: 'The requested download was not found.',
    },
  });
});

test('static routes do not expose files through traversal-like paths', async (t) => {
  const { baseUrl } = await startApp(t);

  const response = await fetch(`${baseUrl}/web%2F..%2Fserver.mjs`);

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('cloud upload rejects a request larger than the configured limit', async (t) => {
  const { baseUrl } = await startApp(t, { maxUploadBytes: 8 });

  const response = await fetch(`${baseUrl}/api/cloud`, {
    method: 'POST',
    headers: { 'X-Filename': 'orders.xlsx' },
    body: new Uint8Array(9),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'UPLOAD_TOO_LARGE',
      message: 'The uploaded file exceeds the 8 byte limit.',
    },
  });
});

test('registered downloads are sent as attachments', async (t) => {
  const { baseUrl } = await startApp(t);
  const cloudResponse = await uploadFile(`${baseUrl}/api/cloud`, cloudFixturePath);
  const cloudBody = await cloudResponse.json();

  const response = await fetch(`${baseUrl}${cloudBody.downloads.erpOrderList}`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('ERP upload accepts two files and merges their order records', async (t) => {
  const { baseUrl } = await startApp(t);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-package-batch-upload-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const orders = ['112-9689878-0489044', '114-2845827-6449863'];
  const erpFiles = [];
  for (const [index, order] of orders.entries()) {
    const workbook = Workbook.create();
    const worksheet = workbook.worksheets.add('Export orders');
    worksheet.getRange('A1:B2').values = [
      ['refrence_no', 'consignee_email'],
      [order, `batch-${index + 1}@marketplace.amazon.com`],
    ];
    const blob = await SpreadsheetFile.exportXlsx(workbook);
    const filePath = path.join(temporaryRoot, `erp-${index + 1}.xlsx`);
    await fs.writeFile(filePath, blob.data);
    erpFiles.push(filePath);
  }

  await uploadFile(`${baseUrl}/api/cloud`, cloudFixturePath);
  const form = new FormData();
  for (const filePath of erpFiles) {
    form.append(
      'files',
      new Blob([await fs.readFile(filePath)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      path.basename(filePath),
    );
  }
  const response = await fetch(`${baseUrl}/api/erp`, { method: 'POST', body: form });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.stats.sendableRows, 2);
  assert.equal(body.stats.reviewRows, 77);
  assert.deepEqual(body.sendable.map((row) => row['收件邮箱']), [
    'batch-1@marketplace.amazon.com',
    'batch-2@marketplace.amazon.com',
  ]);
});

test('current-day ERP upload returns the matched result instead of failing on template capacity', async (t) => {
  const { baseUrl } = await startApp(t);

  const cloudResponse = await uploadFile(`${baseUrl}/api/cloud`, currentCloudFixturePath);
  assert.equal(cloudResponse.status, 200);
  const cloudBody = await cloudResponse.json();
  assert.equal(cloudBody.stats.multiPackageOrders, 86);

  const erpResponse = await uploadFile(`${baseUrl}/api/erp`, currentErpFixturePath);
  const erpBody = await erpResponse.json();

  assert.equal(erpResponse.status, 200);
  assert.equal(erpBody.stats.sendableRows, 76);
  assert.equal(erpBody.stats.reviewRows, 10);
  assert.equal(erpBody.sendable.length, 76);
  assert.equal(erpBody.review.length, 10);
  assert.match(erpBody.downloads.final, /\/api\/download\//);
});
