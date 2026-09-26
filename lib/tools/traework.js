'use strict';

/**
 * TraeWork（字节，TRAE SOLO CN 桌面端）签到模块。
 * 请求逻辑自旧版单文件 checkin.js 原样搬运；多账号化为新增：
 * 快照 = 明文元数据 + DPAPI 密封的 auth 全量 + 设备密钥三元组
 * （_deviceId/_privateKeyPEM/_publicKeyPEM，续期 ECDSA 签名必需）。
 *
 * 已知限制：客户端轮换 icube-dc 设备密钥对后，旧快照续期签名失效，
 * msg 会引导重新导入。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { postJson, jsonRequest } = require('../core/http');
const { log } = require('../core/log');
const store = require('../core/store');

// byteCrypto.js 复刻：blob = "tc\x05\x10\x00\x00" + seed(32) + AES-128-CBC(SHA512(明文) + 明文)
const TRAE_KEY = (() => {
  const G = [82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37];
  const J = [31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125];
  const k = Buffer.alloc(64);
  for (let i = 0; i < 64; i++) k[i] = G[i] ^ J[i];
  return k;
})();

const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest();

function traeDecrypt(b64) {
  const blob = Buffer.from(b64, 'base64');
  if (blob[0] !== 0x74 || blob[1] !== 0x63 || blob[2] !== 5) throw new Error('不是 tc v5 加密块');
  const seed = blob.slice(6, 38);
  const h2 = sha512(Buffer.concat([sha512(seed), TRAE_KEY]));
  const decipher = crypto.createDecipheriv('aes-128-cbc', h2.slice(0, 16), h2.slice(16, 32));
  const plain = Buffer.concat([decipher.update(blob.slice(38)), decipher.final()]);
  return plain.slice(64).toString('utf8'); // 前 64 字节是明文的 SHA-512 校验
}

function readTraeAuthFromApp() {
  const storagePath = path.join(
    process.env.APPDATA,
    'TRAE SOLO CN',
    'User',
    'globalStorage',
    'storage.json'
  );
  const storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  const b64 = storage['iCubeAuthInfo://icube.cloudide'];
  if (!b64) return null;
  const auth = JSON.parse(traeDecrypt(b64));
  // iCubeAuthInfo://icube-dc:<aha设备ID> 存设备密钥对（续期签名用），
  // 键名里的数字就是接口要的 x-device-id（aha 设备 ID，非 machineid）
  const dcKey = Object.keys(storage).find((k) => /^iCubeAuthInfo:\/\/icube-dc:/.test(k));
  if (dcKey) {
    auth._deviceId = dcKey.split(':').pop();
    try {
      const kp = JSON.parse(traeDecrypt(storage[dcKey]));
      auth._privateKeyPEM = kp.privateKeyPEM;
      auth._publicKeyPEM = kp.publicKeyPEM;
    } catch { /* 密钥对缺失时只是无法自动续期 */ }
  }
  return auth;
}

/** 账号 uid：auth.userId 优先，兜底从 JWT payload 解码（无需验签） */
function traeUid(auth) {
  if (auth.userId) return String(auth.userId);
  try {
    const payload = JSON.parse(Buffer.from(auth.token.split('.')[1], 'base64url').toString('utf8'));
    return payload?.data?.id ? String(payload.data.id) : null;
  } catch {
    return null;
  }
}

/** token 未过期（留 1 小时余量） */
function tokenUsable(auth) {
  return auth?.token && auth.expiredAt && new Date(auth.expiredAt).getTime() > Date.now() + 3600_000;
}

function daysLeft(iso) {
  return iso ? Math.floor((new Date(iso).getTime() - Date.now()) / 86400_000) : null;
}

/** 只接受真实数字字段：缺失/非数字返回 null，避免用常量兜底编造积分 */
function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 用 refreshToken + 设备密钥调 ExchangeToken 换新 token（请求体与桌面端逐字段一致） */
async function traeRefreshToken(auth) {
  const host = auth.host || 'https://api.trae.cn';
  const url = `${host}/trae/api/v3/oauth/ExchangeToken`;
  const apiPath = '/trae/api/v3/oauth/ExchangeToken';
  const clientID = 'en1oxy7wnw8j9n'; // SOLO(Lite) 默认 ClientID
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = ['POST', apiPath, clientID, auth.refreshToken, String(timestamp), nonce].join(' ');
  const signature = crypto
    .createSign('sha256')
    .update(payload)
    .sign(auth._privateKeyPEM)
    .toString('base64');
  const deviceId = auth._deviceId || '';

  const body = {
    ClientID: clientID,
    ClientSecret: '',
    RefreshToken: auth.refreshToken,
    DeviceInfo: {
      DeviceID: deviceId,
      MachineID: deviceId,
      PlatformCode: 'SOLO_PC',
      DeviceType: 'PC',
      DeviceName: os.hostname(),
      DeviceModel: '',
      ClientVersion: '0.1.50',
      DevicePublicKey: auth._publicKeyPEM || '',
      DeviceBrand: '',
      DeviceCPU: '',
      OSInfo: process.platform,
      OSVersion: os.release(),
    },
    DeviceProof: { Signature: signature, Timestamp: timestamp, Nonce: nonce },
    IDEVersion: '0.1.50',
  };
  const res = await postJson(url, { 'Content-Type': 'application/json' }, body);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.msg}`);
  const r = res.body?.Result;
  if (!r?.Token) throw new Error(`响应缺少 Token: ${JSON.stringify(res.body).slice(0, 200)}`);
  return {
    ...auth,
    token: r.Token,
    refreshToken: r.RefreshToken || auth.refreshToken,
    expiredAt: r.TokenExpireAt
      ? new Date(Number(r.TokenExpireAt) < 1e12 ? Number(r.TokenExpireAt) * 1000 : Number(r.TokenExpireAt)).toISOString()
      : new Date(Date.now() + (r.TokenExpireDuration || 1209600) * 1000).toISOString(),
  };
}

/** 状态/领取（原 traeCheckinWith，请求体/头零改动）。返回 {authError,ok,msg} */
async function traeCheckinWith(auth) {
  const host = auth.host || 'https://api.trae.cn';
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Cloud-IDE-JWT ${auth.token}`,
    'x-device-id': auth._deviceId || '',
  };
  // 与桌面端一致：POST 空 JSON 体
  const body = {};

  const status = await postJson(`${host}/trae/api/v2/ug/checkin_credits/status`, headers, body);
  if (!status.ok) return { authError: false, ok: false, msg: `查询签到状态失败: ${status.msg}` };
  if (status.body.code === 1001) return { authError: true };
  if (status.body.code !== 0) {
    return { authError: false, ok: false, msg: `查询签到状态失败: code=${status.body.code} ${status.body.message || ''}` };
  }
  if (status.body.checked_in) {
    return { authError: false, ok: true, msg: `今日已签到，当前签到积分 ${status.body.credits}` };
  }
  const claim = await postJson(`${host}/trae/api/v2/ug/checkin_credits/claim`, headers, body);
  if (!claim.ok) return { authError: false, ok: false, msg: `签到请求失败: ${claim.msg}` };
  if (claim.body.code === 1001) return { authError: true };
  if (claim.body.code === 9095) {
    // 当前设备今日已签（状态接口跨设备不反映，签到以设备为准）
    return { authError: false, ok: true, msg: `今日已签到（当前设备今日已签），无需重复领取` };
  }
  if (claim.body.code !== 0) {
    return { authError: false, ok: false, msg: `签到失败: code=${claim.body.code} ${claim.body.message || ''}` };
  }
  // 领取响应不回带额度（实测为缺省），退回同流程状态接口的 credits（当日签到积分）；
  // 两处都拿不到就不写数字，绝不用常量兜底
  const credit = numOrNull(claim.body.credits) ?? numOrNull(status.body.credits);
  return {
    authError: false,
    ok: true,
    msg: credit === null ? '签到成功（接口未返回积分额度）' : `签到成功，+${credit} 积分`,
  };
}

const RELOGIN_SNAP =
  '，请在 TraeWork 登录该账号后运行 node checkin.js --save traework <名称> 重新导入（设备密钥可能已轮换）';

/**
 * 汇总账号：客户端登录态 + 快照（按 uid 去重，app 优先并同步回快照）。
 * 非当前登录的快照不解封（DPAPI 解封按需发生在 checkinAccount），列表展示用元数据层。
 */
async function collectAccounts() {
  const accounts = [];
  let app = null;
  try {
    app = readTraeAuthFromApp();
  } catch {
    app = null; // 客户端未安装/未登录/存储异常：降级为仅快照账号
  }

  if (app) {
    const uid = traeUid(app);
    const snaps = store.listAccountsUnique('traework');
    const snap = uid ? snaps.find((s) => s.uid === uid) : null;
    if (snap) {
      // 客户端 token 更新鲜：同步回快照（密封落盘）
      store.writeSealedAccount('traework', {
        name: snap.name,
        uid,
        savedAt: snap.savedAt,
        tokenExpiresAt: app.expiredAt,
        refreshExpiresAt: app.refreshExpiredAt || snap.refreshExpiresAt,
      }, app);
      accounts.push({
        name: snap.name,
        uid,
        source: 'app',
        auth: app,
        tokenExpireDays: daysLeft(app.expiredAt),
        refreshTokenExpireDays: daysLeft(app.refreshExpiredAt),
        tokenExpiresAt: app.expiredAt || null,
        refreshTokenExpiresAt: app.refreshExpiredAt || null,
        savedAt: snap.savedAt || null,
        label: app.account?.username || '',
      });
    } else {
      accounts.push({
        name: '客户端登录',
        uid,
        source: 'app',
        auth: app,
        tokenExpireDays: daysLeft(app.expiredAt),
        refreshTokenExpireDays: daysLeft(app.refreshExpiredAt),
        tokenExpiresAt: app.expiredAt || null,
        refreshTokenExpiresAt: app.refreshExpiredAt || null,
        savedAt: null,
        label: app.account?.username || '',
      });
    }
  }

  const snaps = store.listAccountsUnique('traework');
  for (const snap of snaps) {
    if (app && traeUid(app) && snap.uid === traeUid(app)) continue;
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
    app = readTraeAuthFromApp();
  } catch (e) {
    return { ok: false, msg: `读取 TraeWork 登录信息失败（请先打开 TraeWork 登录）: ${e.message}` };
  }
  if (!app) return { ok: false, msg: '未读到 TraeWork 登录信息，请先打开 TraeWork 并确认已登录' };
  const uid = traeUid(app);
  // 同 uid 已有快照且名称不同：新快照落盘后删除旧快照（重新导入 = 改名 + 刷新凭据）
  const dups = store.listAccounts('traework').filter((s) => s.uid === uid && s.name !== name);
  store.writeSealedAccount(
    'traework',
    {
      name,
      uid,
      savedAt: new Date().toISOString(),
      tokenExpiresAt: app.expiredAt || null,
      refreshExpiresAt: app.refreshExpiredAt || null,
    },
    app // 全量含设备密钥三元组
  );
  let note = '';
  if (dups.length) {
    for (const d of dups) store.removeAccount('traework', d.name);
    note = `，同账号旧快照 ${dups.map((d) => `"${d.name}"`).join('、')} 已删除`;
  }
  return {
    ok: true,
    msg:
      `已导入账号 "${name}"${app.account?.username ? `（${app.account.username}）` : ''}` +
      (app.expiredAt ? `，token 有效期至 ${app.expiredAt}` : '') +
      note,
  };
}

async function removeAccount(name) {
  if (!store.removeAccount('traework', name)) {
    return { ok: false, msg: `未找到账号快照 "${name}"` };
  }
  return { ok: true, msg: `已删除账号快照 "${name}"` };
}

/** 单账号签到：快照账号按需解封 + 临期/失效自动续期并落盘 */
async function checkinAccount(acc) {
  const reloginApp = '，请打开 TraeWork 重新登录';
  let auth;
  let from = 'app';

  if (acc.source === 'snapshot') {
    const snap = store.readSealedAccount('traework', acc.snapName || acc.name);
    if (!snap) {
      return { ok: false, msg: `读取快照 "${acc.name}" 失败（密封数据损坏）${RELOGIN_SNAP}` };
    }
    auth = snap.payload;
    // token 仅 14 天：临期（3 天内）先续，避免两次运行间隔错过窗口
    if (auth.expiredAt && new Date(auth.expiredAt).getTime() < Date.now() + 3 * 86400_000) {
      try {
        log(`[TraeWork] [${acc.name}] token 即将过期，尝试自动续期…`);
        auth = await traeRefreshToken(auth);
        store.writeSealedAccount(
          'traework',
          { name: acc.name, uid: acc.uid, savedAt: snap.meta.savedAt, tokenExpiresAt: auth.expiredAt, refreshExpiresAt: auth.refreshExpiredAt || null },
          auth // 保留设备三元组
        );
        log(`[TraeWork] [${acc.name}] 续期成功，token 有效期至 ${auth.expiredAt}`);
      } catch (e) {
        return { ok: false, msg: `自动续期失败: ${e.message}${RELOGIN_SNAP}` };
      }
    }
  } else {
    auth = acc.auth;
    if (!tokenUsable(auth)) {
      // app 里的 token 过期（超过 14 天没打开应用），用缓存（uid 匹配防串号）
      const cached = store.readCache('traework');
      if (cached && tokenUsable(cached.payload) && (!cached.uid || !auth || cached.uid === traeUid(auth))) {
        const { _deviceId, _privateKeyPEM, _publicKeyPEM } = auth || {};
        auth = { ...cached.payload, _deviceId, _privateKeyPEM, _publicKeyPEM };
        from = 'cache';
      }
    }
  }

  const persist = async (newAuth) => {
    if (acc.source === 'snapshot') {
      const snap = store.readSealedAccount('traework', acc.snapName || acc.name);
      store.writeSealedAccount(
        'traework',
        { name: acc.name, uid: acc.uid, savedAt: snap?.meta.savedAt, tokenExpiresAt: newAuth.expiredAt, refreshExpiresAt: newAuth.refreshExpiredAt || null },
        newAuth
      );
    } else if (!acc.uid || !store.listAccountsUnique('traework').some((s) => s.uid === acc.uid)) {
      store.writeCache('traework', acc.uid, {
        token: newAuth.token,
        refreshToken: newAuth.refreshToken,
        expiredAt: newAuth.expiredAt,
        refreshExpiredAt: newAuth.refreshExpiredAt || null,
        host: newAuth.host,
        userId: newAuth.userId,
      });
    }
  };

  let result = await traeCheckinWith(auth);
  if (result.authError) {
    log(`[TraeWork] [${acc.name}] token 失效，尝试用 refreshToken 自动续期…`);
    try {
      auth = await traeRefreshToken(auth);
      await persist(auth);
      log(`[TraeWork] [${acc.name}] 续期成功，token 有效期至 ${auth.expiredAt}`);
      result = await traeCheckinWith(auth);
    } catch (e) {
      const hint = acc.source === 'snapshot' ? RELOGIN_SNAP : reloginApp;
      return { ok: false, msg: `token 已失效且自动续期失败（${e.message}）${hint}` };
    }
  }
  if (result.authError) {
    return { ok: false, msg: `续期后仍认证失败${acc.source === 'snapshot' ? RELOGIN_SNAP : reloginApp}` };
  }
  if (result.ok && from === 'cache') result.msg += '（使用缓存 token，建议打开一次 TraeWork）';
  return result;
}

/** 取账号 auth：快照账号按需解封（只读，不续期、不落盘） */
function traeCreditsAuth(acc) {
  if (acc.source !== 'snapshot') return acc.auth;
  const snap = store.readSealedAccount('traework', acc.snapName || acc.name);
  return snap ? snap.payload : null;
}

/**
 * 当前可用积分余额（只读查询，绝不触发领取）：
 * usage_summary.total_amount - consumed_amount，等价于各权益包 credits_limit 剩余之和
 * （实测 Σcredits_limit === total_amount、Σusage.credits_amount === consumed_amount）。
 */
async function getCredits(acc) {
  const auth = traeCreditsAuth(acc);
  if (!auth?.token) return { ok: false, msg: `读取账号 "${acc.name}" 登录信息失败` };
  const host = auth.host || 'https://api.trae.cn';
  const r = await jsonRequest(`${host}/trae/api/v2/pay/ide_user_ent_usage`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Cloud-IDE-JWT ${auth.token}`,
      'x-device-id': auth._deviceId || '',
    },
  });
  if (r.status === 401) return { ok: false, msg: 'token 已失效，下次签到时自动续期' };
  if (!r.ok) return { ok: false, msg: `查询积分失败: ${r.msg || `HTTP ${r.status}`}` };
  const s = r.body?.usage_summary;
  if (!s) return { ok: false, msg: '响应缺少 usage_summary 字段' };
  return { ok: true, credits: Number(s.total_amount || 0) - Number(s.consumed_amount || 0), msg: '' };
}

module.exports = {
  key: 'traework',
  name: 'TraeWork',
  noAccountMsg: '未找到 TraeWork 登录信息，请打开 TraeWork 登录，或登录后运行 node checkin.js --save traework <名称> 导入快照',
  collectAccounts,
  importAccount,
  removeAccount,
  checkinAccount,
  getCredits,
};
