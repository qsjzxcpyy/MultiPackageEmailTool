const state = {
  stage: 'idle',
  cloud: null,
  erp: null,
  cloudSourceFilter: '',
  resultSourceFilter: '',
  resultMode: 'sendable',
  cloudListCollapsed: false,
  resultListCollapsed: false,
};

const MAX_ERP_FILES = 2;
const COPY_BUTTON_DEFAULT_TEXT = '\u4e00\u952e\u590d\u5236\u8ba2\u5355\u53f7';
const COPY_FEEDBACK_DURATION_MS = 2500;
let copyFeedbackTimer = null;
const $ = (selector) => document.querySelector(selector);

export function filterRows(rows, query) {
  const normalizedQuery = String(query ?? '').trim().toLocaleLowerCase();
  if (!normalizedQuery) return rows;
  return rows.filter((row) => Object.values(row)
    .flat(Infinity)
    .map((value) => String(value ?? ''))
    .join('\n')
    .toLocaleLowerCase()
    .includes(normalizedQuery));
}

export function filterRowsBySource(rows, sourceKey, source) {
  const normalizedSource = String(source ?? '').trim();
  if (!normalizedSource) return rows;
  return rows.filter((row) => String(row?.[sourceKey] ?? '').trim() === normalizedSource);
}

export function buildOrderNumberClipboardText(rows, orderKey = 'order') {
  const seen = new Set();
  const orderNumbers = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const orderNumber = String(row?.[orderKey] ?? '').trim();
    if (!orderNumber || seen.has(orderNumber)) continue;
    seen.add(orderNumber);
    orderNumbers.push(orderNumber);
  }
  return orderNumbers.join(' ');
}

export function getCopySuccessFeedback(orderCount) {
  const count = Number.isFinite(Number(orderCount)) ? Number(orderCount) : 0;
  return {
    buttonText: `\u5df2\u590d\u5236 ${count} \u4e2a\u8ba2\u5355\u53f7`,
    statusText: `\u5df2\u590d\u5236 ${count} \u4e2a\u8ba2\u5355\u53f7，\u53ef\u76f4\u63a5\u7c98\u8d34\u5230 ERP\u3002`,
  };
}

export function getListCollapsePresentation(collapsed) {
  const isCollapsed = Boolean(collapsed);
  return {
    hidden: isCollapsed,
    buttonText: isCollapsed ? '展开订单列表' : '折叠订单列表',
    ariaExpanded: String(!isCollapsed),
  };
}

export function hasDownload(url) {
  return typeof url === 'string' && url.length > 0;
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value == null ? '' : String(value);
}

function showMessage(selector, message) {
  const element = $(selector);
  element.textContent = message || '';
  element.hidden = !message;
}

function setStatus(message) {
  showMessage('#status-message', message);
  if (message) showMessage('#error-message', '');
}

function setError(message) {
  showMessage('#error-message', message);
  if (message) showMessage('#status-message', '');
}

function setBusy(button, busy, busyText) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText || button.textContent;
  }
}

async function upload(endpoint, file) {
  const files = Array.isArray(file) ? file : [file];
  const isMultipart = endpoint === '/api/erp' || files.length > 1;
  const headers = {};
  let body = files[0];
  if (isMultipart) {
    const formData = new FormData();
    files.forEach((item) => formData.append('files', item, item.name));
    body = formData;
  } else {
    headers['Content-Type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    headers['X-Filename'] = files[0].name;
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error('服务器返回了无法读取的结果。');
  }
  if (!response.ok) {
    throw new Error(payload?.error?.message || '文件处理失败，请检查文件内容后重试。');
  }
  return payload;
}

function setStage(stage, stateName) {
  const labels = {
    idle: '等待云仓文件',
    cloud: '云仓已处理',
    erp: '匹配已完成',
  };
  setText('#run-state', labels[stateName] || labels.idle);
  const stageOrder = ['cloud', 'order-list', 'erp', 'result'];
  const activeIndex = stageOrder.indexOf(stage);
  document.querySelectorAll('.stage-item').forEach((item) => {
    const active = item.dataset.stage === stage;
    const itemIndex = stageOrder.indexOf(item.dataset.stage);
    item.classList.toggle('is-active', active);
    item.classList.toggle('is-complete', activeIndex > 0 && itemIndex >= 0 && itemIndex < activeIndex);
  });
}

function makeCell(value, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = value == null ? '' : String(value);
  return cell;
}

function makeEmailCell(body) {
  const cell = document.createElement('td');
  const details = document.createElement('details');
  details.className = 'email-preview';
  const summary = document.createElement('summary');
  summary.textContent = '查看邮件内容';
  const pre = document.createElement('pre');
  pre.textContent = body || '';
  details.append(summary, pre);
  cell.append(details);
  return cell;
}

function renderTable(container, columns, rows, emptyMessage) {
  container.textContent = '';
  const table = document.createElement('table');
  table.className = 'data-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach((column) => headRow.append(makeCell(column.label)));
  thead.append(headRow);
  table.append(thead);
  const tbody = document.createElement('tbody');
  if (!rows.length) {
    const emptyRow = document.createElement('tr');
    const emptyCell = makeCell(emptyMessage);
    emptyCell.colSpan = columns.length;
    emptyCell.className = 'empty-cell';
    emptyRow.append(emptyCell);
    tbody.append(emptyRow);
  } else {
    rows.forEach((row) => {
      const tableRow = document.createElement('tr');
      columns.forEach((column) => {
        if (column.kind === 'email') tableRow.append(makeEmailCell(row[column.key]));
        else tableRow.append(makeCell(column.format ? column.format(row) : row[column.key], column.className));
      });
      tbody.append(tableRow);
    });
  }
  table.append(tbody);
  container.append(table);
}

function statCard(label, value, tone = '') {
  const card = document.createElement('div');
  card.className = `stat-card ${tone}`.trim();
  const valueElement = document.createElement('strong');
  valueElement.textContent = value == null ? '0' : String(value);
  const labelElement = document.createElement('span');
  labelElement.textContent = label;
  card.append(valueElement, labelElement);
  return card;
}

function renderCloud(data) {
  const stats = data.stats || {};
  const statsElement = $('#cloud-stats');
  statsElement.textContent = '';
  statsElement.append(
    statCard('多包裹订单', stats.multiPackageOrders, 'stat-blue'),
    statCard('两包裹订单', stats.twoPackageOrders),
    statCard('三包裹订单', stats.threePackageOrders),
    statCard('物流号总数', stats.totalTrackingNumbers),
  );
  setSourceFilterOptions('#cloud-source-filter', data.preview || [], 'source', state.cloudSourceFilter);
  renderCloudRows();
  $('#cloud-output').hidden = false;
}

function setSourceFilterOptions(selector, rows, sourceKey, selectedValue = '') {
  const select = $(selector);
  if (!select) return;
  const sources = [];
  for (const row of rows) {
    const source = String(row?.[sourceKey] ?? '').trim();
    if (source && !sources.includes(source)) sources.push(source);
  }
  select.textContent = '';
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = '全部来源';
  select.append(allOption);
  for (const source of sources) {
    const option = document.createElement('option');
    option.value = source;
    option.textContent = source;
    select.append(option);
  }
  select.value = sources.includes(selectedValue) ? selectedValue : '';
}

function setCloudCopyButton(rows) {
  const button = $('#cloud-copy-orders-button');
  if (!button) return;
  if (copyFeedbackTimer) {
    clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = null;
  }
  button.classList.remove('is-copy-success');
  button.removeAttribute('aria-label');
  button.textContent = button.dataset.defaultText || COPY_BUTTON_DEFAULT_TEXT;
  button.disabled = !buildOrderNumberClipboardText(rows);
}

function showCopySuccessFeedback(orderCount) {
  const button = $('#cloud-copy-orders-button');
  const feedback = getCopySuccessFeedback(orderCount);
  if (!button) return;

  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
  button.disabled = false;
  button.classList.add('is-copy-success');
  button.textContent = feedback.buttonText;
  button.setAttribute('aria-label', feedback.buttonText);
  copyFeedbackTimer = setTimeout(() => {
    button.classList.remove('is-copy-success');
    button.removeAttribute('aria-label');
    button.textContent = button.dataset.defaultText || COPY_BUTTON_DEFAULT_TEXT;
    copyFeedbackTimer = null;
  }, COPY_FEEDBACK_DURATION_MS);
}

async function handleCopyCloudOrders() {
  const rows = state.cloud
    ? filterRowsBySource(state.cloud.preview || [], 'source', state.cloudSourceFilter)
    : [];
  const orderText = buildOrderNumberClipboardText(rows);
  if (!orderText) {
    setError('当前没有可复制的订单号。');
    return;
  }
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    setError('当前 Chrome 不支持剪贴板复制，请检查浏览器版本或权限设置。');
    return;
  }
  try {
    await navigator.clipboard.writeText(orderText);
    showCopySuccessFeedback(orderText.split(' ').length);
    setStatus('已复制 ' + orderText.split(' ').length + ' 个订单号，可直接粘贴到 ERP。');
  } catch {
    setError('复制订单号失败，请允许本地页面使用剪贴板后重试。');
  }
}

function applyListCollapse(tableSelector, buttonSelector, collapsed) {
  const table = $(tableSelector);
  const button = $(buttonSelector);
  const presentation = getListCollapsePresentation(collapsed);
  if (!table || !button) return;
  table.hidden = presentation.hidden;
  button.textContent = presentation.buttonText;
  button.setAttribute('aria-expanded', presentation.ariaExpanded);
  button.setAttribute('aria-label', presentation.buttonText);
}

function renderCloudRows() {
  if (!state.cloud) return;
  const rows = filterRowsBySource(state.cloud.preview || [], 'source', state.cloudSourceFilter);
  setCloudCopyButton(rows);
  setText('#cloud-row-count', `${rows.length} / ${state.cloud.preview?.length || 0} 条记录`);
  renderTable($('#cloud-table-wrap'), [
    { label: '订单号', key: 'order', className: 'mono' },
    { label: '来源', key: 'source' },
    { label: '物流类型', key: 'carrier' },
    { label: '物流号', key: 'trackingNumbers', format: (row) => row.trackingNumbers.join('\n'), className: 'mono tracking-list' },
    { label: '邮件内容', key: 'emailBody', kind: 'email' },
  ], rows, '没有符合当前来源的多包裹订单。');
  applyListCollapse('#cloud-table-wrap', '#cloud-list-toggle-button', state.cloudListCollapsed);
}

function renderResultRows() {
  if (!state.erp) return;
  const rows = state.resultMode === 'review' ? state.erp.review : state.erp.sendable;
  const sourceRows = filterRowsBySource(rows, '来源', state.resultSourceFilter);
  const filteredRows = filterRows(sourceRows, $('#result-search').value);
  setText('#result-list-title', state.resultMode === 'review' ? '人工复核记录' : '可发送记录');
  setText('#result-row-count', `${filteredRows.length} 条记录`);
  const columns = state.resultMode === 'review'
    ? [
      { label: '订单号', key: '订单号', className: 'mono' },
      { label: '承运商', key: '承运商' },
      { label: '物流号列表', key: '物流号列表', className: 'mono tracking-list' },
      { label: '原因', key: '原因', className: 'reason' },
      { label: 'ERP 邮箱', key: 'ERP邮箱' },
    ]
    : [
      { label: '订单号', key: '订单号', className: 'mono' },
      { label: '来源', key: '来源' },
      { label: '收件邮箱', key: '收件邮箱' },
      { label: '邮件内容', key: '邮件内容', kind: 'email' },
      { label: '发件邮箱', key: '发件邮箱' },
    ];
  renderTable($('#result-table-wrap'), columns, filteredRows, state.resultMode === 'review' ? '没有需要人工复核的记录。' : '没有可发送记录。');
  setText('#result-row-count', `${filteredRows.length} 条记录`);
  applyListCollapse('#result-table-wrap', '#result-list-toggle-button', state.resultListCollapsed);
}

function renderResult(data) {
  state.erp = data;
  const stats = data.stats || {};
  const statsElement = $('#result-stats');
  statsElement.textContent = '';
  statsElement.append(
    statCard('可发送记录', stats.sendableRows, 'stat-green'),
    statCard('人工复核', stats.reviewRows, 'stat-amber'),
  );
  setText('#sendable-tab-count', stats.sendableRows);
  setText('#review-tab-count', stats.reviewRows);
  setDownload('#final-download', data.downloads?.final);
  setDownload('#review-download', data.downloads?.review);
  setSourceFilterOptions(
    '#result-source-filter',
    [...(data.sendable || []), ...(data.review || [])],
    '来源',
    state.resultSourceFilter,
  );
  $('#result-output').hidden = false;
  renderResultRows();
}

function setDownload(selector, url) {
  const button = $(selector);
  button.disabled = !hasDownload(url);
  button.dataset.url = hasDownload(url) ? url : '';
}

function downloadFrom(button) {
  if (!button.disabled && button.dataset.url) window.location.href = button.dataset.url;
}

function setCloudReady(ready) {
  $('#erp-stage').setAttribute('aria-disabled', String(!ready));
  $('#erp-file').disabled = !ready;
  $('#erp-upload-button').disabled = !ready || !$('#erp-file').files.length;
  $('#erp-stage').classList.toggle('stage-panel-muted', !ready);
  setText('#erp-state', ready ? '可上传' : '锁定');
}

function setFileLabel(input, labelSelector, buttonSelector) {
  const files = Array.from(input.files || []);
  const tooMany = input.id === 'erp-file' && files.length > MAX_ERP_FILES;
  if (input.multiple && files.length > 1) {
    setText(labelSelector, `${files.length} 个文件：${files.map((file) => file.name).join('、')}`);
  } else {
    setText(labelSelector, files[0] ? files[0].name : '未选择文件');
  }
  if (tooMany) setError(`ERP 文件最多选择 ${MAX_ERP_FILES} 个。`);
  const button = $(buttonSelector);
  button.disabled = !files.length || tooMany || (input.id === 'erp-file' && !state.cloud);
}

function resetApp() {
  state.stage = 'idle';
  state.cloud = null;
  state.erp = null;
  state.cloudSourceFilter = '';
  state.resultSourceFilter = '';
  state.resultMode = 'sendable';
  state.cloudListCollapsed = false;
  state.resultListCollapsed = false;
  $('#cloud-file').value = '';
  $('#erp-file').value = '';
  setText('#cloud-file-name', '未选择文件');
  setText('#erp-file-name', '未选择文件');
  $('#cloud-output').hidden = true;
  $('#result-output').hidden = true;
  $('#result-search').value = '';
  $('#cloud-source-filter').value = '';
  $('#result-source-filter').value = '';
  setCloudCopyButton([]);
  applyListCollapse('#cloud-table-wrap', '#cloud-list-toggle-button', false);
  applyListCollapse('#result-table-wrap', '#result-list-toggle-button', false);
  setCloudReady(false);
  setDownload('#erp-order-list-download', '');
  setDownload('#final-download', '');
  setDownload('#review-download', '');
  setText('#cloud-state', '待处理');
  setText('#order-list-state', '等待上一步');
  setText('#result-state', '锁定');
  setStage('cloud', 'idle');
  setError('');
  setStatus('已清空本轮数据，可以上传新的云仓文件。');
}

async function handleCloudUpload() {
  const file = $('#cloud-file').files[0];
  if (!file) return;
  const button = $('#cloud-upload-button');
  setBusy(button, true, '处理中…');
  setStatus('正在读取云仓文件并聚合多包裹订单…');
  try {
    const data = await upload('/api/cloud', file);
    state.cloud = data;
    state.stage = 'cloud';
    renderCloud(data);
    setCloudReady(true);
    setDownload('#erp-order-list-download', data.downloads?.erpOrderList);
    setText('#cloud-state', '已完成');
    setText('#order-list-state', '可下载');
    setStage('erp', 'cloud');
    setStatus(`云仓处理完成：识别到 ${data.stats.multiPackageOrders} 个多包裹订单。`);
  } catch (error) {
    setError(error.message || '云仓文件处理失败。');
  } finally {
    setBusy(button, false, '处理云仓文件');
    button.disabled = !$('#cloud-file').files.length;
  }
}

async function handleErpUpload() {
  const files = Array.from($('#erp-file').files || []);
  if (!files.length || files.length > MAX_ERP_FILES || !state.cloud) return;
  const button = $('#erp-upload-button');
  setBusy(button, true, '匹配中…');
  setStatus('正在按订单号匹配 ERP 邮箱并生成结果…');
  try {
    const data = await upload('/api/erp', files);
    state.stage = 'erp';
    renderResult(data);
    setText('#erp-state', '已完成');
    setText('#result-state', '已生成');
    $('#result-stage').classList.remove('stage-panel-muted');
    $('#result-stage').setAttribute('aria-disabled', 'false');
    setStage('result', 'erp');
    setStatus(`匹配完成：${data.stats.sendableRows} 条可发送，${data.stats.reviewRows} 条需人工复核。`);
  } catch (error) {
    setError(error.message || 'ERP 文件处理失败。');
  } finally {
    setBusy(button, false, '匹配 ERP 文件');
    button.disabled = !$('#erp-file').files.length
      || $('#erp-file').files.length > MAX_ERP_FILES
      || !state.cloud;
  }
}

function setResultMode(mode) {
  state.resultMode = mode;
  $('#sendable-tab').classList.toggle('is-selected', mode === 'sendable');
  $('#review-tab').classList.toggle('is-selected', mode === 'review');
  $('#sendable-tab').setAttribute('aria-selected', String(mode === 'sendable'));
  $('#review-tab').setAttribute('aria-selected', String(mode === 'review'));
  renderResultRows();
}

if (typeof document !== 'undefined') {
  $('#cloud-file').addEventListener('change', (event) => setFileLabel(event.target, '#cloud-file-name', '#cloud-upload-button'));
  $('#erp-file').addEventListener('change', (event) => setFileLabel(event.target, '#erp-file-name', '#erp-upload-button'));
  $('#cloud-upload-button').addEventListener('click', handleCloudUpload);
  $('#cloud-copy-orders-button').addEventListener('click', handleCopyCloudOrders);
  $('#cloud-list-toggle-button').addEventListener('click', () => {
    state.cloudListCollapsed = !state.cloudListCollapsed;
    applyListCollapse('#cloud-table-wrap', '#cloud-list-toggle-button', state.cloudListCollapsed);
  });
  $('#result-list-toggle-button').addEventListener('click', () => {
    state.resultListCollapsed = !state.resultListCollapsed;
    applyListCollapse('#result-table-wrap', '#result-list-toggle-button', state.resultListCollapsed);
  });
  $('#erp-upload-button').addEventListener('click', handleErpUpload);
  $('#reset-button').addEventListener('click', resetApp);
  $('#result-search').addEventListener('input', renderResultRows);
  $('#cloud-source-filter').addEventListener('change', (event) => {
    state.cloudSourceFilter = event.target.value;
    renderCloudRows();
  });
  $('#result-source-filter').addEventListener('change', (event) => {
    state.resultSourceFilter = event.target.value;
    renderResultRows();
  });
  $('#sendable-tab').addEventListener('click', () => setResultMode('sendable'));
  $('#review-tab').addEventListener('click', () => setResultMode('review'));
  ['#erp-order-list-download', '#final-download', '#review-download'].forEach((selector) => {
    $(selector).addEventListener('click', (event) => downloadFrom(event.currentTarget));
  });

  setCloudReady(false);
}
