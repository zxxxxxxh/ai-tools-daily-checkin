'use strict';

/* AI 签到管理台前端（原生 JS，无依赖） */

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

// ---- 渲染 ---------------------------------------------------------------------

let lastRunResults = [];
let pollTimer = null;

function tokenDaysHtml(days) {
  if (days === null || days === undefined) return '<span class="token-days">token 有效期未知</span>';
  const cls = days < 3 ? 'crit' : days < 7 ? 'warn' : 'ok';
  const text = days > 0 ? `token 剩 ${days} 天` : 'token 已过期（签到时自动续期）';
  return `<span class="token-days ${cls}">${esc(text)}</span>`;
}

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

function kv(label, value, cls) {
  return `<div class="kv${cls === 'wide' ? ' wide' : ''}"><dt>${esc(label)}</dt><dd class="${cls && cls !== 'wide' ? cls : ''}">${esc(value)}</dd></div>`;
}

function lastResultKv(toolKey, name) {
  const r = lastRunResults.find((x) => x.tool === toolKey && x.name === name);
  if (!r) return kv('最近签到', '暂无记录', 'wide');
  return kv('最近签到', `${r.ok ? '✅' : '❌'} ${r.msg}（${(r.at || '').replace('T', ' ').slice(5, 16)}）`, r.ok ? 'ok wide' : 'fail wide');
}

function renderTools(tools) {
  const box = $('#tools');
  box.innerHTML = tools
    .map((t) => {
      const rows = t.accounts.length
        ? t.accounts
            .map(
              (a) => `
        <div class="account">
          <div class="account-head">
            <span class="account-name">${esc(a.name)}</span>
            <span class="badge ${a.source === 'app' ? 'app' : 'snapshot'}">${a.source === 'app' ? '客户端登录' : '快照'}</span>
            ${tokenDaysHtml(a.tokenExpireDays)}
            <span class="row-actions">
              <button class="small" onclick="runOne('${esc(t.key)}', '${esc(a.name)}')">签到</button>
              ${a.source === 'snapshot' ? `<button class="small danger" onclick="removeAccount('${esc(t.key)}', '${esc(a.name)}')">删除</button>` : ''}
            </span>
          </div>
          <dl class="account-detail">
            ${a.label ? kv('账号标识', a.label) : ''}
            ${kv('账号 ID', a.uid ? `${a.uid}…` : '未知')}
            ${kv('access token', expireText(a.tokenExpireDays, a.tokenExpiresAt))}
            ${kv('refresh token', expireText(a.refreshTokenExpireDays, a.refreshTokenExpiresAt))}
            ${kv('凭据来源', a.source === 'app' ? '客户端实时登录态' : `快照导入于 ${fmtTime(a.savedAt) || '未知时间'}`)}
            ${lastResultKv(t.key, a.name)}
          </dl>
        </div>`
            )
            .join('')
        : '<div class="account muted">暂无账号（在客户端登录后用下方导入）</div>';
      return `
      <div class="tool-card">
        <div class="tool-head">
          <h2>${esc(t.name)}</h2>
          <button class="small" onclick="runOne('${esc(t.key)}')">签到本工具</button>
        </div>
        ${rows}
        <div class="tool-foot">
          <input id="import-name-${esc(t.key)}" placeholder="快照名称（如：主号）" maxlength="40" />
          <button onclick="importAccount('${esc(t.key)}')">导入当前客户端登录</button>
          <span class="hint">需先在 ${esc(t.name)} 客户端登录目标账号，再点导入</span>
        </div>
      </div>`;
    })
    .join('');
}

function renderLastRun(state) {
  const el = $('#last-run-body');
  if (!state || !state.results || !state.results.length) {
    el.textContent = '暂无记录';
    return;
  }
  const okCount = state.results.filter((r) => r.ok).length;
  el.innerHTML = `
    <div class="muted">${esc((state.finishedAt || '').replace('T', ' ').slice(0, 19))} · ${okCount}/${state.results.length} 成功</div>
    <ul>${state.results.map((r) => `<li>${r.ok ? '✅' : '❌'} <b>${esc(r.name)}</b> ${esc(r.msg)}</li>`).join('')}</ul>`;
}

async function loadAll() {
  try {
    const [toolsRes, lastRun] = await Promise.all([api('/api/tools'), api('/api/last-run')]);
    renderTools(toolsRes.tools);
    lastRunResults = lastRun.results || [];
    renderLastRun(lastRun);
  } catch (e) {
    toast('加载失败: ' + e.message, true);
  }
}

async function loadLog() {
  try {
    const r = await api('/api/log?lines=200');
    const view = $('#log-view');
    const stick = view.scrollTop + view.clientHeight >= view.scrollHeight - 30;
    view.textContent = r.lines.join('\n') || '（暂无日志）';
    if (stick) view.scrollTop = view.scrollHeight;
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
  } catch (e) {
    toast('删除失败: ' + e.message, true);
  }
}

$('#btn-run-all').addEventListener('click', () => triggerRun({}, '全部签到'));
$('#btn-log-refresh').addEventListener('click', loadLog);

loadAll();
loadLog();
