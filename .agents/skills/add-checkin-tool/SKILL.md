---
name: add-checkin-tool
description: 向本仓库（AI 工具每日签到项目）接入新的工具每日签到。当用户说"给 XXX 加签到""接入新工具签到""再签到一个工具"，或提到某个 AI 工具/桌面客户端的每日签到、积分领取、免费额度时使用。覆盖接口逆向、凭据解密、代码接入与校验的完整流程。
---

# 接入新的签到工具

## 项目现状（30 秒了解）

- 工具实现在 `lib/tools/` 下，每工具一个模块，导出统一契约（key/name/collectAccounts/importAccount/removeAccount/checkinAccount），`lib/core/runner.js` 启动时**自动发现**——放一个新文件即接入
- `checkin.js` 是 CLI 薄壳；`server.js` 是本地 Web 管理台（127.0.0.1）；`run-checkin.bat` 由计划任务 **AI-Daily-Checkin** 每天 10:10 调用
- **加新工具 = `lib/tools/xxx.js` 一个文件 + README 一节**，CLI/前端/计划任务/runner 都不用改
- 三个现成实现是模式参考，动手前先读源码：
  - `workbuddy.js` — 简单模式：明文 JSON 凭据 + Bearer token
  - `traework.js` — 复杂模式：AES blob 解密 + 14 天过期 token + 设备密钥签名续期 + DPAPI 快照
- 各工具已验证的接口细节记录在 `README.md` 的"签到机制"一节

## 开始前向用户确认

1. 工具名称；是否已安装**桌面端**；是否已登录
2. 整个方案依赖读取本地登录态——纯网页版工具不适用（需要用户手动导出 cookie，会退化成定期手动维护，先向用户说明再继续）
3. 如果可行，让用户打开该工具并手动点一次签到：客户端日志里立刻就有真实请求，能省一半调查时间

## 阶段一：逆向调查

目标产物是一张**接口卡片**：

```
工具名：
域名：
查状态接口：POST ...
领取接口：  POST ...
必须 headers：（逐个列出，含取值来源）
必须 body：  （逐字段，能空就空）
凭据位置：   （绝对路径 + 明文/加密 + 解密方式）
token 有效期 / refresh 接口：
```

调查顺序（详细操作和现成脚本见 `references/investigation-playbook.md`）：

1. **找接口**：先翻客户端日志，搜 `checkin|签到|claim|credit|sign`；日志是二进制或没有，再 grep 应用 resources 里的 JS bundle（埋点枚举常泄露接口名）
2. **定位凭据**：按 playbook 的凭据模式清单排查，从明文 JSON → 加密 blob → Chromium storage → DPAPI 依次升级
3. **弄清认证**：header 形态、device id 语义、**body 必须与真实请求逐字段一致**
4. **token 生命周期**：有效期多长、失效后有无 refresh 接口

## 阶段二：接入代码

契约（必须遵守，完整说明见 AGENTS.md）：

- 模块导出 `key` / `name` / `collectAccounts` / `importAccount` / `removeAccount` / `checkinAccount`（可选 `noAccountMsg`）
- `checkinAccount(handle)` 返回 `{ok: boolean, msg: string}`，**不抛异常**（错误转成 `{ok:false, msg}`）
- **先查状态再领取**（幂等）：`today_checked_in` / `checked_in` 为真直接返回"今日已签到"
- 凭据每次运行现读；落盘只允许 DPAPI 密封（`lib/core/store.js` 的 `writeSealedAccount`）；token 打印必须掩码
- token 有效期 < 90 天的工具要实现续期：参照 `traework.js` 的快照 + refresh 重试模式
- 快照账号 uid 优先取登录态里的稳定 id（userId / user.id），保证按 uid 去重正确

最小模块骨架（存为 `lib/tools/xxx.js`，runner 自动发现，无需注册）：

```js
'use strict';
const fs = require('fs');
const { postJson } = require('../core/http');
const store = require('../core/store');

async function readToken() {
  // 读凭据（失败 → 请用户先打开该工具登录）
  return JSON.parse(fs.readFileSync(authPath, 'utf8')).token;
}

async function collectAccounts() {
  // 客户端登录态（try/catch 失败降级为仅快照）+ data/accounts/xxx/ 快照，按 uid 去重
  // app 优先且同步回快照（参照 qoder.js / traework.js 的实现）
}

async function importAccount(name) { /* 客户端当前登录 → store.writeSealedAccount */ }
async function removeAccount(name) { /* store.removeAccount */ }

async function checkinAccount(acc) {
  // 1) 查状态（有状态接口就查，防重复领取）
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const st = await postJson(statusUrl, headers, {});
  if (!st.ok) return { ok: false, msg: `查询签到状态失败: ${st.msg}` };
  if (st.body.data?.checked_in) return { ok: true, msg: '今日已签到' };

  // 2) 领取（body 与抓包逐字段一致）
  const r = await postJson(claimUrl, headers, {});
  if (!r.ok || r.body.code !== 0) {
    return { ok: false, msg: `签到失败: code=${r.body?.code} ${r.body?.message || r.msg}` };
  }
  return { ok: true, msg: `签到成功 +${r.body.data?.credit ?? '?'} 积分` };
}

module.exports = {
  key: 'xxx', name: 'XXX',
  noAccountMsg: '未找到 XXX 登录信息，请打开 XXX 登录，或运行 node checkin.js --save xxx <名称> 导入快照',
  collectAccounts, importAccount, removeAccount, checkinAccount,
};
```

## 阶段三：校验流程

**六步全部通过才算接入完成**，任何一步失败修复后从第一步重跑：

1. **语法**：`node --check lib/tools/xxx.js`（及改动的其他 js）通过
2. **干跑认证**（在写模块之前做）：写临时脚本只调**状态接口**，确认 HTTP 200 且业务 code=0。
   绝不用领取接口测试认证——领取接口普遍有频控，乱测会触发限频污染当天状态
3. **首跑**：`node checkin.js`，新工具 ✅（签到成功或今日已签到），且老工具结果不受影响
4. **幂等**：紧接着再跑一次，新工具必须报"今日已签到"，不得出现第二次领取请求
5. **日志**：`checkin.log` 正常追加，输出里没有 token 明文
6. **计划任务链路**：`Start-ScheduledTask -TaskName 'AI-Daily-Checkin'` 触发一次，
   `LastTaskResult` 为 0，`checkin.log` 有新记录

测试后删除临时脚本（`_test_*.js` 之类的调查产物不留仓库）。

## 注意事项（每条都是真实踩过的坑）

- **body 逐字段一致**：TraeWork 领取接口 body 多带一个字段就返回 9074 限频。抓到什么发什么，别自作主张加参数
- **设备 ID 语义陷阱**：`x-device-id` 这类头往往要专门的设备 ID（如 aha 设备 ID，藏在凭据文件键名里），不是 machineid 也不是随便的 UUID
- **token 掩码**：所有调试输出 `token.slice(0, 12) + '...'`；token 不写进日志、README、缓存之外的任何地方
- **文件锁**：应用运行时 Chromium 的 Cookies/Local Storage 文件无法复制读取——先找无锁的凭据源，实在不行请用户暂时退出应用
- **二进制/大文件**：`.ldb`、AALG 压缩日志用 grep 极慢且常无结果，一律用 Node 脚本 `indexOf` 扫上下文（playbook 有现成写法）
- **Git Bash + PowerShell**：内联命令里 `$var`、`$_` 会被 bash 吞掉 → 写 `.ps1` 文件执行；ps1 含中文必须注意编码（存 ASCII 或带 BOM）
- **日期边界**：签到按服务器日（通常北京时间 0 点）重置，23:50 之后不做领取测试，避免跨日歧义
- **凭证失效路径**：token 过期 + 自动续期失败时，msg 必须明确告诉用户"打开 XXX 重新登录"，这是唯一的恢复手段

## 收尾

1. `README.md` "签到机制"一节补充新工具小节：域名、接口、凭据位置与解密方式、token 有效期、多账号快照设计——这张接口卡片是客户端改版后重新抓包的对照基线
2. 确认交付物清单：`lib/tools/xxx.js` 新模块 + README 小节，无临时文件残留
