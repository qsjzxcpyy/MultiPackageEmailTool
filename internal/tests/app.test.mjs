import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOrderNumberClipboardText,
  filterRows,
  filterRowsBySource,
  getCopySuccessFeedback,
  getListCollapsePresentation,
  hasDownload,
} from '../../web/app.js';

test('filterRows searches across operational preview fields without changing row order', () => {
  const rows = [
    { order: '114-0000000-0000023', carrier: 'Fedex', email: 'one@example.com', emailBody: '990000000004' },
    { order: '113-0000000-0000019', carrier: 'UPS', email: '', reason: 'MISSING_EMAIL', emailBody: '1ZXY3907' },
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
    { order: 'B', source: 'DEMOD_US' },
    { order: 'A', source: 'DEMOC_US' },
    { order: 'C', source: 'DEMOD_US' },
  ];

  assert.deepEqual(filterRowsBySource(rows, 'source', 'DEMOD_US'), [rows[0], rows[2]]);
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


test('getListCollapsePresentation keeps the toggle label and aria state in sync', () => {
  assert.deepEqual(getListCollapsePresentation(false), {
    hidden: false,
    buttonText: '折叠订单列表',
    ariaExpanded: 'true',
  });
  assert.deepEqual(getListCollapsePresentation(true), {
    hidden: true,
    buttonText: '展开订单列表',
    ariaExpanded: 'false',
  });
});
