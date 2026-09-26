# AGENTS.md — AI 工具每日签到

本文件是本仓库的项目级工作约定，AI 编码助手在本目录作业时**先读这里，再读 `README.md`**。

## 项目是什么

一个 Windows 单机自动化系统：每天定时读取各 AI 桌面客户端**本地登录态**，调对应接口领取每日签到积分；多应用、多账号，附本地 Web 管理台。
已接入：**WorkBuddy（腾讯）**、**TraeWork（TRAE SOLO CN，字节）**、**Qoder CN（阿里）**。

设计前提：**只读本机客户端凭据，不引入任何第三方依赖，不需要用户日常维护**。

## 文件职责

| 文件 / 目录 | 角色 | 改动注意 |
|------|------|---------|
| `checkin.js` | CLI 入口（薄壳）：参数解析 → `lib/core/runner` | 加工具**不用改这里** |
| `server.js` | Web 管理台入口（仅绑 127.0.0.1） | API 与静态页面路由；`/api/credits` 只回 name/source/credits/msg，无凭据 |
| `lib/core/http.js` | 请求封装（postJson / jsonRequest） | Qoder 的"POST 无 body"语义不得合并进 postJson |
| `lib/core/log.js` | 统一日志（console + 追加 `checkin.log`） | **独家**写日志；bat 不再重定向 |
| `lib/core/dpapi.js` | DPAPI protect/unprotect（借道 PowerShell） | 只传 base64，不回显明文 |
| `lib/core/store.js` | `data/` 管理 + DPAPI 密封信封 + 旧数据迁移 | 迁移必须幂等、失败只告警 |
| `lib/core/runner.js` | 工具注册表（自动发现 `lib/tools/*.js`）+ 编排（签到 / 积分查询）+ publicView 白名单 | 契约校验 fail fast |
| `lib/tools/<tool>.js` | 每工具一个模块（统一契约） | **加工具只加这里一个文件** |
| `web/` | 管理台前端（原生 HTML/JS/CSS） | 展示数据只能来自 API 白名单字段 |
| `README.md` | **接口基线文档**："签到机制"一节是改版后重新抓包的对照基线 | 接入新工具必须补一节 |
| `run-checkin.bat` | 计划任务入口，自动定位 Node | 保持"自动定位 Node"，禁止写死路径；不要加回日志重定向 |
| `register-task.ps1` | 一键部署：探测本机 Node → 写 `node-path.txt` → 注册计划任务 `AI-Daily-Checkin`（每天 10:10） | 必须 ASCII-only、幂等 |
| `node-path.txt` | 本机 Node 路径缓存，由 ps1 生成 | 机器相关，勿当模板 |
| `data/` | 运行时数据：`accounts/<tool>/` 快照、`cache/` token 缓存、`last-run.json` | 脚本维护，勿手工编辑，勿提交/拷贝 |

`checkin.log` 是运行日志；`data/` 含机器/账号敏感信息（快照与缓存虽经 DPAPI / at-rest 密封，仍**不要写进文档、不要提交版本库、不要跨机拷贝**）。

## 硬性契约（改 `lib/tools/*` 或 `lib/core/*` 必须遵守）

- 工具模块统一契约：`key` / `name` / `collectAccounts` / `importAccount` / `removeAccount` / `checkinAccount`（可选 `noAccountMsg`、`getCredits`），runner 自动发现，缺导出启动即报错。
- `checkinAccount(handle)` **同步返回 `{ok: boolean, msg: string}` 语义，绝不抛异常**——所有错误收敛为 `{ok:false, msg}`（runner 亦兜底 try/catch）。
- `getCredits(acc)`（可选）**只读**查询当前可用积分余额，返回 `{ok, credits, msg}`，同样绝不抛异常、绝不触发领取；口径统一为"当前可用余额"，单位 credits。积分查询**不自动续期**（token 失效返回 `{ok:false, msg:'token 已失效…'}`），续期由签到流程负责。`runner.collectCredits()` 全串行编排，单账号失败只标红该行；未实现该方法的工具标为"该工具未提供积分查询"。
- `handle` 为不透明凭据对象：只传回 `checkinAccount`，**永不序列化**；CLI/前端展示一律走 `runner.publicView` 字段白名单（name/uid 掩码/source/tokenExpireDays/refreshTokenExpireDays/到期时间/快照导入时间/账号标识 label）。白名单只放非凭据信息，**token 与 refreshToken 本体永不入白名单**。
- **先查状态再领取**（幂等）：状态接口报已签直接返回"今日已签到"，不得再发领取请求。领取接口普遍有频控。
- 请求 body / headers **与真实客户端抓包逐字段一致**，不自行增删字段（TraeWork 领取多带字段即 9074 限频；Qoder 领取 POST 无 body 无 Content-Type）。
- 凭据**每次运行现读**，落盘只允许 DPAPI 密封（TraeWork/Qoder，经 `lib/core/store.js`）或 WorkBuddy at-rest 信封；token 输出必须掩码（`slice(0,12)+'...'`）。
- token 有效期 < 90 天的工具**必须实现续期**：新 token 写本项目快照/缓存（`data/`），不回写应用存储（避免与应用内存态竞争）。TraeWork 快照续期时必须**保留设备密钥三元组**。
- 快照账号临期主动续期（WorkBuddy 3 天 / TraeWork 3 天 / Qoder 7 天），401 兜底续期；客户端登录态（source='app'）交给客户端自己刷新。
- 凭据彻底失效时，`msg` 必须明确告知"打开 XXX 重新登录"或"重新 --save 导入"——这是唯一恢复手段。
- **全串行**：工具间、账号间均串行执行，禁用 `Promise.all` 并发签到（频控 + 快照文件读改写竞争）。

## 最小改动原则

- 单机脚本，**不做抽象/配置化/兼容层**：不要引依赖、不要加配置文件、不要为假想需求设计。
- **加工具 = `lib/tools/` 新文件 + `README.md` 小节**；CLI、前端、runner、计划任务**都不用改**。
- 所有路径基于脚本自身位置（`__dirname` / `%~dp0` / `%PSScriptRoot`）与系统环境变量，**不依赖盘符或用户名**。

## 常用命令

```bash
node checkin.js                        # 全部工具全部账号签到
node checkin.js --list                # 账号总览（token 剩余天数）
node checkin.js --save workbuddy 主号  # 导入客户端当前登录账号为快照
node checkin.js --remove workbuddy 主号 # 删除账号快照
node checkin.js --run traework        # 只跑某一个工具

node server.js                         # Web 管理台 http://127.0.0.1:8787
node --check checkin.js                # 语法检查（改动涉及的每个 js 都要过）
```

计划任务：`Start-ScheduledTask -TaskName 'AI-Daily-Checkin'` / `Get-ScheduledTaskInfo -TaskName 'AI-Daily-Checkin'`

## 修改后的验证清单

任何触碰签到逻辑（`lib/`、`checkin.js`）的改动，按序走完：

1. 全部涉及文件 `node --check` 通过（含 `web/app.js`、`server.js`）
2. **干跑认证只用状态接口**（写临时脚本，确认 HTTP 200 且业务 code=0）。**绝不用领取接口测认证**
3. `node checkin.js`：目标工具 ✅，且其他工具结果不受影响
4. 紧接着再跑一次：必须报"今日已签到"，不得出现第二次领取请求
5. `checkin.log` 正常追加（行无重复）、输出无 token 明文
6. 触发计划任务一次，`LastTaskResult` 为 0
7. 删除所有临时调查脚本（`_test_*.js` 等不留仓库）

## 加新工具

完整流程（接口逆向 → 凭据解密 → 接入 → 校验）见技能
[.agents/skills/add-checkin-tool/SKILL.md](.agents/skills/add-checkin-tool/SKILL.md)，
调查细节与已知坑见 [.agents/skills/add-checkin-tool/references/investigation-playbook.md](.agents/skills/add-checkin-tool/references/investigation-playbook.md)。

## 环境与坑

- 目标环境 **Windows + Node 18+（用内置 `fetch`）**，无第三方依赖；PowerShell 5.1。
- **编码**：`.ps1` 必须 ASCII-only 或带 BOM（UTF-8 无 BOM 会被 PS5.1 当 ANSI 读，任务名乱码）；计划任务名保持英文。
- **Git Bash + PowerShell**：内联命令里 `$var`/`$_` 会被 bash 吞掉 → 写 `.ps1` 文件执行。
- **PowerShell 5.1 发非 ASCII JSON body 会乱码**（默认 ISO-8859-1）：测 Web API 用 Node fetch 或浏览器，别用 `Invoke-WebRequest -Body`。
- **大文件/二进制**（`app.asar`、`.ldb`、AALG 日志）：`grep` 极慢或无效 → 用 Node `indexOf` 扫上下文。
- **Chromium 存储文件锁**：应用运行时无法读取/复制 Cookies、Local Storage → 先找无锁凭据源，必要时请用户退出应用。
- **DPAPI 机器绑定**：`data/` 下快照/缓存不可跨机器/跨 Windows 用户使用。
- **日期边界**：签到按服务器日重置，23:50 之后不做领取测试；避开 Qoder 09:50–10:05 活动窗口边界。
- 客户端更新导致接口变更时，按 README 记录的日志位置重新抓包（WorkBuddy `main.log`、Trae 系 `ttnet fetch` 行、Qoder `[Campaign] 活动状态请求` 行）。
