# Buddy 应用上架材料清单

> 应用所属：CRM-ai-native（AI 原生销售管理平台）
> 对应插件：`plugin/openclaw.plugin.json` → `crm-native` v1.5.0
> 已有专家名：AI 原生销售平台管理助手（CRM 平台管理助手）

## 1. 应用头像

| 文件 | 尺寸 | 大小 | 格式 | 合规 |
|---|---|---|---|---|
| `buddy-app-store-listing/app-avatar.png` | 512×512 | 5,550 B（≈5.4 KB） | PNG | ✅ ≥96×96 / ≤100 KB / JPG\|PNG |

来源：`plugin/avatars/crm-native.png`（沿用现有品牌视觉：蓝绿渐变 + 上升柱状图，象征业务增长）。
可直接上传，体积充裕留有缓冲（100 KB 上限用了 5.4%）。
如需替换为差异化头像，仅保留本文件名为 `app-avatar.png` 即可。

## 2. 应用名称（全平台唯一，≤32 字符，提交后不可改）

| # | 名称（17–20 字） | 卖点 / 适配场景 |
|---|---|---|
| A（**推荐**） | **AI 原生销售管理助手** | 与工作记忆、专家市场已对外名称一致；零迁移成本，用户认知连续 |
| B | 销售平台 AI 助手 | 短小精悍，强调平台属性；避免"原生"二字被审核误读 |
| C | AI 原生 CRM 销售助手 | 强调 CRM 域；与英文品牌 `CRM Native Agent` 对齐度高 |

字符数核查：A=10 / B=7 / C=11，均远低于 32 上限。

## 3. 应用简介（≤200 字，展示在应用列表）

**推荐版本 A（78 字）**

> 面向销售经理与代表的 AI 原生销售管理助手。基于 Lead-to-Cash 管道，提供角色适配查询、会话式写入、风险预警与商机阶段推进，让方法论（BANT、MEDDIC、止损）落到每一次跟进。

**版本 B（96 字，偏能力清单）**

> CRM-ai-native 官方插件：销售数据一问即得、商机阶段自动推进、折扣审批走决策流、风险实时预警。内置 BANT / MEDDIC / 销售漏斗 / 止损四类方法论，AI 原生架构让每一条记录都可追溯、可治理。

**版本 C（62 字，最短）**

> CRM-ai-native 的 AI 原生入口：会问、会写、会预警、会推进。Lead-to-Cash 管道全程留痕，方法论自动化落地。

---

## 4. 授权 URL（OAuth 回调地址，限配置 1 个）

### 字段语义（易错）

这是 **CRM 侧接收授权码的接口地址**，不是 WorkBuddy 的地址。方向是：

```
CRM 引导用户 → WorkBuddy /authorize（用户确认授权）
            → 302 回 redirect_uri?code=xxx&state=xxx
            → CRM 服务端用 code + client_secret 换 access_token（POST /token）
```

即：**第三方应用 = CRM 去调 WorkBuddy 的 Open API**（本地助理对话 / 云端任务 / 产物 / 积分核销），
**不是** WorkBuddy 来调你的 CRM。

### ⚠️ 先确认业务方向

| 你的目的 | 应走通道 | 有无此字段 |
|---|---|---|
| 让 WorkBuddy 用户用上 CRM 能力（AI 助手来查/写 CRM） | **连接器 Connector**（MCP + Skill，`auth_mode: token` 或 MCP OAuth） | 无此字段，改为 `mcp.json` |
| CRM 反向调用 WorkBuddy Open API（代用户建任务、发消息给本地助理） | **第三方应用**（当前表单） | 有，必填 |

若属于前者，本表单应改走「连接器」提交，当前 `plugin/` 目录（openclaw.plugin.json）已是该形态。

### 填写规则

1. 必须是**你自己服务端**的地址，且需先实现该接口；
2. **字符串精确匹配**：限 1 个 → 后续 `/authorize` 请求里的 `redirect_uri` 必须与此处完全一致（含协议、端口、路径、尾斜杠）；
3. 生产要求 HTTPS；本地联调多数平台放行 `localhost` / `127.0.0.1` 回环；
4. 必须与 `state` 校验 + PKCE（S256）配套，code 一次性、约 10 分钟失效。

### ✅ 已提交值（2026-09-06 18:1x）

```
https://www.chiyuai.com/oauth/callback
```

### 🔴 实测诊断：该地址当前不可达（P0）

2026-09-06 18:1x 实测（本地 curl + Node tls，已绕过本地代理）：

| 探测项 | 结果 | 判定 |
|---|---|---|
| DNS `www.chiyuai.com` | → 81.70.184.198 | ✅ 解析正确 |
| TCP `81.70.184.198:443` | OPEN | ✅ 端口放行 |
| TLS **不带 SNI**（IP 直连） | **TLSv1.3 握手成功**，CN=www.chiyuai.com，Let's Encrypt | ✅ 证书有效、nginx 443 配置正确 |
| TLS **带 SNI=www.chiyuai.com** | **ECONNRESET** | ❌ 握手阶段被重置 |
| `http://www.chiyuai.com/oauth/callback` (80) | 302 | ✅ 80 端口正常 |

**根因：SNI 级拦截。** 证书与 nginx 均正常，唯独 ClientHello 携带 `chiyuai.com` 时被路径上的设备 RST——典型未备案域名的 HTTPS 阻断表现。浏览器与服务端回调**必然携带 SNI**，因此该回调链路 100% 断：用户授权后 302 跳回，浏览器直接连接被重置，拿不到 `code`，换不到 `access_token`。

> 修正旧结论：不是「域名被劫持到 dnspod webblock」，而是 **TCP 通、无 SNI 通、带 SNI 必断**。端口与证书都没问题，问题在域名备案状态。

### 补救路径

| # | 方案 | 周期 | 说明 |
|---|---|---|---|
| A（根治） | 完成 `chiyuai.com` ICP 备案 | 约 1–20 工作日 | 备案生效后 SNI 拦截自动解除，已提交地址无需修改 |
| B | 换用已备案域名 | 取决于域名 | 需改回调地址（限 1 个，需重新提交审核） |
| C（临时联调） | 改填 `http://localhost:3000/oauth/callback` | 立即可用 | 仅本地联调；生产不可用，且限 1 个无法并存 |

**建议**：走 A。备案期间如需联调，先用 C 提交一版草稿，备案通过后再改回 A 地址复审。

### 阻塞项

- `src/` 内**尚无** `oauth` / `redirect_uri` / `callback` 相关路由（已 grep 确认）→ 填了也走不通，需先实现。
- 生产 HTTPS 域名需先解决备案问题。

### 后续动作（需你确认后再实现）

1. 在 `src/http/routes.js` 新增 `GET /oauth/callback`：校验 `state` → 用 `code` 换 `access_token` / `refresh_token`（24h / 60d）→ 服务端安全存储；
2. 配置 `CLIENT_ID` / `CLIENT_SECRET` 进 `.env`（**仅创建后明文展示一次**）；
3. 按最小权限勾选 scope。

---

## 5. 真正目标通道：连接器包（让 WorkBuddy 用 CRM）

方向已确认：**让 WorkBuddy 用 CRM**。第三方应用（第 4 节）只解决反向调用，**本节的 `connector/` 才是目标通道**，且无「授权 URL」字段。

已生成 `D:\system\CRM-ai-native\connector\`：

```
connector/
├── connector-meta.json     # 元信息：名称/描述/示例/auth_mode/minWorkbuddyVersion
├── mcp.json                # streamableHttp，url 用 ${VAR} 占位；OAuth 模式下不写 Authorization 头
├── token-schema.json       # 用户自填表单：仅 MCP 地址（授权由 OAuth 浏览器完成）
├── icon.png                # 512×512 PNG（复用 crm-native 品牌视觉）
└── skills/                 # 16 个技能（复用 plugin/skills）
    ├── crm-native          # 编排入口：意图路由 → 技能分发
    ├── crm-query / crm-write / crm-risk
    ├── decision-retrospective
    └── method-*            # bant / meddic / 漏斗分类 / 阶段推进 / 止损 等 11 个
```

### 关键设计

| 项 | 取值 | 理由 |
|---|---|---|
| `type` | `mcp` | MCP + Skill 为官方推荐方案 |
| `auth_mode` | `oauth`（2026-09-15 由 `token` 改） | 客户端走 OAuth 2.1 授权码 + PKCE（S256），授权后持 `access_token`(8h) + `refresh_token`(30 天轮转) 自动静默续期 |
| `minWorkbuddyVersion` | `4.23.0` | 该版本起支持 `auth_mode` 与 MCP OAuth 发现链 |
| `url` | `${CRM_MCP_URL}` | 占位符，用户可改（本地联调 / 私有部署） |
| `headers` | **不写**（OAuth 模式下由客户端注入 `Authorization: Bearer …`） | 写死会与客户端注入头冲突 |

> ⚠️ 残留口径修正：`mcp.json` 若仍写 `Authorization: Bearer ${CRM_API_TOKEN}`，客户端既不发起 OAuth，
> 又会被 Nginx 的 `auth_basic` 质询拦下（两者都发 `Authorization` 头）→ 表现为「全员连不上」。
> 该冲突已于 2026-09-15 修复（见 `docs/2026-09-15-mcp-oauth-design.md`）。

### ⚠️ 两个待解决问题

1. **HTTPS 阻塞**：`chiyuai.com` 存在 SNI 级拦截（见第 4 节实测）。连接器同样要求远程 MCP 用 HTTPS → **备案是唯一根治路径**。备案前只能本地联调（`http://localhost:3001/mcp`）。
2. ~~**Token 有效期 8 小时**~~ ✅ **已于 2026-09-15 解决**：CRM 侧已实现 MCP OAuth 2.1（`/.well-known/*` 双 metadata + RFC 7591 动态注册 + `/oauth/authorize` + `/oauth/token`，PKCE S256、refresh 30 天轮转）。用户一次性浏览器授权后自动续期，不再手填 token。设计与实施见 `docs/2026-09-15-mcp-oauth-design.md`。

---

## 提交前自检

- [x] 头像：`buddy-app-store-listing/app-avatar.png`（512×512 / 5.55 KB / PNG）
- [ ] 应用名称：A / B / C 选一
- [ ] 应用简介：A / B / C 选一
- [x] 授权 URL：已提交 `https://www.chiyuai.com/oauth/callback` ⚠️ 不可达，见第 4 节
- [ ] 连接器包 `connector/` 提交审核（目标通道，依赖备案）

## 备注

- 专家市场内已上"AI 原生销售平台管理助手"，二者可并存（专家 vs 应用形态不同）。
- 提交后如需更新简介/头像，请走"更新应用"流程而非新建。