# 需求② 邮箱通道 · 真实凭据实测报告（2026-09-18）

> 对象：`watchm@163.com`（用户提供的真实邮箱凭据）
> 判定口径：L1 代码就绪 / L2 数据产出 / **L3 用户可用**

## 0. 结论先行

| 层级 | 判定 | 证据 |
|---|---|---|
| **链路**（网络 / TLS / 协议） | 🟢 **通** | `imap.163.com:993` TLS 握手成功；greeting `* OK Coremail System IMap Server Ready(163com[...])`；协议交互正常 |
| **凭据**（认证） | 🔴 **类型不符** | 服务端对**登录密码**回 `A1 NO LOGIN Login error or password error` |
| **落库/接入** | ⛔ **未放行（正确）** | 探针未通过 → `verifyScope` fail-closed → 不落凭据、不写描述符、不过人工闸 |
| **真正阻塞** | **1 项** | 国内邮箱 IMAP **只接受「客户端授权码」**，登录密码必被拒 |

**一句话**：链路侧已就绪，无需再改代码；**只需把凭据换成邮箱授权码即可复验通过**。

## 1. 实测证据（原始响应）

```
[greeting]        * OK Coremail System IMap Server Ready(163com[10774b260cc7a37d26d71b52404dcf5c])
[login-response]  A1 NO LOGIN Login error or password error
```

- 探针：`src/channels/probes.js` → `imap_login`（真 TCP/TLS + IMAP4rev1 LOGIN，非 mock）
- 取证脚本：`scripts/_probe_email_realcred.mjs`（凭据经环境变量传入，**不落库、不回显**）
- 服务端原话已脱敏后透传（`hint`），未出现任何凭据字面量

## 2. 为什么「未落库」不是故障

按设计 §4.5.1 步骤②：**探测不通过即不接入**（fail-closed）。
本轮未落库正是该闸门生效的表现——若它"为了方便"先存下来，就会出现
「界面显示已接入、实际从未通过认证」的**假绿**，比失败更危险。

## 3. 待办与解法（仅一步）

| 步骤 | 操作 |
|---|---|
| 1 | 登录 163 网页邮箱 → **设置** → **POP3/SMTP/IMAP** → 开启 **IMAP/SMTP 服务** |
| 2 | 按提示生成**客户端授权码**（形如 16 位字母串，只显示一次） |
| 3 | 把授权码当作「密码」填入接入向导（`/onboarding-guide.html`）或配置台（`/channel-config.html`） |
| 4 | 点「开始验证」→ 应显示 ✅ 探测通过 → 再确认接入（过 review-gate 人工闸） |

> ⚠️ 若第 1 步显示服务已开启却仍 `auth_failed`，说明密码栏填的仍是登录密码——替换为授权码即可。
> 163 在「服务未开启」与「凭据错误」两种情况下返回**同一句** `Login error or password error`，服务端不区分，只能人工确认设置状态。

## 4. 复验命令

**PowerShell（推荐）**
```powershell
$env:PROBE_USER='watchm@163.com'; $env:PROBE_PASS='<授权码>'; node scripts/_probe_email_realcred.mjs
```
**期望输出（通过）**
```json
{"probe":"imap_login","ok":true,"detail":{"host":"imap.163.com","port":993,"tls":true}}
```

## 5. 本轮同时修掉的真实缺陷（假失败）

| 缺陷 | 后果 | 修法 | 落点 |
|---|---|---|---|
| 探针只回裸 `auth_failed` | 用户只会反复改密码（**改一百次也不会通过**）——方向被误导 | 失败时**脱敏**回传服务端原话（`hint`） | `probes.js` |
| `verifyScope` 吞掉 `hint`/`detail` | 中间层丢失归因；成功侧无法区分"连上了"与"取到数据" | 失败透传 `missing`+`hint`；成功透传 `detail` | `verifyScope.js` |
| `channelRouter` 一律套 `credentials_missing` 话术 | 「授权机制不符」被读成「凭据没填」 | 优先取探针实报 hint | `channelRouter.js` |
| 向导只说失败、不给下一步 | 用户不知道去改什么 | 按**通道**追加可执行路径（仅邮箱套授权码话术） | `onboarding-guide.html` |
| 配置台与向导话术可能漂移 | 同一失败两种解释，用户以为某页更准 | 两页 `guidedHint` **逐字同源**守卫 | `channelHintParity.test.js` |

**锁定与自证**
- 运行期校验器：`scripts/verify-onboarding-guide-hints.mjs`（真跑 `doVerify`，断言渲染文本；两组变异自证：删分支 / 放宽通道条件各杀一条断言）
- 单测：`verifyScope`（hint/detail 透传）、`channelRouter`（400 hint / 200 detail）共 4 例
- 守卫变异自证：改配置台一处措辞 → 守卫精确报红，按 md5 还原
- 回归：通道线 85✅ / 受影响 3 文件 48✅ / web 页 24✅ / HTTP 线 84 文件 539✅

**提交**：`d9a97ab`（拒因透传）· `c71ca58`（设计 §4.5.4 + 手册登记）· `762de16`（入口同源守卫）

## 6. 其余三通道（日历 / 会议 / 微信）

同一探针框架已就绪，**同样卡在真实凭据**：日历需 CalDAV 地址（+可选账号）、会议需 API endpoint + token、企微需 `corp_id` + `secret`。
任一凭据到位即可用同一套流程复验——链路已验证可用（企微 API 实测回 `errcode 40013`，证明请求真实到达并被服务端处理）。
