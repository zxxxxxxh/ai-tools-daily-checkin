'use strict';

/**
 * 运行编排：自动发现 lib/tools/ 下的工具模块（放新文件即接入），
 * 全串行执行签到（工具间、账号间均串行——领取接口有频控、快照文件有读改写竞争），
 * 每次运行后覆写 data/last-run.json。
 */

const fs = require('fs');
const path = require('path');
const { log } = require('./log');
const store = require('./store');

const TOOLS_DIR = path.join(__dirname, '..', 'tools');
const REQUIRED_EXPORTS = ['key', 'name', 'collectAccounts', 'importAccount', 'removeAccount', 'checkinAccount'];

let _tools = null;

/** 自动加载全部工具模块（字典序），缺导出启动即报错（fail fast） */
function loadTools() {
  if (_tools) return _tools;
  const mods = [];
  const files = fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.js')).sort();
  if (!files.length) throw new Error(`lib/tools/ 下没有工具模块`);
  for (const f of files) {
    const mod = require(path.join(TOOLS_DIR, f));
    const missing = REQUIRED_EXPORTS.filter((k) => mod[k] === undefined);
    if (missing.length) {
      throw new Error(`工具模块 ${f} 缺少导出: ${missing.join(', ')}`);
    }
    mods.push(mod);
  }
  _tools = mods;
  return mods;
}

function getTool(key) {
  return loadTools().find((t) => t.key === key) || null;
}

/**
 * 展示视图：字段白名单剥离凭据，uid 掩码（契约：handle 永不序列化）。
 * 展示字段只允许非凭据信息：到期时间、快照导入时间、账号标识（昵称/用户名），
 * token 本体与 refreshToken 一律不得出现在这里。
 */
function publicView(accounts) {
  return (accounts || []).map((a) => ({
    name: a.name,
    uid: a.uid ? String(a.uid).slice(0, 8) : '',
    source: a.source,
    tokenExpireDays: a.tokenExpireDays ?? null,
    refreshTokenExpireDays: a.refreshTokenExpireDays ?? null,
    tokenExpiresAt: a.tokenExpiresAt || null,
    refreshTokenExpiresAt: a.refreshTokenExpiresAt || null,
    savedAt: a.savedAt || null,
    label: a.label || '',
  }));
}

// ---- 运行状态（进程内并发闸；跨进程靠"先查状态再领取"幂等兜底） ----------------

let _running = null;

function isRunning() {
  return _running ? { ..._running } : null;
}

async function execute(type, toolKey, accountName) {
  _running = { type, tool: toolKey || null, account: accountName || null, startedAt: new Date().toISOString() };
  const results = [];
  try {
    const tools = toolKey ? [getTool(toolKey)] : loadTools();
    for (const tool of tools) {
      let accounts = [];
      try {
        accounts = await tool.collectAccounts();
      } catch (e) {
        accounts = [];
      }
      const target = accountName ? accounts.filter((a) => a.name === accountName) : accounts;
      if (!target.length) {
        if (accountName) continue; // 单账号模式：该工具没有这个账号名，静默跳过
        const msg = tool.noAccountMsg || `未找到可用账号，请在客户端登录后运行 node checkin.js --save ${tool.key} <名称> 导入`;
        log(`[${tool.name}] ❌ ${msg}`);
        results.push({ tool: tool.key, name: '-', uid: '', source: '-', ok: false, msg, at: new Date().toISOString() });
        continue;
      }
      for (const acc of target) {
        let r;
        try {
          r = await tool.checkinAccount(acc);
        } catch (e) {
          r = { ok: false, msg: `未预期错误: ${e.message}` };
        }
        log(`[${tool.name}] [${acc.name}] ${r.ok ? '✅' : '❌'} ${r.msg}`);
        results.push({
          tool: tool.key,
          name: acc.name,
          uid: acc.uid ? String(acc.uid).slice(0, 8) : '',
          source: acc.source,
          ok: r.ok,
          msg: r.msg,
          at: new Date().toISOString(),
        });
      }
    }
  } finally {
    const state = {
      type,
      tool: toolKey || null,
      account: accountName || null,
      startedAt: _running.startedAt,
      finishedAt: new Date().toISOString(),
      ok: results.length > 0 && results.every((r) => r.ok),
      results,
    };
    store.writeLastRun(state);
    _running = null;
  }
  return results;
}

/** 全部工具全部账号 */
async function runAll() {
  if (_running) return null;
  return execute('all', null, null);
}

/** 单工具全部账号 */
async function runTool(key) {
  if (_running) return null;
  if (!getTool(key)) throw new Error(`未知工具: ${key}`);
  return execute('tool', key, null);
}

/** 单账号（server 手动签到用）。账号不存在时返回 null（不产生任何结果） */
async function runAccount(key, name) {
  if (_running) return null;
  const tool = getTool(key);
  if (!tool) throw new Error(`未知工具: ${key}`);
  const accounts = await tool.collectAccounts();
  if (!accounts.some((a) => a.name === name)) return null;
  return execute('account', key, name);
}

module.exports = { loadTools, getTool, publicView, isRunning, runAll, runTool, runAccount };
