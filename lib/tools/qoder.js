'use strict';

/**
 * Qoder CN（阿里，Qoder CN 桌面端）签到模块。
 * 请求逻辑自旧版单文件 checkin.js 原样搬运；多账号化为新增：
 * 快照 = 明文元数据 + DPAPI 密封的 auth 全量（token/refreshToken/user）。
 *
 * 凭据 %APPDATA%\com.qodercn.app.stable\auth.v1.dat 是 Chromium safeStorage "v10" 块：
 * "v10" + AES-256-GCM(nonce 12B + 密文 + tag 16B)，AES 密钥为 Local State 里
 * DPAPI 保护的 os_crypt.encrypted_key（CurrentUser 作用域）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { jsonRequest } = require('../core/http');
const { log } = require('../core/log');
const store = require('../core/store');
const dpapi = require('../core/dpapi');

const QODER_DATA_DIR = path.join(process.env.APPDATA, 'com.qodercn.app.stable');
const QODER_API = 'https://openapi.qoder.com.cn';

function qoderReadAuthFromApp() {
  const localState = JSON.parse(fs.readFileSync(path.join(QODER_DATA_DIR, 'Local State'), 'utf8'));
  const encKey = Buffer.from(localState.os_crypt.encrypted_key, 'base64');
  if (encKey.slice(0, 5).toString() !== 'DPAPI') throw new Error('Local State encrypted_key 格式异常');
  const aesKey = dpapi.unprotect(encKey.slice(5));
  const blob = fs.readFileSync(path.join(QODER_DATA_DIR, 'auth.v1.dat'));
  if (blob.slice(0, 3).toString() !== 'v10') throw new Error('auth.v1.dat 不是 v10 加密块');
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, blob.slice(3, 15));
  decipher.setAuthTag(blob.slice(blob.length - 16));
  const plain = Buffer.concat([decipher.update(blob.slice(15, blob.length - 16)), decipher.final()]).toString('utf8');
  const auth = JSON.parse(plain);
  if (!auth.token || !auth.refreshToken) throw new Error('登录信息不完整');
  return auth;
}

/** 账号 uid：auth.user.id（稳定 UUID）；缺失时用 refreshToken 指纹降级 */
function qoderUid(auth) {
  if (auth.user?.id) return String(auth.user.id);
  return 'fp-' + crypto.createHash('sha256').update(auth.refreshToken || '').digest('hex').slice(0, 16);
}

/** token 未过期（留 1 小时余量） */
function qoderTokenUsable(auth) {
  return auth?.token && auth.expiresAt && new Date(auth.expiresAt).getTime() > Date.now() + 3600_000;
}

function daysLeft(iso) {
  return iso ? Math.floor((new Date(iso).getTime() - Date.now()) / 86400_000) : null;
}

/** 只接受真实数字字段：缺失/非数字返回 null，避免用常量兜底编造积分 */
function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 与客户端一致的请求头（机器头 Cosy-Machine* 非必需，已用最小头集验证） */
function qoderHeaders(token) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Cosy-ClientType': '10',
    'User-Agent': 'Qoder',
  };
}

/** 用 refreshToken 调 deviceToken/refresh 换新 token（响应字段与客户端解析规则一致） */
async function qoderRefreshToken(auth) {
  let json;
  try {
    const res = await fetch(`${QODER_API}/api/v1/deviceToken/refresh`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: auth.refreshToken }),
      signal: AbortSignal.timeout(30000),
    });
    json = await res.json();
    if (!res.ok || !(json.device_token || json.token)) {
      throw new Error(`HTTP ${res.status} code=${json.code ?? '?'} ${json.message || json.error || ''}`);
    }
  } catch (e) {
    throw new Error(`续期请求失败: ${e.message}`);
  }
  return {
    ...auth,
    token: json.device_token || json.token,
    refreshToken: json.refresh_token || auth.refreshToken,
    expiresAt: json.expires_at || new Date(Date.now() + (json.expires_in || 2592000) * 1000).toISOString(),
    refreshTokenExpiresAt: json.refresh_token_expires_at || auth.refreshTokenExpiresAt,
  };
}

/**
 * 汇总账号：客户端登录态 + 快照（按 uid 去重，app 优先并同步回快照）。
 * 非当前登录的快照不解封（DPAPI 解封按需发生在 checkinAccount）。
 */
async function collectAccounts() {
  const accounts = [];
  let app = null;
  try {
    app = qoderReadAuthFromApp();
  } catch {
    app = null; // 客户端未安装/未登录/存储异常：降级为仅快照账号
  }

  if (app) {
    const uid = qoderUid(app);
    const snaps = store.listAccountsUnique('qoder');
    const snap = snaps.find((s) => s.uid === uid);
    if (snap) {
      store.writeSealedAccount('qoder', {
        name: snap.name,
        uid,
        savedAt: snap.savedAt,
        tokenExpiresAt: app.expiresAt,
        refreshExpiresAt: app.refreshTokenExpiresAt,
      }, app);
      accounts.push({
        name: snap.name,
        uid,
        source: 'app',
        auth: app,
        tokenExpireDays: daysLeft(app.expiresAt),
        refreshTokenExpireDays: daysLeft(app.refreshTokenExpiresAt),
        tokenExpiresAt: app.expiresAt || null,
        refreshTokenExpiresAt: app.refreshTokenExpiresAt || null,
        savedAt: snap.savedAt || null,
        label: app.user?.name || '',
      });
    } else {
      accounts.push({
        name: '客户端登录',
        uid,
        source: 'app',
        auth: app,
        tokenExpireDays: daysLeft(app.expiresAt),
        refreshTokenExpireDays: daysLeft(app.refreshTokenExpiresAt),
        tokenExpiresAt: app.expiresAt || null,
        refreshTokenExpiresAt: app.refreshTokenExpiresAt || null,
        savedAt: null,
        label: app.user?.name || '',
      });
    }
  }

  const snaps = store.listAccountsUnique('qoder');
  for (const snap of snaps) {
    if (app && snap.uid === qoderUid(app)) continue;
    accounts.push({
      name: snap.name,
      uid: snap.uid,
      source: 'snapshot',
      snapName: snap.name,
      tokenExpireDays: daysLeft(snap.tokenExpiresAt),
      refreshTokenExpireDays: daysLeft(snap.refreshExpiresAt),
      tokenExpiresAt: snap.tokenExpiresAt || null,
      refreshTokenExpiresAt: snap.refreshExpiresAt || null,
      savedAt: snap.savedAt || null,
      label: '',
    });
  }
  return accounts;
}

/** 导入客户端当前登录账号为快照 */
async function importAccount(name) {
  let app;
  try {
    app = qoderReadAuthFromApp();
  } catch (e) {
    return { ok: false, msg: `读取 Qoder CN 登录信息失败（请先打开 Qoder CN 登录）: ${e.message}` };
  }
  const uid = qoderUid(app);
  // 同 uid 已有快照且名称不同：新快照落盘后删除旧快照（重新导入 = 改名 + 刷新凭据）
  const dups = store.listAccounts('qoder').filter((s) => s.uid === uid && s.name !== name);
  store.writeSealedAccount(
    'qoder',
    {
      name,
      uid,
      savedAt: new Date().toISOString(),
      tokenExpiresAt: app.expiresAt || null,
      refreshExpiresAt: app.refreshTokenExpiresAt || null,
    },
    app
  );
  let note = '';
  if (dups.length) {
    for (const d of dups) store.removeAccount('qoder', d.name);
    note = `，同账号旧快照 ${dups.map((d) => `"${d.name}"`).join('、')} 已删除`;
  }
  return {
    ok: true,
    msg:
      `已导入账号 "${name}"${app.user ? `（${app.user.name || app.user.id}）` : ''}` +
      (app.expiresAt ? `，token 有效期至 ${app.expiresAt}` : '') +
      note,
  };
}

async function removeAccount(name) {
  if (!store.removeAccount('qoder', name)) {
    return { ok: false, msg: `未找到账号快照 "${name}"` };
  }
  return { ok: true, msg: `已删除账号快照 "${name}"` };
}

/** 单账号签到：快照账号按需解封 + 临期/失效自动续期并落盘 */
async function checkinAccount(acc) {
  const reloginApp = '，请打开 Qoder CN 重新登录';
  const reloginSnap = '，请在 Qoder CN 登录该账号后运行 node checkin.js --save qoder <名称> 重新导入';
  let auth;
  let from = 'app';

  if (acc.source === 'snapshot') {
    const snap = store.readSealedAccount('qoder', acc.snapName || acc.name);
    if (!snap) {
      return { ok: false, msg: `读取快照 "${acc.name}" 失败（密封数据损坏）${reloginSnap}` };
    }
    auth = snap.payload;
    // token 约 30 天：临期（7 天内）先续
    if (auth.expiresAt && new Date(auth.expiresAt).getTime() < Date.now() + 7 * 86400_000) {
      try {
        log(`[Qoder CN] [${acc.name}] token 即将过期，尝试自动续期…`);
        auth = await qoderRefreshToken(auth);
        store.writeSealedAccount(
          'qoder',
          { name: acc.name, uid: acc.uid, savedAt: snap.meta.savedAt, tokenExpiresAt: auth.expiresAt, refreshExpiresAt: auth.refreshTokenExpiresAt || null },
          auth
        );
        log(`[Qoder CN] [${acc.name}] 续期成功，token 有效期至 ${auth.expiresAt}`);
      } catch (e) {
        return { ok: false, msg: `自动续期失败: ${e.message}${reloginSnap}` };
      }
    }
  } else {
    auth = acc.auth;
    if (!qoderTokenUsable(auth)) {
      // app 里的 token 过期（超过 30 天没打开应用），用缓存（uid 匹配防串号；null 为旧格式单账号缓存）
      const cached = store.readCache('qoder');
      if (cached && qoderTokenUsable(cached.payload) && (cached.uid == null || cached.uid === acc.uid)) {
        auth = cached.payload;
        from = 'cache';
      }
    }
  }

  const persist = async (newAuth) => {
    if (acc.source === 'snapshot') {
      const snap = store.readSealedAccount('qoder', acc.snapName || acc.name);
      store.writeSealedAccount(
        'qoder',
        { name: acc.name, uid: acc.uid, savedAt: snap?.meta.savedAt, tokenExpiresAt: newAuth.expiresAt, refreshExpiresAt: newAuth.refreshTokenExpiresAt || null },
        newAuth
      );
    } else if (!store.listAccountsUnique('qoder').some((s) => s.uid === acc.uid)) {
      store.writeCache('qoder', acc.uid, {
        token: newAuth.token,
        refreshToken: newAuth.refreshToken,
        expiresAt: newAuth.expiresAt,
        refreshTokenExpiresAt: newAuth.refreshTokenExpiresAt,
      });
    }
  };

  let r = await jsonRequest(`${QODER_API}/sash/api/v1/me/campaigns`, { headers: qoderHeaders(auth.token) });
  if (r.status === 401 || r.status === 403) {
    log(`[Qoder CN] [${acc.name}] token 失效，尝试用 refreshToken 自动续期…`);
    try {
      auth = await qoderRefreshToken(auth);
      await persist(auth);
      log(`[Qoder CN] [${acc.name}] 续期成功，token 有效期至 ${auth.expiresAt}`);
      r = await jsonRequest(`${QODER_API}/sash/api/v1/me/campaigns`, { headers: qoderHeaders(auth.token) });
    } catch (e) {
      return { ok: false, msg: `token 已失效且自动续期失败（${e.message}）${acc.source === 'snapshot' ? reloginSnap : reloginApp}` };
    }
  }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, msg: `续期后仍认证失败${acc.source === 'snapshot' ? reloginSnap : reloginApp}` };
  }
  if (!r.ok) return { ok: false, msg: `查询签到状态失败: ${r.msg || `HTTP ${r.status}`}` };

  const campaigns = Array.isArray(r.body?.campaigns)
    ? r.body.campaigns
    : Array.isArray(r.body?.data?.campaigns)
      ? r.body.data.campaigns
      : [];
  const claimable = campaigns.filter((c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE');
  if (claimable.length === 0) {
    const claimed = campaigns.some((c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMED');
    if (claimed) return { ok: true, msg: '今日已签到（活动已领取），无需重复领取' };
    return { ok: false, msg: '当前无可领取的签到活动（每日活动通常 10:00 后开放）' };
  }

  // 领取：POST 无 body 无 Content-Type（与桌面端抓包一致，多带 body 可能触发限频）
  let total = 0;
  let unknown = 0;
  const fails = [];
  for (const c of claimable) {
    const cr = await jsonRequest(
      `${QODER_API}/sash/api/v1/me/campaigns/${encodeURIComponent(c.campaignId)}/claim`,
      { method: 'POST', headers: qoderHeaders(auth.token) }
    );
    if (!cr.ok) {
      fails.push(`${c.campaignKey || c.campaignId}: HTTP ${cr.status} ${cr.msg}`.trim());
      continue;
    }
    // 额度只认活动接口的 benefit.amount（实测领取后仍回带）；拿不到就不写数字，绝不用常量兜底
    const amount = numOrNull(c.benefit?.amount);
    if (amount === null) unknown += 1;
    else total += amount;
  }
  if (fails.length) return { ok: false, msg: `签到失败: ${fails.join('; ')}` };
  let msg = `签到成功，+${total} 积分`;
  if (unknown) {
    msg = total > 0 ? `签到成功，+${total} 积分（另有 ${unknown} 个活动未返回额度）` : '签到成功（活动接口未返回积分额度）';
  }
  if (from === 'cache') msg += '（使用缓存 token，建议打开一次 Qoder CN）';
  return { ok: true, msg };
}

/** 取账号 auth：快照账号按需解封（只读，不续期、不落盘） */
function qoderCreditsAuth(acc) {
  if (acc.source !== 'snapshot') return acc.auth;
  const snap = store.readSealedAccount('qoder', acc.snapName || acc.name);
  return snap ? snap.payload : null;
}

/**
 * 当前可用积分余额（只读查询，绝不触发领取）：
 * qoderUsage.userQuota.remaining + addOnQuota.remaining，单位 credits。
 */
async function getCredits(acc) {
  const auth = qoderCreditsAuth(acc);
  if (!auth?.token) return { ok: false, msg: `读取账号 "${acc.name}" 登录信息失败` };
  const r = await jsonRequest(`${QODER_API}/sash/api/v2/me/usage`, { headers: qoderHeaders(auth.token) });
  if (r.status === 401 || r.status === 403) return { ok: false, msg: 'token 已失效，下次签到时自动续期' };
  if (!r.ok) return { ok: false, msg: `查询积分失败: ${r.msg || `HTTP ${r.status}`}` };
  const u = r.body?.qoderUsage || r.body || {};
  const credits = (Number(u.userQuota?.remaining) || 0) + (Number(u.addOnQuota?.remaining) || 0);
  return { ok: true, credits, msg: '' };
}

module.exports = {
  key: 'qoder',
  name: 'Qoder CN',
  noAccountMsg: '未找到 Qoder CN 登录信息，请打开 Qoder CN 登录，或登录后运行 node checkin.js --save qoder <名称> 导入快照',
  collectAccounts,
  importAccount,
  removeAccount,
  checkinAccount,
  getCredits,
};
