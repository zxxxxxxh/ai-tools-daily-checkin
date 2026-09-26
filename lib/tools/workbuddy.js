'use strict';

/**
 * WorkBuddy（腾讯）签到模块。
 * 逻辑自旧版单文件 checkin.js 原样搬运，仅快照目录改为 store 统一管理
 * （data/accounts/workbuddy/，文件内容与旧 workbuddy-accounts/ 同构）。
 *
 * 快照沿用客户端 at-rest 密封格式：token 字段为 {$wbEncrypted:1, envelope}，
 * 用编译期静态钥 AES-256-GCM 解密（算法复刻自客户端 packages/at-rest-crypto）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { postJson } = require('../core/http');
const { log } = require('../core/log');
const store = require('../core/store');

// WorkBuddy 5.6+ at-rest 信封（复刻自客户端 packages/at-rest-crypto）：
// 字段值 = {$wbEncrypted:1, envelope: base64(JSON{suite,keyId,nonce,authTag,ciphertext})}
// key = SHA256(静态 atRestSecretKey 字符串)，keyId = SHA256(key) 前 16 位 hex
// AES-256-GCM，AAD = "WB-AAD\0" ‖ [1] ‖ lp("WBEV1") ‖ lp("sym-v1") ‖ u32BE(suite)
//               ‖ lp(keyId) ‖ [field=2] ‖ [0](sequence) ‖ [0](final)，lp = u32BE(len)+bytes
// atRestSecretKey 为编译期静态钥（5.6.2 对应 keyId 9127dea1b44020a7），提取方式见 README
const WORKBUDDY_AT_REST_SECRET = 'Sik9U5aXhCdwTVEwsEySDOmDoB9r9ntFxHF1fst9LQI=';
const WORKBUDDY_ENDPOINT = 'https://www.codebuddy.cn';
const WORKBUDDY_AUTH_FILE = path.join(
  process.env.LOCALAPPDATA,
  'CodeBuddyExtension',
  'Data',
  'Public',
  'auth',
  'workbuddy-desktop.info'
);

const RELOGIN = '，请打开 WorkBuddy 登录该账号后运行 node checkin.js --save workbuddy <名称> 重新导入';

function workbuddyOpenField(value) {
  if (typeof value === 'string') return value; // 5.6 之前客户端的明文格式
  if (!value || value.$wbEncrypted !== 1 || typeof value.envelope !== 'string') {
    throw new Error('无法识别的凭据字段格式');
  }
  const env = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8'));
  if (env.suite !== 1) throw new Error(`不支持的加密套件 suite=${env.suite}`);
  const key = crypto.createHash('sha256').update(WORKBUDDY_AT_REST_SECRET, 'utf8').digest();
  const keyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  if (env.keyId !== keyId) {
    throw new Error(`静态钥不匹配（envelope=${env.keyId}），WorkBuddy 客户端可能已更新轮换密钥`);
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'), {
    authTagLength: 16,
  });
  decipher.setAAD(workbuddyAad(env.suite, env.keyId));
  decipher.setAuthTag(Buffer.from(env.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(env.ciphertext, 'base64')), decipher.final()]).toString(
    'utf8'
  );
}

function workbuddyAad(suite, keyId) {
  const lp = (s) => {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  const suiteBe = Buffer.alloc(4);
  suiteBe.writeUInt32BE(suite);
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lp('WBEV1'),
    lp('sym-v1'),
    suiteBe,
    lp(keyId),
    Buffer.from([2, 0, 0]),
  ]);
}

/** 与客户端 at-rest 存储同构的密封（快照落盘用，密文不落明文 token） */
function workbuddySealField(plaintext) {
  const key = crypto.createHash('sha256').update(WORKBUDDY_AT_REST_SECRET, 'utf8').digest();
  const keyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(workbuddyAad(1, keyId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const envelope = Buffer.from(
    JSON.stringify({
      suite: 1,
      keyId,
      nonce: nonce.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    })
  ).toString('base64');
  return { $wbEncrypted: 1, envelope };
}

/** 读客户端当前登录的账号（主账号），失败返回 null */
function workbuddyReadAppAccount() {
  try {
    const file = JSON.parse(fs.readFileSync(WORKBUDDY_AUTH_FILE, 'utf8'));
    const uid = file.account?.uid;
    if (!file.auth?.accessToken || !uid) return null;
    let nickname = file.account.nickname ?? '';
    if (nickname && typeof nickname === 'object') {
      try {
        nickname = workbuddyOpenField(nickname);
      } catch {
        nickname = '';
      }
    }
    return {
      uid,
      uin: file.account.uin ?? '',
      nickname,
      auth: file.auth,
    };
  } catch {
    return null;
  }
}

/** 刷新响应（明文 token）→ 与客户端凭据文件同构的 auth 对象 */
function workbuddyBuildAuth(d) {
  const now = Date.now();
  return {
    accessToken: workbuddySealField(d.accessToken),
    refreshToken: workbuddySealField(d.refreshToken),
    expiresIn: d.expiresIn,
    refreshExpiresIn: d.refreshExpiresIn,
    tokenType: d.tokenType || 'Bearer',
    domain: d.domain || 'www.codebuddy.cn',
    lastRefreshTime: now,
    expiresAt: now + (d.expiresIn || 0) * 1000,
    refreshExpiresAt: now + (d.refreshExpiresIn || 0) * 1000,
  };
}

/** 用 refreshToken 调 /v2/plugin/auth/token/refresh（返回明文 token 的 auth 字段） */
async function workbuddyRefreshAuth(domain, refreshToken) {
  const r = await postJson(
    `${WORKBUDDY_ENDPOINT}/v2/plugin/auth/token/refresh`,
    {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Domain': domain || 'www.codebuddy.cn',
      'X-Refresh-Token': refreshToken,
      'X-Auth-Refresh-Source': 'plugin',
    },
    {}
  );
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.body?.error_msg || r.msg || ''}`.trim());
  const d = r.body?.data;
  if (!d?.accessToken || !d?.refreshToken) throw new Error('响应缺少 accessToken/refreshToken');
  return d;
}

function daysLeft(ms) {
  return ms ? Math.floor((ms - Date.now()) / 86400_000) : null;
}

function isoFromMs(ms) {
  const n = Number(ms);
  return n ? new Date(n).toISOString() : null;
}

/** 只接受真实数字字段：缺失/非数字返回 null，避免用常量兜底编造积分 */
function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 展示用账号标识（昵称 + 掩码 uin），仅非凭据信息 */
function workbuddyLabel(nickname, uin) {
  const parts = [];
  if (nickname) parts.push(String(nickname));
  if (uin) {
    const s = String(uin);
    parts.push(`uin ${s.length > 6 ? `${s.slice(0, 4)}****${s.slice(-2)}` : s}`);
  }
  return parts.join(' · ');
}

/**
 * 汇总签到账号：客户端当前登录账号 + 快照（按 uid 去重，客户端登录态优先且同步回快照）。
 * 快照账号的凭据留在快照对象里，checkinAccount 时才解密。
 */
async function collectAccounts() {
  const snapshots = store.listAccountsUnique('workbuddy');
  const app = workbuddyReadAppAccount();
  const accounts = [];
  if (app) {
    const snap = snapshots.find((s) => s.uid === app.uid);
    if (snap) {
      snap.auth = app.auth; // 客户端 token 更新鲜，同步回快照
      snap.uin = app.uin || snap.uin;
      store.writeAccount('workbuddy', snap);
      accounts.push({
        name: snap.name,
        uid: app.uid,
        source: 'app',
        auth: app.auth,
        snap,
        tokenExpireDays: daysLeft(Number(app.auth.expiresAt)),
        refreshTokenExpireDays: daysLeft(Number(app.auth.refreshExpiresAt)),
        tokenExpiresAt: isoFromMs(app.auth.expiresAt),
        refreshTokenExpiresAt: isoFromMs(app.auth.refreshExpiresAt),
        savedAt: snap.savedAt || null,
        label: workbuddyLabel(app.nickname, app.uin),
      });
    } else {
      accounts.push({
        name: '客户端登录',
        uid: app.uid,
        source: 'app',
        auth: app.auth,
        tokenExpireDays: daysLeft(Number(app.auth.expiresAt)),
        refreshTokenExpireDays: daysLeft(Number(app.auth.refreshExpiresAt)),
        tokenExpiresAt: isoFromMs(app.auth.expiresAt),
        refreshTokenExpiresAt: isoFromMs(app.auth.refreshExpiresAt),
        savedAt: null,
        label: workbuddyLabel(app.nickname, app.uin),
      });
    }
  }
  for (const snap of snapshots) {
    if (app && snap.uid === app.uid) continue;
    accounts.push({
      name: snap.name,
      uid: snap.uid,
      source: 'snapshot',
      auth: snap.auth,
      snap,
      tokenExpireDays: daysLeft(Number(snap.auth?.expiresAt)),
      refreshTokenExpireDays: daysLeft(Number(snap.auth?.refreshExpiresAt)),
      tokenExpiresAt: isoFromMs(snap.auth?.expiresAt),
      refreshTokenExpiresAt: isoFromMs(snap.auth?.refreshExpiresAt),
      savedAt: snap.savedAt || null,
      label: workbuddyLabel(snap.nickname, snap.uin),
    });
  }
  return accounts;
}

/** 导入客户端当前登录账号为快照（原 --wb-save 逻辑） */
async function importAccount(name) {
  const app = workbuddyReadAppAccount();
  if (!app) {
    return { ok: false, msg: '未读到客户端登录信息，请先打开 WorkBuddy 并确认已登录' };
  }
  // 同 uid 已有快照且名称不同：新快照落盘后删除旧快照（重新导入 = 改名 + 刷新凭据）
  const dups = store.listAccounts('workbuddy').filter((s) => s.uid === app.uid && s.name !== name);
  store.writeAccount('workbuddy', {
    name,
    uid: app.uid,
    uin: app.uin,
    nickname: app.nickname,
    domain: app.auth.domain || 'www.codebuddy.cn',
    savedAt: new Date().toISOString(),
    auth: app.auth,
  });
  let note = '';
  if (dups.length) {
    for (const d of dups) store.removeAccount('workbuddy', d.name);
    note = `，同账号旧快照 ${dups.map((d) => `"${d.name}"`).join('、')} 已删除`;
  }
  const exp = Number(app.auth.expiresAt);
  return {
    ok: true,
    msg:
      `已导入账号 "${name}"（uin=${app.uin}${app.nickname ? `，${app.nickname}` : ''}）` +
      (exp ? `，token 有效期至 ${new Date(exp).toLocaleString('zh-CN', { hour12: false })}` : '') +
      note,
  };
}

async function removeAccount(name) {
  if (!store.removeAccount('workbuddy', name)) {
    return { ok: false, msg: `未找到账号快照 "${name}"` };
  }
  return { ok: true, msg: `已删除账号快照 "${name}"` };
}

/** 单账号签到（原 workbuddyCheckinOne，请求体/头/流程零改动） */
async function checkinAccount(acc) {
  let accessToken;
  let refreshToken = null;
  try {
    accessToken = workbuddyOpenField(acc.auth.accessToken);
    if (acc.auth.refreshToken) refreshToken = workbuddyOpenField(acc.auth.refreshToken);
  } catch (e) {
    return { ok: false, msg: `解密登录信息失败: ${e.message}` };
  }
  const domain = acc.auth.domain || 'www.codebuddy.cn';
  const expiresAt = Number(acc.auth.expiresAt) || 0;

  const headers = () => ({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'X-User-Id': acc.uid,
    'X-Domain': domain,
  });
  const refreshOnce = async (reason) => {
    if (!refreshToken) throw new Error('无 refreshToken');
    log(`[WorkBuddy] [${acc.name}] ${reason}，尝试自动续期…`);
    const d = await workbuddyRefreshAuth(domain, refreshToken);
    accessToken = d.accessToken;
    refreshToken = d.refreshToken;
    acc.auth = workbuddyBuildAuth(d);
    if (acc.snap) {
      acc.snap.auth = acc.auth;
      store.writeAccount('workbuddy', acc.snap);
    }
    log(
      `[WorkBuddy] [${acc.name}] 续期成功，token 有效期至 ${new Date(
        acc.auth.expiresAt
      ).toLocaleString('zh-CN', { hour12: false })}`
    );
  };

  // 快照账号的 token 由脚本维护：临期（3 天内）先续；客户端登录账号交给客户端自己刷新
  if (acc.source === 'snapshot' && expiresAt && expiresAt < Date.now() + 3 * 86400_000) {
    try {
      await refreshOnce('token 即将过期');
    } catch (e) {
      return { ok: false, msg: `自动续期失败: ${e.message}${RELOGIN}` };
    }
  }

  let status = await postJson(`${WORKBUDDY_ENDPOINT}/v2/billing/meter/checkin-activity-status`, headers(), {});
  if (status.status === 401) {
    try {
      await refreshOnce('token 已失效');
      status = await postJson(`${WORKBUDDY_ENDPOINT}/v2/billing/meter/checkin-activity-status`, headers(), {});
    } catch (e) {
      return { ok: false, msg: `token 失效且自动续期失败（${e.message}）${RELOGIN}` };
    }
  }
  if (!status.ok) return { ok: false, msg: `查询签到状态失败: ${status.msg}` };
  const d = status.body.data || {};
  if (d.today_checked_in) {
    return { ok: true, msg: `今日已签到（连续 ${d.streak_days} 天），无需重复领取` };
  }

  const claim = await postJson(`${WORKBUDDY_ENDPOINT}/v2/billing/meter/daily-checkin`, headers(), {});
  if (!claim.ok) return { ok: false, msg: `签到失败: ${claim.msg}` };
  if (claim.body.code !== 0) {
    return { ok: false, msg: `签到失败: code=${claim.body.code} ${claim.body.msg || ''}` };
  }
  // 领取响应的发放额度/连续天数在顶层（客户端 daily-checkin 解析即读 resp.credit / resp.streak_days），
  // 缺失时退回状态接口同名字段；两处都拿不到就不写数字，绝不用常量兜底
  const cb = claim.body;
  const credit = numOrNull(cb.credit) ?? numOrNull(d.today_credit);
  const streak = numOrNull(cb.streak_days) ?? numOrNull(d.streak_days);
  return {
    ok: true,
    msg:
      credit === null
        ? `签到成功（接口未返回积分额度，连续 ${streak ?? '?'} 天）`
        : `签到成功，+${credit} 积分（连续 ${streak ?? '?'} 天）`,
  };
}

/**
 * 当前可用积分余额（只读查询，绝不触发领取）：
 * 各资源包 CycleRemainCapacity（本周期剩余额度）求和，单位 credits。
 */
async function getCredits(acc) {
  let accessToken;
  try {
    accessToken = workbuddyOpenField(acc.auth.accessToken);
  } catch (e) {
    return { ok: false, msg: `解密登录信息失败: ${e.message}` };
  }
  const r = await postJson(
    `${WORKBUDDY_ENDPOINT}/billing/meter/get-user-resource-summary`,
    {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-User-Id': acc.uid,
      'X-Domain': acc.auth.domain || 'www.codebuddy.cn',
    },
    {}
  );
  if (r.status === 401) return { ok: false, msg: 'token 已失效，下次签到时自动续期' };
  if (!r.ok) return { ok: false, msg: `查询积分失败: ${r.msg || `HTTP ${r.status}`}` };
  const pkgs = r.body?.data?.Packages;
  if (!Array.isArray(pkgs)) return { ok: false, msg: '响应缺少 Packages 字段' };
  const credits = pkgs.reduce((s, p) => s + (Number(p.CycleRemainCapacity) || 0), 0);
  return { ok: true, credits, msg: '' };
}

module.exports = {
  key: 'workbuddy',
  name: 'WorkBuddy',
  noAccountMsg: `未找到 WorkBuddy 登录信息，请先打开 WorkBuddy 登录后运行 node checkin.js --save workbuddy <名称> 导入`,
  collectAccounts,
  importAccount,
  removeAccount,
  checkinAccount,
  getCredits,
};
