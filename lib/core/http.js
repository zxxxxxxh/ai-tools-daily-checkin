'use strict';

/** 通用 HTTP 请求封装（Node 18+ 内置 fetch，无第三方依赖） */

const TIMEOUT_MS = 30000;

/**
 * POST JSON（WorkBuddy / TraeWork 用）。
 * ok 判定 status===200，body 为解析后的 JSON（非 JSON 时 msg 带响应片段）。
 * 与旧版 checkin.js 的 postJson 逐字段一致。
 */
async function postJson(url, headers, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, msg: `HTTP ${res.status} 非 JSON 响应: ${text.slice(0, 150)}` };
    }
    return { ok: res.status === 200, status: res.status, body: json };
  } catch (e) {
    return { ok: false, status: 0, msg: e.message };
  }
}

/**
 * 通用 JSON 请求（Qoder 用）：GET/POST，ok 判定 res.ok（任意 2xx）。
 * 关键：body 为 undefined 时 fetch 选项里【不出现 body 键】——
 * Qoder claim 是"POST 无 body 无 Content-Type"，多一个 '{}' 都可能触发风控。
 */
async function jsonRequest(url, { method, headers, body } = {}) {
  try {
    const opts = { method: method || 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, msg: `HTTP ${res.status} 非 JSON 响应: ${text.slice(0, 120)}` };
    }
    return { ok: res.ok, status: res.status, body: json, msg: json.error || json.message || '' };
  } catch (e) {
    return { ok: false, status: 0, msg: e.message };
  }
}

module.exports = { postJson, jsonRequest, TIMEOUT_MS };
