# 逆向调查手册

接入新签到工具时的调查细节。按顺序执行，每步都有"加速技巧"和"已知坑"。

## 1. 找签到接口

### 优先翻日志（最快路径）

客户端日志里的网络请求是现成的真实调用记录。常见位置：

| 应用类型 | 日志位置 |
|---------|---------|
| Electron 应用 | `%LOCALAPPDATA%\<App>\logs\`、`%APPDATA%\<App>\logs\` |
| VS Code 系分支（Trae 类） | `%APPDATA%\<App>\logs\<启动时间戳>\main.log`、`window*\renderer.log` |
| 网络层日志 | `logs\aha_log\networkservice-*.log`（注意：Trae 的这个是 AALG 二进制，读不了） |

搜索关键词：`checkin`、`check_in`、`签到`、`claim`、`credit`、`sign_in`、`daily`。

WorkBuddy 的 `main.log` 里有 `[Checkin] fetchCheckinStatus success` 这样的业务埋点直接带响应体；
Trae 系的 `main.log` 里 `ttnet fetch request <URL>` 行直接给出接口地址——两种都值得先找。

**加速技巧**：让用户先手动点一次签到再翻日志，请求必然在里面。

### 日志没有再挖 JS bundle

安装目录一般在 `C:\Program Files\`、`D:\software\`、`%LOCALAPPDATA%\Programs\`；
Electron 应用的业务代码在 `resources\app.asar` 或 `resources\app\out\*.js`。

**不要用 `grep -r` 扫大 bundle 或 .asar**（慢且引号转义坑多），用 Node 脚本按关键字找上下文：

```js
// node scan.js —— 在大文件里定位关键字及上下文
const fs = require('fs');
const s = fs.readFileSync('D:/software/XXX/resources/app.asar', 'latin1'); // asar 可直接当文本扫
for (const kw of ['checkin', 'checkin_credits', 'claim', 'daily_login']) {
  let idx = 0, n = 0;
  while ((idx = s.indexOf(kw, idx)) !== -1 && n < 8) {
    console.log('===', kw, '@' + idx);
    console.log(s.slice(Math.max(0, idx - 250), idx + 350).replace(/[^\x20-\x7e]/g, '.'));
    idx += kw.length; n++;
  }
}
```

**加速技巧**：埋点/遥测的枚举定义常把接口名排在一起，例如 Trae 的
`{pay_status:[...], checkin_status:[...], checkin_claim:[]}` —— 找到一处就能顺藤摸瓜到
`fetchCheckinCreditsStatus(){ return this.ab("/trae/api/v2/ug/checkin_credits/status",...)}` 这样的真实调用点，
附近通常还有 header 构造函数。

### 从 asar 里抽取单个文件

asar 头部记录了每个文件的 offset/size，可以按偏移直接切出来：

```js
const fs = require('fs');
const fd = fs.openSync('app.asar', 'r');
const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0);
const base = 16 + head.readUInt32LE(12);       // 文件内容区起始
function readEntry(offset, size) {
  const b = Buffer.alloc(size); fs.readSync(fd, b, 0, size, base + offset);
  return b.toString('utf8');
}
// offset/size 从 asar 头部 JSON（文件开头可读到）里查
```

## 2. 定位凭据

按实现成本从低到高排查：

### 模式 A：明文 JSON（最省事）

全局搜含 `accessToken` / `refreshToken` 的 json/info 文件：

```bash
find "$LOCALAPPDATA" "$APPDATA" ~/. -maxdepth 6 -name "*.json" -o -name "*.info" 2>/dev/null
```

WorkBuddy 即此模式：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`，
直接 `JSON.parse` 即用。

### 模式 B：加密 blob 存在 JSON 里

键名通常有暗示（如 `iCubeAuthInfo://icube.cloudide`）。判别特征：base64 值解出来的前几字节是魔数。

- Trae 系 `"tc" \x05` 魔数：AES-128-CBC，KDF 和硬编码密钥的复刻实现就在 `checkin.js` 的
  `traeDecrypt()`，新工具若同源（字节系 iCube 架构）可直接复用，注意确认密钥数组是否同版
- 其他魔数：在 bundle 里搜 `encryptString` / `decryptString` / 魔数字节，找 KDF 函数照抄

### 模式 C：Chromium 存储（Electron 默认 session）

- `Local Storage\leveldb\000xxx.log`：未压缩的近期写入，Node 读 latin1 后正则扫可读片段
- `Network\Cookies`（SQLite）：**应用运行时被锁**，无法复制。先找 A/B 模式的文件，别死磕 Cookies

### 模式 D：DPAPI / safeStorage / 凭据管理器（最难）

- Electron safeStorage：存储值是 `JSON.stringify(electron.safeStorage.encryptString(x))`，
  即 `{"data":"<base64>"}`，DPAPI 加密、绑定用户账户
- 解密需要 PowerShell `[System.Security.Cryptography.ProtectedData]::Unprotect` 或跑一段 electron；
  代价高，先评估：如果 token 有效期长（>60 天）且用户常用该应用，可以考虑**每次运行时借道**
  （如让脚本调用应用自带 CLI），否则向用户说明维护成本后再决定接不接

## 3. 弄清认证语义

已知认证形态目录（新工具大概率是其中之一）：

| 形态 | 已知例子 | 关键点 |
|------|---------|--------|
| `Authorization: Bearer <jwt>` | WorkBuddy（www.codebuddy.cn） | 常配 `X-User-Id`、`X-Domain` 等辅助头 |
| `Authorization: Cloud-IDE-JWT <jwt>` | Trae（api.trae.cn） | 配 `x-device-id` = **aha 设备 ID**（藏在 `iCubeAuthInfo://icube-dc:<ID>` 键名里，≠ machineid） |
| `x-cloudide-token: <token>` | Trae 旧接口 / ExchangeToken | |
| Cookie（session） | 网页版 | 模式 C/D，维护成本高 |

**Body 纪律**：与抓包逐字段一致。TraeWork 教训：领取接口 body 带 `{trae_client, device_id}` → 9074 限频，
空 `{}` → 成功。状态接口容忍度高，先用状态接口验证认证。

**认证失败的信号**：业务 code 1001（Trae）/ 401（通用）→ 走续期或提示重新登录。

## 4. token 生命周期

- 有效期 ≥ 60 天且用户常开应用（如 WorkBuddy）：每次现读即可，不用续期逻辑
- 有效期 < 90 天：实现续期。参照 `traeworkCheckin`：
  1. 认证失败（code 1001/401）或临期 → 调 refresh 接口换新 token
  2. 新 token 写**本项目的 cache 文件**（如 `trae-token.cache.json`），不回写应用的存储
     （避免和应用内存态竞争）；下次运行先看应用文件里的 token 是否已新鲜，过期才用 cache
  3. refresh 需要 refreshToken + 设备签名时，签名算法在 bundle 里照抄
     （Trae 的 `ExchangeToken`：`["POST", path, clientID, refreshToken, ts, nonce].join(' ')`
     后 ECDSA-SHA256，密钥对存在 `iCubeAuthInfo://icube-dc:*`）

## 已知坑速查

| 症状 | 原因与解法 |
|------|-----------|
| grep 大文件/ldb 卡死 | 压缩块，grep 无效；改 Node indexOf 扫描 |
| `cp Cookies` 报 Device or resource busy | 应用持有锁；退出应用或换凭据源 |
| 签到返回"操作频繁"(9074 等) | body 与真实请求不一致或短时间重复调领取接口；对照日志改 body，等几分钟再试 |
| ps1 输出乱码 / 注册了乱码任务名 | UTF-8 无 BOM 被 PS5.1 当 ANSI 读；ps1 存 ASCII，任务名用英文 |
| bash 里内联 powershell 变量消失 | `$var`/`$_` 被 bash 展开；写 .ps1 文件执行 |
| 解密 blob 得到密钥对而非 token | 键名不是目标（如 `icube-dc` 存的是设备密钥对）；找 `://icube.cloudide` 这类账号键 |
| 状态接口 200 但 code=1001 | header 形态不对（如缺 Cloud-IDE-JWT 或 device id 错）；回 bundle 核对 `Z(token)` 类构造函数 |
