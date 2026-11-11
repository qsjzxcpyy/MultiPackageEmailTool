const labels = {pending:'待发送',sending:'发送中',sent:'成功',failed:'失败',uncertain:'待核对'};
const phases = {ready:'待发送',running:'发送中',completed:'本轮已结束',error:'已停止',stopped:'已中断'};

export function filterMailRecords(records, query = '', status = '', source = '') {
  const text = query.trim().toLowerCase();
  return records.filter(row => (!status || (status === 'unsuccessful' ? row.status !== 'sent' : row.status === status))
    && (!source || row.来源 === source)
    && (!text || [row.订单号,row.收件邮箱,row.发件邮箱,row.来源,row.detail].join('\n').toLowerCase().includes(text)));
}
export function visibleMailRecords(records) {
  return records.filter(row => row.status && row.status !== 'pending');
}

export function mountMailPanel() {
  const $ = selector => document.querySelector(selector);
  let batch = null;
  let authorization = {ready:false};
  let token = '';
  let timer;
  let busy = false;
  let refreshPromise;
  let generation = 0;
  let initialized = false;
  let sourceSignature = '';
  let collapsed = false;
  try { collapsed = localStorage.getItem('multi-package-mail-collapsed') === 'true'; } catch {}
  const rows = new Map();
  const tbody = $('#mail-records');
  const text = (element,value) => { const next = String(value ?? ''); if (element.textContent !== next) element.textContent = next; };
  const feedback = (message,error=false) => {
    text($('#mail-message'),message);
    $('#mail-message').hidden = !message;
    $('#mail-message').classList.toggle('message-error',error);
  };
  async function api(route,options) {
    const response = await fetch(route,options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || '发送记录读取失败');
    return data;
  }
  async function session() { ({token} = await api('/api/mail/session')); return token; }

  function applyCollapse() {
    $('#mail-table-wrap').hidden = collapsed;
    text($('#mail-list-toggle-button'),collapsed ? '展开订单列表' : '折叠订单列表');
    $('#mail-list-toggle-button').setAttribute('aria-expanded',String(!collapsed));
  }
  function renderAuthorization() {
    text($('#mail-auth-name'),authorization.ready ? '默认授权码已选中' : '未找到授权码文件');
    text($('#mail-auth-description'),authorization.ready ? `${authorization.filename} · ${authorization.senderCount} 个发件邮箱` : '上传一次，后续自动使用');
    $('#mail-authorization').classList.toggle('is-ready',authorization.ready);
    text($('#mail-auth-change-label'),authorization.ready ? '更换授权码' : '上传授权码');
    $('#mail-auth-file').disabled = busy || batch?.phase === 'running';
    $('#mail-auth-change').classList.toggle('is-disabled',$('#mail-auth-file').disabled);
  }
  function updateSources() {
    const sources = [...new Set((batch?.records || []).map(row => row.来源).filter(Boolean))];
    const signature = JSON.stringify(sources);
    if (sourceSignature === signature) return;
    sourceSignature = signature;
    const select = $('#mail-source-filter');
    const value = select.value;
    select.replaceChildren(new Option('全部来源',''));
    for (const source of sources) select.add(new Option(source,source));
    select.value = sources.includes(value) ? value : '';
  }
  function cell(row,label,className='') {
    const element = document.createElement('td');
    element.dataset.label = label;
    element.className = className;
    row.append(element);
    return element;
  }
  function createRow(record,key,animate) {
    const row = document.createElement('tr');
    row.dataset.key = key;
    if (animate) row.className = 'mail-row-enter';
    row.addEventListener('animationend',() => row.classList.remove('mail-row-enter'),{once:true});
    const order = cell(row,'订单号');
    const number = document.createElement('div'); number.className = 'mono'; number.textContent = record.订单号;
    const recipient = document.createElement('small'); recipient.className = 'mail-address'; recipient.textContent = record.收件邮箱;
    order.append(number,recipient);
    cell(row,'来源').textContent = record.来源;
    const status = cell(row,'发送状态');
    const badge = document.createElement('span'); status.append(badge);
    const content = cell(row,'邮件内容');
    const details = document.createElement('details'); details.className = 'email-preview';
    const summary = document.createElement('summary'); summary.textContent = '查看邮件内容';
    const pre = document.createElement('pre'); pre.textContent = record.邮件内容;
    details.append(summary,pre);
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'button button-quiet mail-copy'; copy.textContent = '复制内容';
    copy.addEventListener('click',async () => {
      try { await navigator.clipboard.writeText(record.邮件内容); feedback(`已复制订单 ${record.订单号} 的邮件内容。`); }
      catch { feedback('复制失败，请展开邮件内容手动复制。',true); }
    });
    content.append(details,copy);
    const result = cell(row,'结果说明');
    const detail = document.createElement('div');
    const sender = document.createElement('small'); sender.className = 'mail-address'; sender.textContent = `发件：${record.发件邮箱}`;
    result.append(detail,sender);
    return {row,badge,detail};
  }
  function renderRows(animate=false) {
    const visible = visibleMailRecords(batch?.records || []);
    const filtered = new Set(filterMailRecords(visible,$('#mail-search').value,$('#mail-status-filter').value,$('#mail-source-filter').value));
    text($('#mail-row-count'),`${filtered.size} / ${visible.length} 条记录`);
    for (const [index,record] of (batch?.records || []).entries()) {
      if (record.status === 'pending') continue;
      const key = `${index}:${record.订单号}`;
      let view = rows.get(key);
      if (!view) {
        tbody.querySelector('.mail-empty')?.remove();
        view = createRow(record,key,animate);
        rows.set(key,view);
        tbody.append(view.row);
      }
      view.row.hidden = !filtered.has(record);
      const badgeClass = `delivery-badge delivery-${record.status}`;
      if (view.badge.className !== badgeClass) view.badge.className = badgeClass;
      text(view.badge,labels[record.status]);
      text(view.detail,(record.detail || '') + (record.attempts ? `（尝试 ${record.attempts} 次）` : ''));
    }
    let empty = tbody.querySelector('.mail-empty');
    if (!filtered.size) {
      if (!empty) {
        empty = document.createElement('tr'); empty.className = 'mail-empty';
        const td = document.createElement('td'); td.colSpan = 5; td.className = 'empty-cell'; empty.append(td); tbody.append(empty);
      }
      text(empty.firstChild,visible.length ? '没有符合筛选条件的发送记录。' : batch?.phase === 'running'
        ? '正在准备发送，记录将逐条出现…' : batch ? '点击发送后，订单将按发送进度逐条显示。' : '请先上传云仓和 ERP 文件，生成本次邮件。');
    } else empty?.remove();
    applyCollapse();
  }
  function render(animate=false) {
    const counts = batch?.counts;
    const running = batch?.phase === 'running';
    $('#mail-send-button').disabled = busy || !authorization.ready || !batch || running || (!counts.pending && !counts.failed);
    text($('#mail-send-button'),running ? '正在发送…' : (counts?.sent || counts?.failed || counts?.uncertain) ? '重试未成功邮件' : '发送邮件');
    text($('#mail-phase'),batch ? phases[batch.phase] || batch.phase : '等待生成邮件');
    for (const status of ['total','sent','failed','uncertain']) text($(`#mail-count-${status}`),counts?.[status] || 0);
    const done = counts ? counts.sent + counts.failed + counts.uncertain : 0;
    $('#mail-progress').max = counts?.total || 1;
    $('#mail-progress').value = done;
    text($('#mail-progress-label'),counts ? `已处理 ${done} / ${counts.total} 条` : '等待生成最终邮件数据');
    const current = batch?.records.find(row => row.status === 'sending');
    $('#mail-activity').classList.toggle('is-sending',Boolean(running));
    text($('#mail-activity-text'),running ? current ? `正在发送订单 ${current.订单号}` : '正在准备邮件…'
      : counts ? `待发送 ${counts.pending} 条${counts.sending ? ` · 发送中 ${counts.sending} 条` : ''}` : '生成后可直接发送');
    text($('#mail-task-error'),batch?.error || '');
    $('#mail-task-error').hidden = !batch?.error;
    renderAuthorization(); updateSources(); renderRows(animate);
  }
  function accept(data,animate=false) {
    if (batch?.id !== data?.id) {
      tbody.replaceChildren(); rows.clear();
      feedback('');
    }
    batch = data;
    render(animate);
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { await refresh(); }
      catch (error) { feedback(`${error.message}；正在重新连接。`,true); }
      schedule();
    },batch?.phase === 'running' ? 600 : 5000);
  }
  async function refresh() {
    if (refreshPromise) return refreshPromise;
    const revision = generation;
    const selected = batch?.id;
    refreshPromise = (async () => {
      const credentials = await api('/api/mail/credentials');
      let data;
      if (selected) data = await api(`/api/mail/batches/${selected}`);
      else if (!initialized) {
        const {batches} = await api('/api/mail/batches');
        // Only an active send belongs on a fresh page. Persisted idle history
        // is reused when matching ERP data is generated, never selected here.
        const running = batches.find(item => item.phase === 'running');
        if (running) data = await api(`/api/mail/batches/${running.id}`);
      }
      if (revision !== generation) return;
      authorization = credentials;
      initialized = true;
      if (data) accept(data,true); else render();
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  $('#mail-list-toggle-button').addEventListener('click',() => {
    collapsed = !collapsed;
    try { localStorage.setItem('multi-package-mail-collapsed',String(collapsed)); } catch {}
    applyCollapse();
  });
  $('#mail-search').addEventListener('input',() => renderRows());
  $('#mail-status-filter').addEventListener('change',() => renderRows());
  $('#mail-source-filter').addEventListener('change',() => renderRows());
  $('#mail-auth-file').addEventListener('change',async event => {
    const file = event.target.files[0];
    if (!file || busy) return;
    busy = true; generation++; render();
    try {
      await session();
      authorization = await api('/api/mail/credentials',{method:'POST',headers:{'X-Mail-Token':token,'X-Filename':encodeURIComponent(file.name)},body:file});
      feedback('授权码已保存，之后发送自动使用此文件。');
    } catch (error) { feedback(error.message,true); }
    finally { event.target.value = ''; busy = false; render(); }
  });
  $('#mail-send-button').addEventListener('click',async () => {
    if (!batch || !authorization.ready || busy || batch.phase === 'running') return;
    const selected = batch.id;
    const revision = ++generation;
    busy = true; render();
    try {
      await session();
      if (revision !== generation || batch?.id !== selected) {
        feedback('邮件数据已更新，请核对后重新点击发送。');
        return;
      }
      const result = await api(`/api/mail/batches/${selected}/send`,{method:'POST',headers:{'X-Mail-Token':token}});
      if (revision !== generation || batch?.id !== selected) return;
      accept(result);
      feedback('');
      schedule();
    } catch (error) { feedback(error.message,true); }
    finally { busy = false; render(); }
  });
  refresh().catch(error => feedback(error.message,true)).finally(schedule);
  render();
  return {setData(data) {
    generation++; initialized = true;
    if (!data && batch?.phase === 'running') return;
    accept(data); schedule();
  }};
}
