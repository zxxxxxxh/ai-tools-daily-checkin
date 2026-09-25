# 重构计划：多应用多账户 + 本地 Web 管理台

## Context

当前项目是单文件 `checkin.js`（858 行）：WorkBuddy 已支持多账号快照，TraeWork / Qoder CN 仅支持单账号（每次读客户端登录态）。用户要求重构为**多应用、多账户登录 + 简单前端管理**，文件按功能规划存放，并保证新工具接入的扩展性。

已确认的决策：
- 三个工具全部多账号化（快照导入 + 自动续期），架构可扩展新工具
- 前端：Node 内置 `http` 起本地 Web 管理台（仅绑 127.0.0.1，零第三方依赖）
- 调度保持计划任务（每天 10:10 → run-checkin.bat → node checkin.js）不变；server.js 按需手动启动

## 目标目录结构

```
checkin.js            CLI 薄壳：参数解析 → lib/runner（计划任务路径不变）
server.js             Web 管理台入口（node server.js，默认 127.0.0.1:8787，--port 可覆盖）
run-checkin.bat       仅去掉日志重定向（log.js 接管落盘，避免双写）
register-task.ps1     零改动
lib/
  core/http.js        postJson / jsonRequest（从 checkin.js 抽出，语义逐字段保留）
  core/log.js         统一日志：console + 追加项目根 checkin.log
  core/dpapi.js       DPAPI protect/unprotect（借道 PowerShell，Qoder 现有 unprotect 上移 + 新增 protect）
  core/store.js       data/ 目录管理 + DPAPI 密封信封 + 旧数据一次性迁移
  core/runner.js      工具注册表（自动 require lib/tools/*.js）+ runAll/runTool/runAccount + publicView 白名单
  tools/workbuddy.js  纯搬运（checkin.js 59-419 行），仅快照目录改为 data/accounts/workbuddy/
  tools/traework.js   多账号化（重点）
  tools/qoder.js      多账号化
web/                  index.html + app.js + style.css（原生 JS 单页）
data/                 运行时生成（不进版本库，新增 .gitignore）
  accounts/<tool>/<name>.json
  cache/<tool>.json
  last-run.json
```

## 统一工具模块契约（扩展性的核心）

```js
module.exports = {
  key: 'traework',               // 稳定 id：目录名 / CLI 参数 / API 值
  name: 'TraeWork',              // 展示名
  async collectAccounts(),       // 客户端登录态 + 快照合并去重（uid 去重，app 优先并同步回写）
  async importAccount(name),     // 客户端当前登录 → 快照 → {ok,msg}
  async removeAccount(name),     // → {ok,msg}
  async checkinAccount(handle), // → {ok,msg}；内部处理续期落盘；绝不抛异常
}
```

- runner 自动发现 `lib/tools/*.js`（字典序），缺导出启动即报错（fail fast）。**加新工具 = 放一个新文件 + README 补一节，CLI/前端/计划任务零改动。**
- `handle` 为不透明凭据对象，只传回 `checkinAccount`，永不序列化；CLI/前端展示用字段白名单（name/uid/source/tokenExpireDays/refreshTokenExpireDays）派生。
- **全串行**：工具间、账号间均 for 串行，无 Promise.all（频控 + 快照文件读改写竞争）。

## 多账号设计

### 快照文件格式（traework / qoder）
明文元数据外壳 + DPAPI 密封 payload 内芯：
```
{ format:1, tool, name, uid, savedAt, tokenExpiresAt, refreshExpiresAt,
  sealed: <base64 DPAPI(JSON{ token, refreshToken, ...凭据/设备密钥 })) }
```
- WorkBuddy 快照沿用现有 at-rest 密封格式（不动，仅挪目录）
- uid：TraeWork 取 `auth.userId`（兜底 JWT payload 解码）；Qoder 取 `auth.user.id`（缺失时 refreshToken SHA-256 前 16 位降级）
- TraeWork 快照必须密封保存**设备密钥三元组**（`_deviceId/_privateKeyPEM/_publicKeyPEM`，续期签名必需）；客户端轮换 dc 密钥后续期失败 → msg 引导 `node checkin.js --save traework <名称>` 重新导入
- 客户端登录态读取失败降级为"仅跑快照账号"（try/catch → null，不炸整个工具）
- 快照临期主动续期：WorkBuddy 3 天 / TraeWork 3 天（token 仅 14 天）/ Qoder 7 天；401 兜底续期
- TraeWork 续期写快照时**保留设备三元组**（现有代码是删 `_privateKeyPEM`，那是针对 cache 的）；app 来源且无同 uid 快照 → 写 `data/cache/<tool>.json`（sealed，含 uid 防串号）

### 旧数据迁移（store.init() 幂等，CLI/server 入口调用）
1. `workbuddy-accounts/*.json` → `data/accounts/workbuddy/`（rename，内容零转换，删旧目录）
2. `trae-token.cache.json` / `qoder-token.cache.json` → 读明文 → DPAPI 密封 → `data/cache/`，删旧文件（**保留可能已轮换的 refreshToken**）
3. 每步 try/catch，失败仅告警不阻断

## CLI（全新统一，不保留 --wb-*，文档同步改）

```
node checkin.js                       # 全部签到（计划任务路径）
node checkin.js --list [<tool>]
node checkin.js --save <tool> <name>  # 导入客户端当前登录为快照
node checkin.js --remove <tool> <name>
node checkin.js --run <tool>
```
退出码：0 全成功；1 有失败；2 用法错误。

## server.js API（内置 http，仅绑 127.0.0.1，无鉴权）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/tools | 工具+账号列表（白名单字段） |
| GET | /api/last-run | data/last-run.json |
| GET | /api/run/status | 运行中状态 |
| POST | /api/run | `{tool?, account?}` 触发签到，202 立即返回；运行中 409 |
| POST | /api/accounts | `{tool, name}` 导入快照 |
| DELETE | /api/accounts?tool=&name= | 删除快照 |
| GET | /api/log?lines=200 | checkin.log 尾部（≤1000 行） |
| GET | / /app.js /style.css | web/ 静态文件（路径防穿越） |

签到异步化：POST run 启动 runner 立即 202，前端轮询 status + last-run。JSON body 限 64KB。

## 前端（web/，原生 JS 单页）

- 顶栏：标题 + [全部签到] + 运行状态指示
- 工具卡片区（每工具一卡）：账号行（名称/uid 前 8 位/来源徽标/token 剩 N 天 <3 红 <7 黄/上次结果/[签到][删除]），卡尾导入框
- 上次运行摘要 + 日志面板（尾部 200 行，运行中每 2s 自动刷新）

## 其他改动

- **run-checkin.bat**：仅去掉 `>> checkin.log 2>&1` 重定向（log.js 独家落盘，防双写）；新 checkin.js 加 `process.on('uncaughtException')` 兜底写日志 exit 1
- **.gitignore**（新增）：`data/`、`checkin.log`、`node-path.txt`、`workbuddy-accounts/`
- **README.md**：组成表、使用节重写（新 CLI + `node server.js`）、三工具各补多账号快照小节、注意事项加 DPAPI 机器绑定与回环绑定
- **AGENTS.md**：文件职责表、硬性契约（模块契约/handle 不序列化/DPAPI 密封/全串行）、常用命令、验证清单、最小改动原则（加工具 = lib/tools 新文件 + README 小节）
- **.agents/skills/add-checkin-tool/SKILL.md**：接入流程改为模块骨架模式

## 实施顺序（每步验证）

**铁律：所有真实签到验证只在"当日已签"的幂等安全态下进行（先跑旧版完成当日签到）；绝不构造领取请求测认证；避开 23:50 后与 Qoder 09:50-10:05 窗口。**

1. **阶段 0 基线**：跑现有 `node checkin.js` 完成当日签到（进入安全态），留存输出
2. **阶段 1 lib/core 基础件**（http/log/dpapi）：`node --check`；DPAPI protect→unprotect roundtrip；log 追加格式与旧格式一致
3. **阶段 2 store.js**：seal/open roundtrip；safeName 边界（中文/空格/`/`）。不执行迁移（旧入口还在跑）
4. **阶段 3 工具模块 + runner**（旧 checkin.js 原样保留）：`node --check`×4；loadTools() 契约校验；traework/qoder `importAccount('test')` → collectAccounts 出现 → removeAccount（纯本地无网络）；workbuddy 仅加载验证
5. **阶段 4 切换日**（一次性完成）：新 checkin.js 薄壳 + bat 去重定向 + 迁移接线。验证：
   - 全部 js `node --check`
   - `--list` 三工具正常，WorkBuddy 两快照迁移完整（uid/envelope 逐字节一致），旧目录已删
   - `node checkin.js` 三工具"今日已签到"（无领取请求）；再跑一次仍"今日已签到"
   - checkin.log 行无重复、无 token 明文
   - `Start-ScheduledTask 'AI-Daily-Checkin'` → LastTaskResult 0
   - `--save traework 测试` / `--remove` 冒烟
6. **阶段 5 server.js + web/**：netstat 确认仅 127.0.0.1；浏览器走通总览/导入/删除/日志；运行中二次 POST run 得 409；路径穿越被拒
7. **阶段 6 文档**：README / AGENTS / SKILL.md / .gitignore
8. **阶段 7 收尾**：删除所有 `_test_*` 临时产物；全量 `node --check`；计划任务再触发一次确认稳定

## 风险与已知限制

- 续期路径无法主动实测（不能安全制造过期 token）——靠逐行搬运 + diff review，首次真实续期时观察日志
- TraeWork 设备密钥轮换 → 旧快照续期失败（msg 引导重导入，设计内降级）
- DPAPI 快照/缓存不可跨机器/跨 Windows 用户迁移（README 注明）
- server 与计划任务无跨进程锁，靠"先查状态再领取"幂等兜底
