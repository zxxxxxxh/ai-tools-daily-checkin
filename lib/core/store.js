'use strict';

/**
 * 数据存储层：data/ 目录管理、DPAPI 密封信封、旧数据一次性迁移。
 *
 * 布局（data/ 运行时生成，机器相关，不进版本库）：
 *   data/accounts/<tool>/<name>.json   账号快照
 *   data/cache/<tool>.json             非快照（客户端登录态）账号的 token 缓存
 *   data/last-run.json                 最近一次签到结果（runner 覆写）
 *
 * 快照格式分两类：
 *   - WorkBuddy：沿用客户端 at-rest 密封格式（整文件普通 JSON，token 字段自带信封）
 *   - TraeWork / Qoder：明文元数据外壳 + DPAPI 密封 payload 内芯
 */

const fs = require('fs');
const path = require('path');
const dpapi = require('./dpapi');
const { log } = require('./log');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const LAST_RUN_FILE = path.join(DATA_DIR, 'last-run.json');

// 旧版布局（迁移源）
const LEGACY_WB_DIR = path.join(ROOT, 'workbuddy-accounts');
const LEGACY_TRAE_CACHE = path.join(ROOT, 'trae-token.cache.json');
const LEGACY_QODER_CACHE = path.join(ROOT, 'qoder-token.cache.json');

/** 账号名 → 安全文件名（沿用旧 workbuddySnapshotFile 规则） */
function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|\s]+/g, '_');
}

function accountDir(tool) {
  return path.join(ACCOUNTS_DIR, tool);
}

function accountFile(tool, name) {
  return path.join(accountDir(tool), `${safeName(name)}.json`);
}

function cacheFile(tool) {
  return path.join(CACHE_DIR, `${tool}.json`);
}

// ---- 明文 JSON 账号文件（WorkBuddy 快照） -----------------------------------

function listAccounts(tool) {
  const dir = accountDir(tool);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter((s) => s && s.name);
  } catch {
    return [];
  }
}

/** 同 uid 存在多个历史快照时，按 savedAt 保留最新一条（重复导入的兜底去重） */
function listAccountsUnique(tool) {
  const byUid = new Map();
  for (const acc of listAccounts(tool)) {
    if (!acc.uid) continue; // 无 uid 的旧快照不参与去重
    const prev = byUid.get(acc.uid);
    if (!prev || (acc.savedAt || '') > (prev.savedAt || '')) byUid.set(acc.uid, acc);
  }
  return [...byUid.values()];
}

function writeAccount(tool, obj) {
  fs.mkdirSync(accountDir(tool), { recursive: true });
  fs.writeFileSync(accountFile(tool, obj.name), JSON.stringify(obj, null, 2));
}

/** 删除快照，返回是否删除 */
function removeAccount(tool, name) {
  const file = accountFile(tool, name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

// ---- DPAPI 密封信封（TraeWork / Qoder） -------------------------------------

/** obj → base64(DPAPI(JSON)) */
function sealJson(obj) {
  return dpapi.protect(Buffer.from(JSON.stringify(obj), 'utf8')).toString('base64');
}

/** base64(DPAPI(JSON)) → obj */
function openSealed(b64) {
  return JSON.parse(dpapi.unprotect(Buffer.from(b64, 'base64')).toString('utf8'));
}

/** 读密封快照：→ { meta(明文外壳), payload(解封内芯) }；损坏返回 null */
function readSealedAccount(tool, name) {
  try {
    const meta = JSON.parse(fs.readFileSync(accountFile(tool, name), 'utf8'));
    if (!meta || !meta.sealed) return null;
    const payload = openSealed(meta.sealed);
    return { meta, payload };
  } catch {
    return null;
  }
}

/** 写密封快照：meta 为明文外壳（name/uid/时间戳），payload 为将被密封的凭据对象 */
function writeSealedAccount(tool, meta, payload) {
  fs.mkdirSync(accountDir(tool), { recursive: true });
  const obj = { format: 1, tool, ...meta, sealed: sealJson(payload) };
  fs.writeFileSync(accountFile(tool, meta.name), JSON.stringify(obj, null, 2));
}

// ---- 密封缓存（客户端登录态账号的续期结果） -----------------------------------

function readCache(tool) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(tool), 'utf8'));
    if (!c || !c.sealed) return null;
    return { uid: c.uid, savedAt: c.savedAt, payload: openSealed(c.sealed) };
  } catch {
    return null;
  }
}

function writeCache(tool, uid, payload) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(
    cacheFile(tool),
    JSON.stringify(
      { format: 1, tool, uid: uid || null, savedAt: new Date().toISOString(), sealed: sealJson(payload) },
      null,
      2
    )
  );
}

// ---- last-run ----------------------------------------------------------------

function readLastRun() {
  try {
    return JSON.parse(fs.readFileSync(LAST_RUN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeLastRun(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LAST_RUN_FILE, JSON.stringify(state, null, 2));
}

// ---- 旧数据迁移（幂等；由 init() 在 CLI/server 入口调用） ------------------------

function migrateLegacy() {
  // 1) workbuddy-accounts/ → data/accounts/workbuddy/（文件内容零转换）
  try {
    if (fs.existsSync(LEGACY_WB_DIR)) {
      fs.mkdirSync(accountDir('workbuddy'), { recursive: true });
      let moved = 0;
      for (const f of fs.readdirSync(LEGACY_WB_DIR)) {
        if (!f.endsWith('.json')) continue;
        const dest = path.join(accountDir('workbuddy'), f);
        if (!fs.existsSync(dest)) {
          fs.renameSync(path.join(LEGACY_WB_DIR, f), dest);
          moved++;
        }
      }
      // 目录空了才删（有残留文件说明目标重名，保守保留）
      if (fs.readdirSync(LEGACY_WB_DIR).length === 0) fs.rmdirSync(LEGACY_WB_DIR);
      if (moved) log(`已迁移 ${moved} 个 WorkBuddy 快照到 data/accounts/workbuddy/`);
    }
  } catch (e) {
    log(`WorkBuddy 快照迁移失败（不影响签到，下次运行重试）: ${e.message}`);
  }

  // 2) 旧明文 token 缓存 → DPAPI 密封缓存（保留可能已轮换的 refreshToken）
  for (const [file, tool] of [
    [LEGACY_TRAE_CACHE, 'traework'],
    [LEGACY_QODER_CACHE, 'qoder'],
  ]) {
    try {
      if (fs.existsSync(file) && !fs.existsSync(cacheFile(tool))) {
        const old = JSON.parse(fs.readFileSync(file, 'utf8'));
        const uid = old.userId || null; // TraeWork 明文 auth 含 userId；Qoder 旧缓存无 uid
        writeCache(tool, uid, old);
        fs.unlinkSync(file);
        log(`已迁移旧 ${tool} token 缓存到 data/cache/${tool}.json（DPAPI 密封）`);
      }
    } catch (e) {
      log(`旧 ${tool} token 缓存迁移失败（不影响签到，下次运行重试）: ${e.message}`);
    }
  }
}

function ensureDirs() {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/** 入口初始化：建目录 + 迁移旧数据。幂等。 */
function init() {
  ensureDirs();
  migrateLegacy();
}

module.exports = {
  ROOT,
  DATA_DIR,
  init,
  safeName,
  accountDir,
  accountFile,
  cacheFile,
  listAccounts,
  listAccountsUnique,
  writeAccount,
  removeAccount,
  sealJson,
  openSealed,
  readSealedAccount,
  writeSealedAccount,
  readCache,
  writeCache,
  readLastRun,
  writeLastRun,
};
