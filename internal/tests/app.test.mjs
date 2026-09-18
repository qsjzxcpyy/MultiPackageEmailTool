import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOrderNumberClipboardText,
  filterRows,
  filterRowsBySource,
  getCopySuccessFeedback,
  hasDownload,
} from '../../web/app.js';

test('filterRows searches across operational preview fields without changing row order', () => {
  const rows = [
    { order: '114-3142381-2979456', carrier: 'Fedex', email: 'one@example.com', emailBody: '876035072478' },
    { order: '113-7570342-9534660', carrier: 'UPS', email: '', reason: 'MISSING_EMAIL', emailBody: '1ZXY3907' },
  ];

  assert.deepEqual(filterRows(rows, '1zxy'), [rows[1]]);
  assert.deepEqual(filterRows(rows, 'FEDEX'), [rows[0]]);
  assert.deepEqual(filterRows(rows, ''), rows);
});

test('hasDownload only enables links for server-provided URLs', () => {
  assert.equal(hasDownload('/api/download/abc'), true);
  assert.equal(hasDownload(''), false);
  assert.equal(hasDownload(null), false);
});

test('filterRowsBySource keeps only the selected source without changing order', () => {
  const rows = [
    { order: 'B', source: 'ZEIINPA_US' },
    { order: 'A', source: 'VYNELITO_US' },
    { order: 'C', source: 'ZEIINPA_US' },
  ];

  assert.deepEqual(filterRowsBySource(rows, 'source', 'ZEIINPA_US'), [rows[0], rows[2]]);
  assert.deepEqual(filterRowsBySource(rows, 'source', ''), rows);
});

test('buildOrderNumberClipboardText deduplicates order numbers while preserving filtered row order', () => {
  const rows = [
    { order: '111-0000001-0000001' },
    { order: ' 222-0000002-0000002 ' },
    { order: '111-0000001-0000001' },
    { order: '' },
    { order: null },
    { order: '333-0000003-0000003' },
  ];

  assert.equal(
    buildOrderNumberClipboardText(rows),
    '111-0000001-0000001 222-0000002-0000002 333-0000003-0000003',
  );
  assert.equal(buildOrderNumberClipboardText([]), '');
});

test('getCopySuccessFeedback gives the user the copied order count in both feedback locations', () => {
  assert.deepEqual(getCopySuccessFeedback(7), {
    buttonText: '已复制 7 个订单号',
    statusText: '已复制 7 个订单号，可直接粘贴到 ERP。',
  });
});
