'use strict';

/* AI 签到管理台前端（原生 JS，无依赖）
 * 两级视图：渠道卡片网格 →（点击下钻）渠道详情（账号子卡片 + 操作） */

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

let toastTimer = null;
function toast(msg, isError) {
  let el = $('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 3000);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

// ---- 状态 ---------------------------------------------------------------------

let tools = [];            // [{ key, name, accounts: publicView[] }]
let credits = null;        // { tools:[{key,name,total,accounts}], total, fetchedAt }
let lastRunResults = [];
let view = { level: 'grid', toolKey: null }; // 视图状态机：grid | tool
let pollTimer = null;

// ---- 格式化 -------------------------------------------------------------------

/** ISO 时间 → 本地「YYYY-MM-DD HH:mm」；无效/缺失返回空串 */
function fmtTime(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 剩余天数 + 到期时刻的说明文字 */
function expireText(days, iso) {
  const when = fmtTime(iso);
  if (days === null || days === undefined) return when ? `到期 ${when}` : '未知';
  if (days > 0) return `剩 ${days} 天 · ${when || '到期时间未知'}`;
  return when ? `已过期（${when}）` : '已过期';
}

/** 积分数值展示：保留 2 位小数 + 千分位；无值显示「—」 */
function fmtCredits(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function tokenDaysHtml(days) {
  if (days === null || days === undefined) return '<span class="token-days">token 有效期未知</span>';
  const cls = days < 3 ? 'crit' : days < 7 ? 'warn' : 'ok';
  const text = days > 0 ? `token 剩 ${days} 天` : 'token 已过期（签到时自动续期）';
  return `<span class="token-days ${cls}">${esc(text)}</span>`;
}

function kv(label, value, cls) {
  return `<div class="kv"><dt>${esc(label)}</dt><dd class="${cls || ''}">${esc(value)}</dd></div>`;
}

function metaRow(label, value, cls) {
  return `<div class="meta-row"><span class="meta-label">${esc(label)}</span><span class="meta-val ${cls || ''}">${esc(value)}</span></div>`;
}

function initial(name) {
  return String(name || '?').trim().charAt(0).toUpperCase() || '?';
}

// ---- 数据聚合（卡片摘要用） ---------------------------------------------------

function getTool(key) {
  return tools.find((t) => t.key === key) || null;
}

function creditsToolOf(key) {
  return ((credits && credits.tools) || []).find((t) => t.key === key) || null;
}

function accountCredit(toolKey, name) {
  const ct = creditsToolOf(toolKey);
  const row = ct && ct.accounts.find((a) => a.name === name);
  return row || { ok: false, credits: null, msg: '积分未查询' };
}

/** 卡片内账号积分单元格：区分「加载中 / 已取到 / 查询失败」三态 */
function accountCreditCell(toolKey, name) {
  if (!credits) return { text: '…', cls: 'loading', title: '积分加载中' };
  const row = accountCredit(toolKey, name);
  if (row.ok) return { text: fmtCredits(row.credits), cls: '', title: '' };
  return { text: '—', cls: 'na', title: row.msg || '积分查询失败' };
}

function lastResultKv(toolKey, name) {
  const r = lastRunResults.find((x) => x.tool === toolKey && x.name === name);
  if (!r) return kv('最近签到', '暂无记录');
  return kv('最近签到', `${r.ok ? '✅' : '❌'} ${r.msg}（${(r.at || '').replace('T', ' ').slice(5, 16)}）`, r.ok ? 'ok' : 'fail');
}

/** 渠道级最近签到摘要 */
function toolLastSummary(toolKey) {
  const rs = lastRunResults.filter((r) => r.tool === toolKey);
  if (!rs.length) return { text: '暂无记录', cls: '' };
  const ok = rs.filter((r) => r.ok).length;
  const at = (rs[rs.length - 1].at || '').replace('T', ' ').slice(5, 16);
  return { text: `${ok}/${rs.length} 成功 · ${at}`, cls: ok === rs.length ? 'ok' : 'fail' };
}

/** 渠道级 token 健康度（取最紧急的账号） */
function toolTokenSummary(t) {
  const days = t.accounts.map((a) => a.tokenExpireDays).filter((d) => d !== null && d !== undefined);
  if (!days.length) return { text: '有效期未知', cls: '' };
  const min = Math.min(...days);
  if (min <= 0) return { text: '有账号 token 已过期', cls: 'crit' };
  if (min < 3) return { text: `最早 ${min} 天后过期`, cls: 'crit' };
  if (min < 7) return { text: `最早 ${min} 天后过期`, cls: 'warn' };
  return { text: `最早 ${min} 天后过期`, cls: 'ok' };
}

// ---- 视图渲染 -----------------------------------------------------------------

function render() {
  const root = $('#view-root');
  const t = view.level === 'tool' ? getTool(view.toolKey) : null;
  if (view.level === 'tool' && !t) view = { level: 'grid', toolKey: null }; // 渠道被删除时回退
  root.innerHTML = view.level === 'tool' ? renderToolDetail(t) : renderChannelGrid();
}

/** 一级：渠道卡片网格 */
function renderChannelGrid() {
  if (!tools.length) return '<div class="panel muted">暂无渠道</div>';
  return `<div class="channel-grid">${tools.map(channelCard).join('')}</div>`;
}

function channelCard(t) {
  const ct = creditsToolOf(t.key);
  const n = t.accounts.length;
  const lr = toolLastSummary(t.key);
  const tk = toolTokenSummary(t);
  const totalText = !credits ? '…' : ct ? fmtCredits(ct.total) : '—';
  const accs = n
    ? t.accounts
        .map((a) => {
          const c = accountCreditCell(t.key, a.name);
          return `
        <li class="channel-acc">
          <span class="channel-acc-name" title="${esc(a.name)}">${esc(a.name)}</span>
          <span class="badge ${a.source === 'app' ? 'app' : 'snapshot'}">${a.source === 'app' ? '客户端' : '快照'}</span>
          <span class="channel-acc-val ${c.cls}"${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.text)}</span>
        </li>`;
        })
        .join('')
    : '<li class="channel-acc muted">暂无账号（在客户端登录后导入）</li>';
  return `
  <article class="channel-card" role="button" tabindex="0" aria-label="查看 ${esc(t.name)} 详情"
    onclick="openTool('${esc(t.key)}')"
    onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openTool('${esc(t.key)}');}">
    <div class="channel-head">
      <span class="channel-avatar">${esc(initial(t.name))}</span>
      <div class="channel-title">
        <h3>${esc(t.name)}</h3>
        <span class="muted">${n ? `${n} 个账号` : '暂无账号'}</span>
      </div>
      <span class="chev" aria-hidden="true">›</span>
    </div>
    <div class="channel-credits">
      <span class="channel-credits-val">${n ? totalText : '—'}</span>
      <span class="channel-credits-unit">credits 合计</span>
    </div>
    <ul class="channel-accs">${accs}</ul>
    <dl class="channel-meta">
      ${metaRow('token 状态', tk.text, tk.cls)}
      ${metaRow('最近签到', lr.text, lr.cls)}
    </dl>
  </article>`;
}

/** 二级：渠道详情（账号子卡片 + 操作） */
function renderToolDetail(t) {
  const ct = creditsToolOf(t.key);
  const lr = toolLastSummary(t.key);
  const accounts = t.accounts.length
    ? `<div class="account-grid">${t.accounts.map((a) => accountCard(t, a)).join('')}</div>`
    : '<section class="panel muted" style="margin-top:20px">暂无账号（在客户端登录后用下方导入）</section>';
  return `
  <section class="panel detail-head">
    <button class="back" onclick="backToGrid()">← 返回渠道</button>
    <div class="detail-title">
      <h2>${esc(t.name)}</h2>
      <span class="muted">${t.accounts.length} 个账号</span>
    </div>
    <div class="detail-stats">
      <div class="stat">
        <span class="stat-label">积分合计</span>
        <span class="stat-val">${!t.accounts.length ? '—' : !credits ? '…' : ct ? fmtCredits(ct.total) : '—'}</span>
      </div>
      <div class="stat">
        <span class="stat-label">最近签到</span>
        <span class="stat-val ${lr.cls}">${esc(lr.text)}</span>
      </div>
    </div>
    <button class="primary" onclick="runOne('${esc(t.key)}')">签到本工具</button>
  </section>
  ${accounts}
  <section class="panel import-panel">
    <h2>导入账号快照</h2>
    <div class="tool-foot">
      <input id="import-name-${esc(t.key)}" placeholder="快照名称（如：主号）" maxlength="40" />
      <button onclick="importAccount('${esc(t.key)}')">导入当前客户端登录</button>
    </div>
    <span class="hint">需先在 ${esc(t.name)} 客户端登录目标账号，再点导入</span>
  </section>`;
}

function accountCard(t, a) {
  const cr = credits ? accountCredit(t.key, a.name) : null;
  return `
  <article class="account-card">
    <div class="account-card-head">
      <span class="account-name">${esc(a.name)}</span>
      <span class="badge ${a.source === 'app' ? 'app' : 'snapshot'}">${a.source === 'app' ? '客户端登录' : '快照'}</span>
      ${tokenDaysHtml(a.tokenExpireDays)}
    </div>
    <div class="account-credit">
      <span class="account-credit-val">${cr ? (cr.ok ? fmtCredits(cr.credits) : '—') : '…'}</span>
      <span class="account-credit-unit">credits</span>
      ${cr && !cr.ok ? `<span class="credit-err">${esc(cr.msg)}</span>` : ''}
    </div>
    <dl class="account-detail">
      ${a.label ? kv('账号标识', a.label) : ''}
      ${kv('账号 ID', a.uid ? `${a.uid}…` : '未知')}
      ${kv('access token', expireText(a.tokenExpireDays, a.tokenExpiresAt))}
      ${kv('refresh token', expireText(a.refreshTokenExpireDays, a.refreshTokenExpiresAt))}
      ${kv('凭据来源', a.source === 'app' ? '客户端实时登录态' : `快照导入于 ${fmtTime(a.savedAt) || '未知时间'}`)}
      ${lastResultKv(t.key, a.name)}
    </dl>
    <div class="account-actions">
      <button class="small" onclick="runOne('${esc(t.key)}', '${esc(a.name)}')">签到</button>
      ${a.source === 'snapshot' ? `<button class="small danger" onclick="removeAccount('${esc(t.key)}', '${esc(a.name)}')">删除</button>` : ''}
    </div>
  </article>`;
}

// ---- 下钻导航 -----------------------------------------------------------------

function openTool(key) {
  view = { level: 'tool', toolKey: key };
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function backToGrid() {
  view = { level: 'grid', toolKey: null };
  render();
}

// ---- 概览渲染 -----------------------------------------------------------------

function renderOverview(data) {
  const list = (data && data.tools) || [];
  const hasAcc = list.some((t) => t.accounts.length);
  $('#credits-total').textContent = hasAcc ? fmtCredits(data.total) : '—';
  const at = fmtTime(data.fetchedAt);
  $('#credits-at').textContent = hasAcc ? (at ? `更新于 ${at.slice(11)}` : '') : '暂无账号';
}

function renderLastRun(state) {
  const sumEl = $('#last-run-summary');
  const atEl = $('#last-run-at');
  if (!state || !state.results || !state.results.length) {
    sumEl.textContent = '暂无记录';
    sumEl.className = 'overview-value';
    atEl.textContent = '';
    return;
  }
  const ok = state.results.filter((r) => r.ok).length;
  sumEl.textContent = `${ok}/${state.results.length} 成功`;
  sumEl.className = 'overview-value ' + (ok === state.results.length ? 'ok' : 'fail');
  atEl.textContent = fmtTime(state.finishedAt);
}

// ---- 加载 ---------------------------------------------------------------------

async function loadAll() {
  try {
    const [toolsRes, lastRun] = await Promise.all([api('/api/tools'), api('/api/last-run')]);
    tools = toolsRes.tools || [];
    lastRunResults = lastRun.results || [];
    renderLastRun(lastRun);
    render();
  } catch (e) {
    toast('加载失败: ' + e.message, true);
  }
}

async function loadCredits() {
  const btn = $('#btn-credits-refresh');
  btn.disabled = true;
  btn.textContent = '刷新中…';
  try {
    credits = await api('/api/credits');
    renderOverview(credits);
    render();
  } catch (e) {
    $('#credits-total').textContent = '—';
    $('#credits-at').textContent = '积分加载失败: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新积分';
  }
}

async function loadLog() {
  try {
    const r = await api('/api/log?lines=200');
    const el = $('#log-view');
    const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    el.textContent = r.lines.join('\n') || '（暂无日志）';
    if (stick) el.scrollTop = el.scrollHeight;
  } catch { /* 忽略 */ }
}

// ---- 操作 ---------------------------------------------------------------------

function setRunState(running) {
  const el = $('#run-state');
  el.textContent = running ? '运行中…' : '空闲';
  el.className = 'run-state ' + (running ? 'busy' : 'idle');
  $('#btn-run-all').disabled = !!running;
}

function startPolling() {
  stopPolling();
  setRunState(true);
  pollTimer = setInterval(async () => {
    try {
      const s = await api('/api/run/status');
      if (s.running) {
        if ($('#log-auto').checked) loadLog();
      } else {
        stopPolling();
        setRunState(false);
        await loadAll();
        loadLog();
        loadCredits(); // 签到会改变余额
        toast('签到已完成');
      }
    } catch { /* 轮询失败忽略，下轮重试 */ }
  }, 2000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function triggerRun(payload, label) {
  try {
    await api('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    toast(`已开始${label}`);
    startPolling();
  } catch (e) {
    toast(e.message, true);
  }
}

async function runOne(tool, account) {
  await triggerRun(account ? { tool, account } : { tool }, account ? `签到 ${tool}/${account}` : `签到 ${tool}`);
}

async function importAccount(tool) {
  const input = document.getElementById('import-name-' + tool);
  const name = (input.value || '').trim();
  if (!name) {
    toast('请先填写快照名称', true);
    input.focus();
    return;
  }
  try {
    const r = await api('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, name }),
    });
    if (r.ok) {
      input.value = '';
      toast(r.msg);
      await loadAll();
      loadCredits();
    } else {
      toast(r.msg, true);
    }
  } catch (e) {
    toast('导入失败: ' + e.message, true);
  }
}

async function removeAccount(tool, name) {
  if (!confirm(`确定删除账号快照 "${name}" 吗？删除后需在客户端重新登录导入。`)) return;
  try {
    const r = await api(`/api/accounts?tool=${encodeURIComponent(tool)}&name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    toast(r.msg);
    await loadAll();
    loadCredits();
  } catch (e) {
    toast('删除失败: ' + e.message, true);
  }
}

$('#btn-run-all').addEventListener('click', () => triggerRun({}, '全部签到'));
$('#btn-log-refresh').addEventListener('click', loadLog);
$('#btn-credits-refresh').addEventListener('click', loadCredits);

loadAll();
loadLog();
loadCredits();
