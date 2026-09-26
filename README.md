# AI 工具每日自动签到

多应用、多账户的 AI 工具每日签到自动化：读取各 AI 桌面客户端**本地登录态**，调对应接口领取每日签到积分，并附本地 Web 管理台。

已接入：**WorkBuddy（腾讯）**、**TraeWork（字节，TRAE SOLO CN 桌面端）**、**Qoder CN（阿里，Qoder CN 桌面端）**。
三个工具均支持**多账号**：客户端当前登录 + 任意数量账号快照，快照由脚本每日签到并自动续期维护。

## 组成

| 文件 / 目录 | 说明 |
|------|------|
| `checkin.js` | CLI 入口（Node 18+，无第三方依赖）：参数解析 → `lib/` |
| `server.js` | 本地 Web 管理台入口：`node server.js` → http://127.0.0.1:8787 |
| `lib/core/` | 公共件：`http`（请求封装）、`log`（统一日志）、`dpapi`（DPAPI 密封）、`store`（data/ 存储 + 迁移）、`runner`（工具注册表 + 编排） |
| `lib/tools/` | 工具模块（每文件一个工具，自动发现；**加新工具放一个文件即可**）：`workbuddy.js` / `traework.js` / `qoder.js` |
| `web/` | 管理台前端（原生 HTML/JS/CSS 单页） |
| `data/` | 运行时数据（自动生成，机器相关，勿提交/拷贝）：`accounts/<tool>/` 账号快照、`cache/` token 缓存、`last-run.json` 最近结果 |
| `run-checkin.bat` | 计划任务入口，自动定位 Node（日志由脚本写入 `checkin.log`） |
| `register-task.ps1` | 一键安装：自动检测本机 Node 写配置 + 注册计划任务（每天 10:10） |
| `node-path.txt` | 本机 Node 路径缓存（`register-task.ps1` 自动生成，bat 运行时读取） |
| `checkin.log` | 运行日志（`lib/core/log.js` 独家写入） |

### 架构：工具模块契约

`lib/tools/` 下每个模块导出统一契约，`lib/core/runner.js` 启动时自动加载（字典序、缺导出即报错）：

```js
module.exports = {
  key: 'xxx',              // 稳定 id：CLI 参数 / API / data 目录名
  name: 'XXX',             // 展示名（日志、卡片标题）
  noAccountMsg: '...',     // 无账号时的提示（可选）
  async collectAccounts(), // 客户端登录态 + 快照合并去重（uid 去重，app 优先并同步回写）
  async importAccount(name), // 客户端当前登录 → 快照
  async removeAccount(name),
  async checkinAccount(handle), // 单账号签到 → {ok, msg}；内部处理续期落盘；绝不抛异常
  async getCredits(acc),   // 当前可用积分余额（只读查询）→ {ok, credits, msg}；可选，绝不触发领取
};
```

**加新工具 = 在 `lib/tools/` 放一个符合契约的文件 + README 补一节**，CLI / 前端 / 计划任务零改动。

## 签到机制（逆向自桌面客户端）

### WorkBuddy

- 域名 `https://www.codebuddy.cn`
- 查状态：`POST /v2/billing/meter/checkin-activity-status`
- 领取：`POST /v2/billing/meter/daily-checkin`
- 请求头：`Authorization: Bearer <token>`、`X-User-Id`、`X-Domain`
- 凭据位置：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
- 客户端 5.6（2026-09）起 accessToken/refreshToken 从明文改为 `{$wbEncrypted:1, envelope}`
  加密信封（nickname/phoneNumber 同），算法复刻自客户端 `packages/at-rest-crypto`：
  - envelope = base64(JSON `{suite:1, keyId, nonce, authTag, ciphertext}`)
  - key = SHA256(编译期静态 atRestSecretKey 字符串)，keyId = SHA256(key) 前 16 位 hex
  - AES-256-GCM，AAD = `"WB-AAD\0" ‖ [1] ‖ lp("WBEV1") ‖ lp("sym-v1") ‖ u32BE(1)
    ‖ lp(keyId) ‖ [2] ‖ [0] ‖ [0]`（lp = u32BE 长度前缀，2 = field framing）
  - 静态钥无明文落盘（WorkBuddy.exe 内 `workbuddyStorage.loggerGet()` 混淆存储），
    5.6.2 的 atRestSecretKey 提取自运行中主进程内存，keyId `9127dea1b44020a7`
  - 客户端大版本更新若轮换静态钥，脚本报"静态钥不匹配"：重启 WorkBuddy 后用
    只读内存扫描主进程搜 `atRestSecretKey` 重新提取，替换 `lib/tools/workbuddy.js` 内常量
- accessToken 约 55 天有效、refreshToken 约 60 天有效。客户端登录态的 token 由客户端
  打开时自动刷新；**快照账号**（`data/accounts/workbuddy/`，沿用 at-rest 信封密封）由脚本维护：
  - 续期接口：`POST /v2/plugin/auth/token/refresh`（`/plugin` 为客户端运行时
    prefixPath，见客户端日志 `[AuthApiClient] Using prefixPath from genie plugin`）
  - 请求头：`X-Refresh-Token: <明文 refreshToken>`、`X-Domain`、
    `X-Auth-Refresh-Source: plugin`，body `{}`；响应 `data` 为**明文** 新
    accessToken/refreshToken（at-rest 加密只发生在客户端落盘时），refreshToken 滚动轮换，
    旧 refreshToken 有宽限期（重复使用不会立即失效，与客户端并行刷新互不干扰）
  - 快照账号 token 剩 3 天内时主动续期，401 时兜底续期；新 token 用同样的
    at-rest 算法**重新密封**后写回快照（快照文件不落明文 token）
- **多账号签到**：在 WorkBuddy 客户端依次登录各账号，每登录一个运行一次
  `node checkin.js --save workbuddy <名称>` 导入快照即可；之后客户端切回常用账号，
  快照账号完全由脚本每日签到 + 续期维护。签到时按 uid 去重（客户端登录态优先，
  且会把客户端的新 token 同步回对应快照）
- 当前积分：`POST /billing/meter/get-user-resource-summary`（**无 `/v2` 前缀**，
  带 v2 会 404），取 `data.Packages[].CycleRemainCapacity`（本周期剩余额度）求和，单位 credits

### TraeWork（TRAE SOLO CN）

- 域名 `https://api.trae.cn`
- 查状态：`POST /trae/api/v2/ug/checkin_credits/status`
- 领取：`POST /trae/api/v2/ug/checkin_credits/claim`（注意：POST 空 JSON 体 `{}`，带别的字段会被限频 code=9074）
- 每日发放额度以权益包接口为准：`GET /trae/api/v2/pay/user_current_entitlement_list`
  每天生成一个 `每日签到` 包（`entitlement_id: checkin_<日期>_<uid>`），其
  `entitlement_base_info.quota.credits_limit` 即当日发放额——**2026-09-03 及以前 200，
  2026-09-04 起 150**（同日该包 `usage.credits_amount` 是消耗量，不是发放量）
- 领取响应**不回带**本次发放额度，日志额度取状态接口 `credits`（= 当日签到积分，实测 150）。
  状态接口的 `extra_credits` 是**会员/升级加成展示值**（Free 账号文案"升级后 +{extra} credits daily"），
  **不是**本次发放额，**不可与 `credits` 相加**。两处都拿不到时只记"签到成功"不写数字，**禁止用常量兜底**
- 请求头：`Authorization: Cloud-IDE-JWT <token>`、`x-device-id: <aha设备ID>`
  （aha 设备 ID 即 `storage.json` 里 `iCubeAuthInfo://icube-dc:<ID>` 键名中的数字，**不是** machineid）
- 凭据位置：`%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json` 中的
  `iCubeAuthInfo://icube.cloudide`，为 AES-128-CBC 加密 blob（"tc\x05" 魔数），
  解密逻辑复刻自应用内 `out/vs/base/common/byteCrypto.js`：
  KDF = SHA-512(seed) ‖ (Gte⊕Jte) 再整体 SHA-512，取前 16 字节为 key、后 16 字节为 IV，
  明文前 64 字节为 SHA-512 校验
- token 约 14 天过期。脚本失效时会用 refreshToken + 设备密钥对调
  `POST /trae/api/v3/oauth/ExchangeToken` 自动续期（ECDSA-SHA256 设备签名）
- **多账号快照**（`data/accounts/traework/`）：快照 = 明文元数据 + DPAPI 密封的
  auth 全量 + **设备密钥三元组**（`_deviceId` / `_privateKeyPEM` / `_publicKeyPEM`，
  续期签名必需）。客户端登录其他账号后，`--save traework <名称>` 即可导入；
  快照 token 剩 3 天内主动续期，401 兜底续期，续期结果重新密封写回
- 已知限制：客户端轮换 icube-dc 设备密钥对后，旧快照续期签名会失效，
  msg 会提示重新导入（在 TraeWork 登录该账号后 `--save traework <名称>`）
- 当前积分：`GET /trae/api/v2/pay/ide_user_ent_usage`，取
  `usage_summary.total_amount - consumed_amount`，单位 credits。实测该口径等价于各权益包
  `credits_limit` 剩余之和（Σ`credits_limit` === `total_amount`，Σ`usage.credits_amount`
  === `consumed_amount`）。**注意**：POST 体里带 `req_source` 会 400，只读查询用 GET
  （或 POST 空 JSON 体 `{}`，两者响应一致）

### Qoder CN（阿里）

- 域名 `https://openapi.qoder.com.cn`
- 签到是"活动领取（Campaign Claim）"机制：每天一个 `act-YYYYMMDD-NNN` 活动，
  `actionType: CLAIM_BENEFIT`，`claimStatus: CLAIMABLE` 时可领取 100 积分
- 活动窗口为**北京时间 10:00 → 次日 09:59**（每日重置点 10:00），
  10:10 的计划任务在新活动开放后 10 分钟执行，每天直接领当天新活动
- 查状态：`GET /sash/api/v1/me/campaigns`
- 领取额度只认活动接口回带的 `campaigns[].benefit.amount`（`kind: CREDITS`，实测领取后仍回带）；
  领取响应体本身不含额度，拿不到时只记"签到成功"不写数字，**禁止用常量兜底**
- 领取：`POST /sash/api/v1/me/campaigns/<campaignId>/claim`
  （**POST 无 body、无 Content-Type**，领取逻辑在远端 iframe
  `https://openapi.qoder.com.cn/growth-page/activity-iframe` 的 JS 里，
  bundle 在 `g.alicdn.com/qbase/qoder/<版本>/growth-page/activity-iframe/`）
- 请求头：`Authorization: Bearer <token>`、`Cosy-ClientType: 10`、`User-Agent: Qoder`
  （客户端还会带 `Cosy-Version/Cosy-MachineOS/Cosy-MachineHostname` 及
  `Cosy-MachineId/Token/Code/Type` 机器风控头——后者来自安装目录
  `resources\umid\runtime-info.exe`，实测非必需，最小头集即可）
- 凭据位置：`%APPDATA%\com.qodercn.app.stable\auth.v1.dat`，为 Chromium safeStorage
  `"v10"` 格式：`"v10" + AES-256-GCM(nonce 12B + 密文 + tag 16B)`；
  AES 密钥存于同级 `Local State` 的 `os_crypt.encrypted_key`
  （`"DPAPI"` 前缀 + DPAPI blob，CurrentUser 作用域，脚本借道 PowerShell 解出）
- 明文为 JSON：`{schemaVersion, token, refreshToken, expiresAt, refreshTokenExpiresAt, user}`
- token 约 30 天过期，refreshToken 约 360 天。失效时用 refreshToken 调
  `POST /api/v1/deviceToken/refresh`（body `{"refresh_token": ...}`）自动续期
- **多账号快照**（`data/accounts/qoder/`）：快照 = 明文元数据 + DPAPI 密封的 auth 全量
  （uid 取 `auth.user.id`）。快照 token 剩 7 天内主动续期，401 兜底续期；
  客户端登录其他账号后 `--save qoder <名称>` 导入即可
- 当前积分：`GET /sash/api/v2/me/usage`，取
  `qoderUsage.userQuota.remaining + qoderUsage.addOnQuota.remaining`，单位 credits。
  **注意**：`/sash/api/v1/ai-conversations/credits-summary` 的 `totalCredits` 是**已用量**，
  不是余额，勿混用

## 当前积分统计

Web 管理台顶部「当前积分」面板按**渠道合计 + 账号明细**展示各渠道**当前可用积分余额**，
数据源为 `GET /api/credits`（只读查询，绝不触发领取；全串行执行，单账号失败只标红该行、
不影响其他账号与其他渠道）。三家口径统一为「当前可用余额」，单位均为 credits：

| 渠道 | 查询接口 | 口径 |
|------|---------|------|
| WorkBuddy | `POST /billing/meter/get-user-resource-summary` | Σ `data.Packages[].CycleRemainCapacity` |
| TraeWork | `GET /trae/api/v2/pay/ide_user_ent_usage` | `usage_summary.total_amount - consumed_amount` |
| Qoder CN | `GET /sash/api/v2/me/usage` | `userQuota.remaining + addOnQuota.remaining` |

面板顶部的「全部渠道合计」只是数量参考——**三家 credits 互不通用，不可换算或合并消费**。
积分查询**不做自动续期**：token 失效时该行显示「token 已失效，下次签到时自动续期」，
由每日签到流程负责续期落盘。

## 使用

手动签到（或双击 `run-checkin.bat`）：

```bash
node checkin.js                        # 全部工具全部账号
node checkin.js --run workbuddy        # 只跑某一个工具
```

账号管理（在对应客户端登录目标账号后执行导入）：

```bash
node checkin.js --list                 # 全部工具账号总览（token 剩余天数）
node checkin.js --list workbuddy       # 单工具
node checkin.js --save workbuddy 主号   # 导入客户端当前登录账号为快照
node checkin.js --remove workbuddy 主号 # 删除某个账号快照
```

Web 管理台（本地回环，无鉴权，按需启动）：

```bash
node server.js            # http://127.0.0.1:8787（--port N 换端口）
```

> 改了 `server.js` 或 `web/` 下的文件后**必须重启** `server.js`（无热加载）。
> 浏览器里看到「未知 API」基本都是端口上还跑着改动前启动的旧进程。

页面为左右两栏布局：

- **左侧**：顶部「当前积分」面板（各渠道可用积分合计 + 账号明细，见上一节），
  各工具账号的登录态与详细登录信息（来源＝客户端登录/快照、账号 ID、
  access / refresh token 剩余天数与到期时刻、快照导入时间、最近签到结果），
  以及手动操作（全部/单工具/单账号签到、导入与删除快照、上次运行结果）。
- **右侧**：`checkin.log` 尾部日志（运行中自动刷新），随页面滚动常驻。

展示字段全部来自 `runner.publicView` 白名单，不含任何 token 明文。

计划任务（注册为 `AI-Daily-Checkin`，每天 10:10，错过时间开机补跑）：

```powershell
# 查看 / 手动触发 / 删除
Get-ScheduledTaskInfo -TaskName 'AI-Daily-Checkin'
Start-ScheduledTask -TaskName 'AI-Daily-Checkin'
Unregister-ScheduledTask -TaskName 'AI-Daily-Checkin'
```

## 跨机器免配置（自适应当前电脑）

项目对机器差异做了自适应设计，**换电脑/换用户无需改任何脚本参数**：

- `run-checkin.bat` 运行时**自动定位 Node.js**，查找顺序：`node-path.txt` -> 系统 PATH 中的
  `node` -> 常见安装目录（Program Files / LocalAppData / nvm）。找不到才报错并给出提示。
- `register-task.ps1` 是**一键安装脚本**：自动探测本机 Node 并写入 `node-path.txt`，再注册计划任务。
- 所有运行路径都基于脚本自身位置（`%PSScriptRoot%` / `%~dp0`）/ 系统标准环境变量（`%APPDATA%`、`%LOCALAPPDATA%`），
  不依赖项目所在盘符或用户名。

在任意新电脑上首次部署，只需两件事（都在项目根目录）：

```powershell
node register-task.ps1        # 探测本机 node、写 node-path.txt、注册计划任务
# 或
powershell -ExecutionPolicy Bypass -File register-task.ps1
```

若 Node 安装路径后续变化，重跑一次 `register-task.ps1` 更新 `node-path.txt` 即可。

## 注意事项

- 三个应用**正常使用期间无需任何维护**：脚本每次运行都重新读取应用本地登录态。
- 快照账号由脚本每日续期维护，**无需打开客户端**；但若计划任务连续 60 天（WorkBuddy）/
  180 天（TraeWork）/ 360 天（Qoder CN）以上没跑（refreshToken 过期），快照会失效，
  需在客户端登录该账号重新 `--save` 导入。
- `data/` 内快照与缓存由 **DPAPI（CurrentUser）或 WorkBuddy at-rest 静态钥**密封，
  **不可跨机器/跨 Windows 用户拷贝**；跨机迁移请在目标机器客户端登录后重新导入快照。
- `server.js` 仅绑定 `127.0.0.1` 本机回环、无鉴权，不要改绑 `0.0.0.0` 暴露到局域网。
- 首次运行新版本会自动把旧布局（`workbuddy-accounts/`、`trae-token.cache.json`、
  `qoder-token.cache.json`）迁移到 `data/`，旧文件删除，无需手工处理。
- 客户端更新后若接口变更，按上面机制重新抓包即可（WorkBuddy 看
  `%LOCALAPPDATA%\WorkBuddy\logs\main.log`，TraeWork 看
  `%APPDATA%\TRAE SOLO CN\logs\<日期>\main.log` 中的 `ttnet fetch` 行，
  Qoder CN 看 `%APPDATA%\com.qodercn.app.stable\logs\<日期>\main.log` 中的
  `[Campaign] 活动状态请求` 行）。
