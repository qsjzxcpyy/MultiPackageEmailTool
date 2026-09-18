import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { xml2js } from 'xml-js';
import { FileBlob, SpreadsheetFile, Workbook } from '@oai/artifact-tool';

import {
  aggregateMultiPackageOrders,
  filterAllowedSourceRows,
  buildEmailBody,
  buildCloudResultRows,
  OUTPUT_HEADERS,
  buildErpOrderList,
  matchOrdersToEmails,
  run,
} from '../../multi_package_email.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cloudFixture = path.join(projectRoot, 'Drop Shipping Order List20260825203710.xlsx');
const finalTemplateFixture = path.join(projectRoot, '发邮件8.17-1.xlsx');
const templateFixture = path.join(projectRoot, '8月25多包裹', 'Drop Shipping Order List20260825003315.xlsx');
const currentCloudFixture = path.join(projectRoot, '8月28-29推单多包裹', 'Drop Shipping Order List20260831000608.xlsx');
const currentErpFixture = path.join(projectRoot, '8月28-29推单多包裹', 'order-1788160744.xlsx');

const ORDER = '\u8ba2\u5355\u53f7';
const RECIPIENT = '\u6536\u4ef6\u90ae\u7bb1';
const BODY = '\u90ae\u4ef6\u5185\u5bb9';
const SENDER = '\u53d1\u4ef6\u90ae\u7bb1';

test('run exposes a reusable cloud-stage result for the web app', async (t) => {
  const temporaryOutputDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'multi-package-test-'),
  );
  t.after(() => fs.rm(temporaryOutputDirectory, { recursive: true, force: true }));

  const result = await run({
    source: cloudFixture,
    template: templateFixture,
    outDir: temporaryOutputDirectory,
  });

  assert.equal(result.orders.length, 79);
  assert.equal(result.orders.filter((order) => order.trackingNumbers.length === 2).length, 55);
  assert.equal(result.orders.filter((order) => order.trackingNumbers.length === 3).length, 24);
  assert.match(result.erpOrderListPath, /ERP/);
});

test('cloud processing builds mixed-carrier email groups', async (t) => {
  const temporaryOutputDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'multi-package-mixed-carrier-test-'),
  );
  t.after(() => fs.rm(temporaryOutputDirectory, { recursive: true, force: true }));

  const order = '114-8138341-3741068';
  const cloudWorkbook = Workbook.create();
  const cloudWorksheet = cloudWorkbook.worksheets.add('Shipment');
  cloudWorksheet.getRange('A1:E3').values = [
    ['Shipment ID', 'Carrier', 'Tracking Number', 'Seller', 'Ship From'],
    [order, 'Fedex', '876626526599', 'Store', 'ZEIINPA_US'],
    [order, 'UPS', '1ZG2B7910337737301', 'Store', 'ZEIINPA_US'],
  ];
  const cloudBlob = await SpreadsheetFile.exportXlsx(cloudWorkbook);
  const cloudPath = path.join(temporaryOutputDirectory, 'mixed-carrier.xlsx');
  await fs.writeFile(cloudPath, cloudBlob.data);

  const result = await run({
    source: cloudPath,
    template: templateFixture,
    outDir: temporaryOutputDirectory,
  });

  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].order, order);
  assert.equal(result.orders[0].carrier, 'Fedex / UPS');
  assert.deepEqual(result.orders[0].issues, []);
  assert.equal(
    result.orders[0].trackingNumbers.length,
    2,
  );
  assert.equal(
    buildEmailBody(result.orders[0]),
    'Hi! Your order  114-8138341-3741068 will be delivered in multiple different packages.\n' +
      'Fedex tracking numbers are:\n' +
      '876626526599\n' +
      'UPS tracking numbers are:\n' +
      '1ZG2B7910337737301\n' +
      'Please wait for all the packages to arrive (may arrive separately)\n' +
      'Warmest Regards\n' +
      'Quentin',
  );
  assert.equal((await fs.stat(result.pendingPath)).isFile(), true);
});

async function readFinalTemplateLayout(filePath) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const root = xml2js(sheetXml, { compact: false, nativeType: false }).elements[0];
  const child = (element, name) => (element.elements ?? [])
    .find((item) => item.type === 'element' && item.name === name);
  const rows = (child(root, 'sheetData').elements ?? [])
    .filter((row) => row.type === 'element' && row.name === 'row')
    .map((row) => ({
      attrs: row.attributes,
      cells: (row.elements ?? [])
        .filter((cell) => cell.type === 'element' && cell.name === 'c')
        .map((cell) => ({ r: cell.attributes?.r, s: cell.attributes?.s })),
    }));
  return {
    styles: await zip.file('xl/styles.xml').async('string'),
    dimension: child(root, 'dimension')?.attributes,
    cols: child(root, 'cols')?.elements?.map((column) => column.attributes),
    rows,
  };
}

test('final workbook uses the final email template and changes contents only', async (t) => {
  const temporaryOutputDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'multi-package-test-'),
  );
  t.after(() => fs.rm(temporaryOutputDirectory, { recursive: true, force: true }));

  const cloudStage = await run({
    source: cloudFixture,
    outDir: temporaryOutputDirectory,
  });
  const erpPath = path.join(temporaryOutputDirectory, 'erp.xlsx');
  const erpWorkbook = Workbook.create();
  const erpWorksheet = erpWorkbook.worksheets.add('Export orders');
  erpWorksheet.getRange('A1:B2').values = [
    ['refrence_no', 'consignee_email'],
    [cloudStage.orders[0].order, 'customer@example.com'],
  ];
  const erpBlob = await SpreadsheetFile.exportXlsx(erpWorkbook);
  await fs.writeFile(erpPath, erpBlob.data);

  const finalStage = await run({
    source: cloudFixture,
    erp: erpPath,
    outDir: temporaryOutputDirectory,
    finalTemplate: finalTemplateFixture,
  });
  const finalWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(finalStage.finalPath));
  const finalSheet = finalWorkbook.worksheets.getItem('Sheet1');
  const finalValues = finalSheet.getRange('A1:C3').values;

  assert.deepEqual(finalValues[0], [RECIPIENT, BODY, SENDER]);
  assert.equal(finalValues[1][0], 'customer@example.com');
  assert.equal(finalValues[1][1], buildEmailBody(cloudStage.orders[0]));
  assert.equal(finalValues[1][2], '13288070760@163.com');
  assert.deepEqual(Object.keys(finalStage.sendable[0]).sort(), [
    ORDER,
    RECIPIENT,
    BODY,
    SENDER,
    '来源',
  ].sort());

  const referenceLayout = await readFinalTemplateLayout(finalTemplateFixture);
  const outputLayout = await readFinalTemplateLayout(finalStage.finalPath);
  assert.equal(outputLayout.styles, referenceLayout.styles);
  assert.deepEqual(outputLayout.dimension, referenceLayout.dimension);
  assert.deepEqual(outputLayout.cols, referenceLayout.cols);
  assert.deepEqual(outputLayout.rows, referenceLayout.rows);
});

test('current 86-order cloud file matches 76 ERP rows and fits the final template', async (t) => {
  const temporaryOutputDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'multi-package-current-day-test-'),
  );
  t.after(() => fs.rm(temporaryOutputDirectory, { recursive: true, force: true }));

  const result = await run({
    source: currentCloudFixture,
    erp: currentErpFixture,
    outDir: temporaryOutputDirectory,
  });

  assert.equal(result.orders.length, 86);
  assert.equal(result.sendable.length, 76);
  assert.equal(result.review.length, 10);
  const finalWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(result.finalPath));
  const finalValues = finalWorkbook.worksheets.getItem('Sheet1').getRange('A1:C78').values;
  assert.deepEqual(finalValues[0], [RECIPIENT, BODY, SENDER]);
  assert.equal(finalValues[76][0], result.sendable[75][RECIPIENT]);
  assert.equal(finalValues[76][2], result.sendable[75][SENDER]);
});

test('final workbook extends the template with matching styles beyond its reserved rows', async (t) => {
  const temporaryOutputDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'multi-package-over-capacity-test-'),
  );
  t.after(() => fs.rm(temporaryOutputDirectory, { recursive: true, force: true }));

  const orderCount = 195;
  const cloudWorkbook = Workbook.create();
  const cloudWorksheet = cloudWorkbook.worksheets.add('Shipment');
  const cloudRows = [['Shipment ID', 'Carrier', 'Tracking Number', 'Seller', 'Ship From']];
  for (let index = 0; index < orderCount; index += 1) {
    const order = `111-0000000-${String(index + 1).padStart(7, '0')}`;
    cloudRows.push([order, 'Fedex', `876${String(index).padStart(9, '0')}01`, 'Store', 'VYNELITO_US']);
    cloudRows.push([order, 'Fedex', `876${String(index).padStart(9, '0')}02`, 'Store', 'VYNELITO_US']);
  }
  cloudWorksheet.getRange(`A1:E${cloudRows.length}`).values = cloudRows;
  const cloudBlob = await SpreadsheetFile.exportXlsx(cloudWorkbook);
  const cloudPath = path.join(temporaryOutputDirectory, 'cloud-over-capacity.xlsx');
  await fs.writeFile(cloudPath, cloudBlob.data);

  const erpWorkbook = Workbook.create();
  const erpWorksheet = erpWorkbook.worksheets.add('Export orders');
  const erpRows = [['refrence_no', 'consignee_email']];
  for (let index = 0; index < orderCount; index += 1) {
    erpRows.push([
      `111-0000000-${String(index + 1).padStart(7, '0')}`,
      `customer-${index + 1}@marketplace.amazon.com`,
    ]);
  }
  erpWorksheet.getRange(`A1:B${erpRows.length}`).values = erpRows;
  const erpBlob = await SpreadsheetFile.exportXlsx(erpWorkbook);
  const erpPath = path.join(temporaryOutputDirectory, 'erp-over-capacity.xlsx');
  await fs.writeFile(erpPath, erpBlob.data);

  const result = await run({
    source: cloudPath,
    erp: erpPath,
    template: templateFixture,
    finalTemplate: finalTemplateFixture,
    outDir: temporaryOutputDirectory,
  });

  assert.equal(result.sendable.length, orderCount);
  const finalWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(result.finalPath));
  const finalValues = finalWorkbook.worksheets.getItem('Sheet1').getRange('A1:C196').values;
  assert.deepEqual(finalValues[0], [RECIPIENT, BODY, SENDER]);
  assert.equal(finalValues[195][0], 'customer-195@marketplace.amazon.com');
  const referenceLayout = await readFinalTemplateLayout(finalTemplateFixture);
  const outputLayout = await readFinalTemplateLayout(result.finalPath);
  assert.equal(outputLayout.styles, referenceLayout.styles);
  assert.deepEqual(outputLayout.cols, referenceLayout.cols);
  assert.equal(outputLayout.rows.length, 196);
  assert.equal(outputLayout.rows.at(-1).attrs.ht, '15');
  assert.deepEqual(outputLayout.rows.at(-1).cells.map((cell) => cell.s), [undefined, '1', '2']);
});

test('aggregates repeated order rows and removes duplicate tracking numbers', () => {
  const rows = [
    { order: ' 111-0000000-0000001 ', carrier: 'Fedex', tracking: '876100000001' },
    { order: '111-0000000-0000001', carrier: 'Fedex', tracking: '876100000002' },
    { order: '111-0000000-0000001', carrier: 'Fedex', tracking: '876100000001' },
    { order: '111-0000000-0000002', carrier: 'UPS', tracking: '1Z000000000000001' },
  ];

  assert.deepEqual(aggregateMultiPackageOrders(rows), [
    {
      order: '111-0000000-0000001',
      carrier: 'Fedex',
      trackingNumbers: ['876100000001', '876100000002'],
      trackingGroups: [{ carrier: 'Fedex', trackingNumbers: ['876100000001', '876100000002'] }],
      issues: [],
    },
  ]);
});

test('filters cloud rows to the four allowed sources before aggregation', () => {
  const filteredRows = filterAllowedSourceRows([
    { order: 'KEEP', carrier: 'Fedex', tracking: '876KEEP001', shipFrom: 'VYNELITO_US' },
    { order: 'KEEP', carrier: 'Fedex', tracking: '876DROP001', shipFrom: 'OTHER_US' },
    { order: 'DROP', carrier: 'UPS', tracking: '1ZDROP001', shipFrom: 'OTHER_US' },
  ]);

  assert.deepEqual(filteredRows, [
    { order: 'KEEP', carrier: 'Fedex', tracking: '876KEEP001', shipFrom: 'VYNELITO_US' },
  ]);
  assert.deepEqual(aggregateMultiPackageOrders([
    ...filteredRows,
    { order: 'KEEP', carrier: 'Fedex', tracking: '876KEEP002', shipFrom: 'VYNELITO_US' },
  ])[0].trackingNumbers, ['876KEEP001', '876KEEP002']);
});

test('keeps aggregated orders in first-seen source order and carries the source', () => {
  const orders = aggregateMultiPackageOrders([
    { order: 'B', carrier: 'UPS', tracking: '1ZB1', seller: 'Store B', shipFrom: 'WH-B' },
    { order: 'A', carrier: 'Fedex', tracking: '876A1', seller: 'Store A', shipFrom: 'WH-A' },
    { order: 'B', carrier: 'UPS', tracking: '1ZB2', seller: 'Store B', shipFrom: 'WH-B' },
    { order: 'A', carrier: 'Fedex', tracking: '876A2', seller: 'Store A', shipFrom: 'WH-A' },
  ]);

  assert.deepEqual(orders.map((order) => [order.order, order.seller, order.shipFrom]), [
    ['B', 'Store B', 'WH-B'],
    ['A', 'Store A', 'WH-A'],
  ]);
});

test('builds the first-stage result with reference columns and email template rows', () => {
  const rows = buildCloudResultRows([{
    order: '114-3142381-2979456',
    carrier: 'Fedex',
    seller: 'Store A',
    shipFrom: 'ZEIINPA_US',
    trackingNumbers: ['876035072478', '876035074378'],
    issues: [],
  }]);

  assert.deepEqual(rows.reference[0], [
    '114-3142381-2979456', 'ZEIINPA_US', 'Fedex', '876035072478\n876035074378',
    rows.emailTemplates[0].emailBody,
  ]);
  assert.equal(rows.emailTemplates[0].source, 'ZEIINPA_US');
  assert.match(rows.emailTemplates[0].emailBody, /Fedex tracking numbers are:/);
});

test('exports a reference-shaped workbook with stable order sequence', async (t) => {
  const temporaryOutputDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'multi-package-test-'),
  );
  t.after(() => fs.rm(temporaryOutputDirectory, { recursive: true, force: true }));

  const result = await run({
    source: cloudFixture,
    outDir: temporaryOutputDirectory,
  });
  const referenceWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(
    templateFixture,
  ));
  const outputWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(result.erpOrderListPath));
  const referenceHeaders = referenceWorkbook.worksheets.getItem('Shipment').getUsedRange().values[0];
  const outputShipment = outputWorkbook.worksheets.getItem('Shipment').getUsedRange().values;
  assert.equal(referenceHeaders[0], 'Shipment ID');
  assert.deepEqual(outputShipment[0].slice(0, OUTPUT_HEADERS.length), OUTPUT_HEADERS);
  assert.equal(outputShipment[0].length, OUTPUT_HEADERS.length);
  assert.deepEqual(outputShipment.slice(1, result.orders.length + 1).map((row) => row[0]), result.orders.map((order) => order.order));
  assert.deepEqual(outputShipment[1].slice(0, 5), [
    result.orders[0].order,
    result.orders[0].shipFrom,
    result.orders[0].carrier,
    result.orders[0].trackingNumbers.join('\n'),
    buildEmailBody(result.orders[0]),
  ]);
  assert.equal(outputWorkbook.worksheets.getItem('Shipment').getRange('A1').format.font.name,
    referenceWorkbook.worksheets.getItem('Shipment').getRange('A1').format.font.name);
  assert.equal(outputWorkbook.worksheets.getItem('Shipment').getRange('A1').format.rowHeight,
    referenceWorkbook.worksheets.getItem('Shipment').getRange('A1').format.rowHeight);
  const referenceZip = await JSZip.loadAsync(await fs.readFile(templateFixture));
  const outputZip = await JSZip.loadAsync(await fs.readFile(result.erpOrderListPath));
  assert.equal(
    await outputZip.file('xl/styles.xml').async('string'),
    await referenceZip.file('xl/styles.xml').async('string'),
  );
});

test('does not treat an order with a missing tracking number as sendable', () => {
  const orders = aggregateMultiPackageOrders([
    { order: '111-0000000-0000001', carrier: 'Fedex', tracking: '876100000001' },
    { order: '111-0000000-0000001', carrier: 'Fedex', tracking: '876100000002' },
    { order: '111-0000000-0000001', carrier: 'Fedex', tracking: '' },
  ]);

  const result = matchOrdersToEmails(
    orders,
    [{ order: '111-0000000-0000001', email: 'one@marketplace.amazon.com' }],
  );

  assert.equal(result.sendable.length, 0);
  assert.equal(result.review[0]['\u539f\u56e0'], 'MISSING_TRACKING_NUMBER');
});

test('builds a unique ERP download order list from aggregated multi-package orders', () => {
  const orders = aggregateMultiPackageOrders([
    { order: '111-0000000-0000001', carrier: 'Fedex', tracking: '876100000001' },
    { order: '111-0000000-0000001', carrier: 'Fedex', tracking: '876100000002' },
    { order: '111-0000000-0000001', carrier: 'Fedex', tracking: '876100000002' },
  ]);

  assert.deepEqual(buildErpOrderList(orders), [{ [ORDER]: '111-0000000-0000001' }]);
});

test('builds the exact Fedex and UPS email variants', () => {
  assert.equal(
    buildEmailBody({
      order: '114-3142381-2979456',
      carrier: 'Fedex',
      trackingNumbers: ['876035072478', '876035074378'],
    }),
    'Hi! Your order  114-3142381-2979456 will be delivered in multiple different packages.\n' +
      'Fedex tracking numbers are:\n' +
      '876035072478\n' +
      '876035074378\n' +
      'Please wait for all the packages to arrive (may arrive separately)\n' +
      'Warmest Regards\n' +
      'Quentin',
  );

  assert.match(
    buildEmailBody({
      order: '113-7570342-9534660',
      carrier: 'UPS',
      trackingNumbers: ['1ZXY39070391574044', '1ZXY39070394337054'],
    }),
    /UPS tracking numbers are:/,
  );
});

test('matches a mixed Fedex and UPS order as sendable', () => {
  const order = {
    order: '111-1889031-2796259',
    shipFrom: 'VYNELITO_US',
    carrier: 'Fedex / UPS',
    trackingNumbers: ['876627396600', '876627395041', '1ZW846V10333780841', '1ZW846V10321694234'],
    trackingGroups: [
      { carrier: 'Fedex', trackingNumbers: ['876627396600', '876627395041'] },
      { carrier: 'UPS', trackingNumbers: ['1ZW846V10333780841', '1ZW846V10321694234'] },
    ],
    issues: [],
  };

  const result = matchOrdersToEmails(
    [order],
    [{ order: order.order, email: 'customer@marketplace.amazon.com' }],
  );

  assert.equal(result.review.length, 0);
  assert.equal(result.sendable.length, 1);
  assert.match(result.sendable[0].邮件内容, /Fedex tracking numbers are:[\s\S]+UPS tracking numbers are:/);
});

test('matches one unique ERP email per order and blocks missing or conflicting matches', () => {
  const orders = [
    { order: '111-0000000-0000001', shipFrom: 'VYNELITO_US', carrier: 'Fedex', trackingNumbers: ['876100000001', '876100000002'] },
    { order: '111-0000000-0000002', shipFrom: 'ZEIINPA_US', carrier: 'UPS', trackingNumbers: ['1Z000000000000001', '1Z000000000000002'] },
  ];
  const erpRows = [
    { order: '111-0000000-0000001', email: 'one@marketplace.amazon.com' },
    { order: '111-0000000-0000002', email: '' },
    { order: '111-0000000-0000003', email: 'unused@marketplace.amazon.com' },
  ];

  const result = matchOrdersToEmails(orders, erpRows, '13288070760@163.com');

  assert.equal(result.sendable.length, 1);
  assert.deepEqual(result.sendable[0], {
    [RECIPIENT]: 'one@marketplace.amazon.com',
    [BODY]: buildEmailBody(orders[0]),
    [SENDER]: '13288070760@163.com',
    来源: 'VYNELITO_US',
    [ORDER]: '111-0000000-0000001',
  });
  assert.deepEqual(result.review.map((row) => row['\u539f\u56e0']), ['MISSING_EMAIL']);
});

test('selects the sender mailbox from each order source', () => {
  const sourceOrders = [
    ['VYNELITO_US', '111-0000000-0000001', 'v@marketplace.amazon.com'],
    ['ZEIINPA_US', '111-0000000-0000002', 'z@marketplace.amazon.com'],
    ['XOCN_US', '111-0000000-0000003', 'x@marketplace.amazon.com'],
    ['THRYVIX_US_US', '111-0000000-0000004', 't@marketplace.amazon.com'],
  ].map(([shipFrom, order, email]) => ({
    order,
    shipFrom,
    carrier: 'Fedex',
    trackingNumbers: [`876${order.slice(-7)}1`, `876${order.slice(-7)}2`],
    issues: [],
    email,
  }));
  const result = matchOrdersToEmails(
    sourceOrders,
    sourceOrders.map((order) => ({ order: order.order, email: order.email })),
  );

  assert.deepEqual(result.sendable.map((row) => row[SENDER]), [
    '13288070760@163.com',
    '3777612514@qq.com',
    '15889560452@163.com',
    '17322503251@163.com',
  ]);
});

test('blocks an order when its source has no configured sender mailbox', () => {
  const result = matchOrdersToEmails([
    {
      order: '111-0000000-0000005',
      shipFrom: 'UNKNOWN_US',
      carrier: 'Fedex',
      trackingNumbers: ['876500000001', '876500000002'],
      issues: [],
    },
  ], [{ order: '111-0000000-0000005', email: 'unknown@marketplace.amazon.com' }]);

  assert.equal(result.sendable.length, 0);
  assert.equal(result.review[0]['\u539f\u56e0'], 'SOURCE_SENDER_NOT_CONFIGURED');
});

test('run merges multiple ERP workbooks before matching orders', async (t) => {
  const temporaryOutputDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'multi-package-batch-erp-test-'),
  );
  t.after(() => fs.rm(temporaryOutputDirectory, { recursive: true, force: true }));

  const cloudStage = await run({
    source: cloudFixture,
    outDir: temporaryOutputDirectory,
  });
  const erpPaths = [];
  for (const [index, order] of cloudStage.orders.slice(0, 2).entries()) {
    const erpPath = path.join(temporaryOutputDirectory, `erp-${index + 1}.xlsx`);
    const erpWorkbook = Workbook.create();
    const erpWorksheet = erpWorkbook.worksheets.add('Export orders');
    erpWorksheet.getRange('A1:B2').values = [
      ['refrence_no', 'consignee_email'],
      [order.order, `batch-${index + 1}@marketplace.amazon.com`],
    ];
    const erpBlob = await SpreadsheetFile.exportXlsx(erpWorkbook);
    await fs.writeFile(erpPath, erpBlob.data);
    erpPaths.push(erpPath);
  }

  const result = await run({
    source: cloudFixture,
    erp: erpPaths,
    outDir: temporaryOutputDirectory,
  });

  assert.equal(result.sendable.length, 2);
  assert.deepEqual(result.sendable.map((row) => row['收件邮箱']), [
    'batch-1@marketplace.amazon.com',
    'batch-2@marketplace.amazon.com',
  ]);
});
