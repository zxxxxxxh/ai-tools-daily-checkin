#!/usr/bin/env node
/**
 * AI 工具每日签到 —— 本地 Web 管理台（仅绑定 127.0.0.1，无第三方依赖）
 *
 * 启动：node server.js [--port 8787]
 * 页面：http://127.0.0.1:8787
 *
 * API：
 *   GET    /api/tools                    工具+账号总览（字段白名单，无凭据）
 *   GET    /api/last-run                 最近一次签到结果
 *   GET    /api/run/status               当前运行状态
 *   POST   /api/run                      {tool?, account?} 触发签到（202/409/404）
 *   POST   /api/accounts                {tool, name} 导入客户端当前登录为快照
 *   DELETE /api/accounts?tool=&name=     删除账号快照
 *   GET    /api/log?lines=200            checkin.log 尾部（≤1000 行）
 *
 * 安全边界：仅监听本机回环；data/ 内凭据经 DPAPI/at-rest 密封落盘，
 * 任何 API 响应不含 token（runner.publicView 白名单）。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const store = require('./lib/core/store');
const runner = require('./lib/core/runner');
const { log, LOG_FILE } = require('./lib/core/log');

const WEB_DIR = path.join(__dirname, 'web');
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR + path.sep)) return sendJson(res, 403, { error: '禁止访问' });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, 404, { error: '未找到' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
}

/** 读 checkin.log 尾部 N 行（不全量读文件） */
function readLogTail(lines) {
  try {
    const size = fs.statSync(LOG_FILE).size;
    const len = Math.min(size, lines * 512 + 8192);
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim())
      .slice(-lines);
  } catch {
    return [];
  }
}

async function handleRun(body) {
  if (runner.isRunning()) return [409, { error: '签到正在进行中，请稍后再试' }];
  if (body.account && !body.tool) return [400, { error: '指定账号时必须同时指定 tool' }];
  if (body.tool && !runner.getTool(body.tool)) return [404, { error: `未知工具: ${body.tool}` }];
  if (body.account) {
    const tool = runner.getTool(body.tool);
    const accs = await tool.collectAccounts();
    if (!accs.some((a) => a.name === body.account)) {
      return [404, { error: `工具 ${tool.name} 下不存在账号: ${body.account}` }];
    }
  }
  // 异步启动，立即 202；执行期日志写 checkin.log，结果写 last-run
  const scope = body.tool
    ? body.account
      ? () => runner.runAccount(body.tool, body.account)
      : () => runner.runTool(body.tool)
    : () => runner.runAll();
  Promise.resolve()
    .then(scope)
    .catch((e) => log(`[server] 签到执行错误: ${e.message}`));
  return [202, { started: true }];
}

async function handleRequest(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;

  if (p.startsWith('/api/')) {
    if (req.method === 'GET' && p === '/api/tools') {
      const tools = runner.loadTools().map(async (t) => ({
        key: t.key,
        name: t.name,
        accounts: runner.publicView(await t.collectAccounts()),
      }));
      return sendJson(res, 200, { tools: await Promise.all(tools) });
    }
    if (req.method === 'GET' && p === '/api/last-run') {
      return sendJson(res, 200, store.readLastRun() || { results: [] });
    }
    if (req.method === 'GET' && p === '/api/run/status') {
      return sendJson(res, 200, { running: runner.isRunning() });
    }
    if (req.method === 'GET' && p === '/api/log') {
      const lines = Math.min(Math.max(parseInt(u.searchParams.get('lines'), 10) || 200, 1), 1000);
      return sendJson(res, 200, { lines: readLogTail(lines) });
    }
    if (req.method === 'POST' && p === '/api/run') {
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return sendJson(res, 400, { error: '请求体不是合法 JSON' });
      }
      const [status, obj] = await handleRun(body);
      return sendJson(res, status, obj);
    }
    if (req.method === 'POST' && p === '/api/accounts') {
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return sendJson(res, 400, { error: '请求体不是合法 JSON' });
      }
      const tool = runner.getTool(body.tool);
      if (!tool) return sendJson(res, 404, { error: `未知工具: ${body.tool}` });
      if (!body.name) return sendJson(res, 400, { error: '缺少账号名 name' });
      const r = await tool.importAccount(String(body.name));
      return sendJson(res, 200, r); // 业务失败不是 HTTP 错误
    }
    if (req.method === 'DELETE' && p === '/api/accounts') {
      const tool = runner.getTool(u.searchParams.get('tool'));
      const name = u.searchParams.get('name');
      if (!tool) return sendJson(res, 404, { error: '未知工具' });
      if (!name) return sendJson(res, 400, { error: '缺少账号名 name' });
      const r = await tool.removeAccount(name);
      return sendJson(res, r.ok ? 200 : 404, r);
    }
    return sendJson(res, 404, { error: '未知 API' });
  }

  if (req.method === 'GET') return serveStatic(res, p);
  return sendJson(res, 405, { error: '不支持的请求方法' });
}

function main() {
  store.init();

  const argv = process.argv.slice(2);
  let port = DEFAULT_PORT;
  const pi = argv.indexOf('--port');
  if (pi !== -1 && argv[pi + 1]) port = parseInt(argv[pi + 1], 10) || DEFAULT_PORT;

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((e) => {
      try {
        sendJson(res, 500, { error: e.message });
      } catch { /* 响应已发出 */ }
    });
  });
  server.listen(port, '127.0.0.1', () => {
    log(`[server] Web 管理台已启动: http://127.0.0.1:${port}（Ctrl+C 退出）`);
  });
}

main();
