# 需求② 接入形态改造设计：连接器优先 + 本机桥接（v1 · **待批准**）

> 2026-09-18 起草。用户明确指正：「不是做个本站网页去连接，而是引导用户打开相关的应用或工具，由用户输入用户和密码，比如在 workbuddy 里面帮助用户配置好 MCP 或 CLI！」
> 本设计**取代**原方案中「我方网页收集邮箱密码 → 存我方 vault」作为**主入口**的定位；原自建探针与 vault 路径**保留但降级为兜底**（不删，见 §7）。

---

## 0. 结论先行

| 项 | 原方案（已实现，偏差） | 本设计 |
|---|---|---|
| 凭据去哪 | 用户在我方网页填密码 → 进我方 vault | **默认不进我方**：由对方应用或用户本机持有 |
| 接入动作 | 填表 → 我方后端连 IMAP | **引导**：连接官方连接器 / 复制本机桥命令 |
| 我方的角色 | 直连 + 归一化 + 落图谱 | **只读消费 + 归一化 + 落图谱**（数据经 MCP/CLI 取得） |
| 无官方连接器的邮箱 | 自建 IMAP（唯一路径） | 本机 CLI/MCP 桥为默认；自建 IMAP 为兜底且**显式标注凭据去向** |

**核心认知修正**：我原以为「接入＝我们必须自己连上对方系统」，所以写了 IMAP/CalDAV 探针并让用户填密码。
ATTIO 与 WorkBuddy 生态的实际做法是：**接入＝让用户在对方应用内完成授权，我方只消费结果**。

## 1. 依据（两条实测事实）

### 1.1 ATTIO 的真实机制（官方文档，本轮核实）

| 事实 | 原文/出处 |
|---|---|
| **从不拿密码** | "each rep authorizes their own Gmail or Outlook via OAuth. **Attio does not get your password — it gets a scoped OAuth token.**" |
| 只做两家 | 入口只有 `Connect Google account` / `Connect Microsoft account`（无「填 IMAP 密码」入口） |
| per-user 授权 | 「Each rep needs to authorize their own inbox individually」——凭据不集中 |
| 未匹配即私密 | 「emails to/from addresses that do not match any Person are **NOT** logged — they stay private in your inbox」 |
| 隐私分级 | Metadata only / Subject line and metadata / Full access，默认最保守 |
| 邮件客户端内操作 | Gmail Chrome 扩展：不离开 Gmail 即可 log/snooze |

### 1.2 我方环境里**已有**的资源（WorkBuddy 连接器市场实测，非推测）

| 连接器 | 官方能力（描述原文摘录） | 覆盖四通道 |
|---|---|---|
| **企业微信** `wecom` | 官方 CLI 套件：消息、**邮件读取与发送**、文档、待办、**日程**、**会议**、微盘、通讯录 | 邮箱✅ 日历✅ 会议✅ 微信✅ |
| **飞书** `feishu` | CLI：即时通讯、**邮箱**、**日历**、云文档、**视频会议**、任务、审批 | 四项全覆盖 |
| **钉钉** `dingtalk` | CLI：**日历**、群聊与机器人、**邮箱**、OA 审批、待办、**AI 听记** | 四项全覆盖 |
| QQ邮箱 `qq-mail` | 收发、搜索、整理邮件，自然语言读取邮件内容 | 邮箱（仅 QQ 域） |
| 腾讯会议 `tmeet` | 创建/查询/管理会议、日程安排、参会人 | 会议 |
| 会议转写 `wisenote` / `plaud` | 会议列表、详情摘要、**转写**内容 | 会议转写（对应需求③「转写」） |

**结论**：原方案自研 IMAP/CalDAV 探针，等于**放着官方套件不用**，且把本不该由我方承担的凭据责任揽了过来。

## 2. 目标架构：接入三形态 × 谁读数据

### 2.1 三形态（**单一事实源** `src/channels/sourceKinds.js`）

| 形态 | 凭据持有者 | 数据通路 | 适用 |
|---|---|---|---|
| **`connector`**（默认） | 对方平台 + 用户本机客户端 | WorkBuddy 侧 Agent 调 connector 工具 → 经 **crm-native MCP** 写入我方 | 企微 / 飞书 / 钉钉 / QQ邮箱 / 腾讯会议 等有官方套件者 |
| **`local-bridge`**（无官方套件的默认） | **用户本机**（CLI 配置 / 本机 MCP server） | 本机 CLI 或本机 MCP → Agent 读取 → 经 crm-native MCP 写入我方 | 163/126 等只有 IMAP+授权码的邮箱、自建 CalDAV |
| **`direct`**（兜底） | 我方 vault（pgcrypto 加密） | 我方后端直连（现有探针/adapter） | 企业内网、对方应用不可达、客户明确接受凭据上云 |

### 2.2 谁读数据：两种模式，**默认 Agent 侧**

| 模式 | 读取方 | 我方平台是否需要凭据 | 适用 | 判定 |
|---|---|---|---|---|
| **A. Agent 侧读（默认）** | WorkBuddy / 本机 Agent | **不需要** | SaaS 多租户 | ✅ 默认 |
| **B. 平台侧读** | 我方后端（MCP client / 直连） | 需要（或需可达本机 MCP） | 私有化部署、企业内网 | 兜底 |

> **红线（本设计新增）**：**SaaS 多租户场景下，我方平台不得持有客户邮箱/IM 凭据。** 需读数据时，由用户侧的 Agent/本机桥读取并只回传**结构化结果**。

## 3. 数据流（**零新增内核**，契约不变）

```
connector（MCP 工具返回）
local-bridge（CLI stdout / 本机 MCP）
direct（我方 HTTP 探针/adapter）        ┐
                                        ├─→ 统一事件行契约（原设计 §3.0）─→ enrichment 分键
                                        │      email_intent / schedule /        （§3.1–§3.4）
                                        │      meeting_intents / wechat_intents
                                        └─→ 同一图谱汇入 wrapProviderForIngest（原 §5）
```

- **不变**：事件行契约、四通道落点键、`wrapProviderForIngest` 幂等汇入、信任档 L1/L2/L3 闸门。
- **新增**：`sourceKind` 字段（`connector` | `local-bridge` | `direct`）进入通道描述符，**仅供展示与验证路由**，**不改变**落点键（避免「同一语义两个键」）。
- **守卫**：`sourceKind` 取值必须 ∈ 单一事实源集合；三形态各有独立验证路径（§4.2），任一路径失败不得冒充其它路径通过。

## 4. 首次接入向导改造：从「填密码」→「引导连接」

### 4.1 步骤①（新建）系统检测未接入 → 展示**三条路**，用户只做选择

| 卡片 | 内容 | 用户动作 |
|---|---|---|
| **A. 连接官方连接器**（推荐） | 列出适配当前需求的可连连接器（企微/飞书/钉钉/QQ邮箱/腾讯会议/转写…）+ 一句能力说明 | 点「连接」→ 在**对方应用内**完成登录授权（我方不接触密码） |
| **B. 本机桥接** | 给出**可粘贴命令**（CLI 安装/配置）或本机 MCP 配置片段；并附「配置写在哪、凭据留哪里」说明 | 在自己机器上粘贴执行、在**本机**输入授权码 |
| **C. 自建直连（兜底）** | 现有凭据表单，**顶部加醒目声明**：「凭据将上传并加密存储在我方平台；若可走 A/B，不建议选此项」 | 填凭据 → 现有 fail-closed 探针 |

### 4.2 步骤② 验证：**按形态分路**，各自 fail-closed

| 形态 | 验证方式 | 谁验证 | 失败语义 |
|---|---|---|---|
| `connector` | Agent 调**一次只读工具**（如列日程/读 1 封邮件），成功即证 | WorkBuddy 侧 Agent | 未连接/未授权 → **如实报**，不得写"已接入" |
| `local-bridge` | 本机 CLI 探针（如 IMAP 授权码握手）/ 本机 MCP 探测 | Agent（本机） | 同现有 `auth_failed` 等码，且**服务端原话透传**（沿用 §4.5.4） |
| `direct` | 现有 `verifyScope` 真探测（IMAP/CalDAV/API） | 我方后端 | 不变（含 hint/missing/detail 透传） |

> connector/bridge 的验证结果经 **crm-native MCP** 回写平台：只回 `{sourceKind, verified_at, tool, ok, error?}`，**绝不回传凭据或邮件原文**。

### 4.3 步骤③ 确认接入（不变）
过 review-gate 人工闸；信任档默认 **L1 只读**；描述符落 `config_store['integration-providers']` 并带 `sourceKind`。

### 4.4 页面定位调整
- `onboarding-guide.html`：由「凭据收集表单」改为「**引导卡 + 可选兜底表单**」（A/B/C 三卡，C 折叠）。
- `channel-config.html`：保留为通道管理台（改凭据/升降信任档/停用），同样带 `sourceKind` 标识。
- 两页 `guidedHint` 同源守卫**继续有效**（沿用 `channelHintParity.test.js`）。

## 5. 安全与合规红线（本设计新增/强化）

1. **凭据流向必须显式标注**：三形态界面各显示「凭据保存在哪、谁能看到」（A：对方平台+本机；B：仅本机；C：我方加密库）。
2. **未连接不得宣称已连接**：connector 未授权时，能力入口显示「未接入」，下游功能（图谱要素、日程信号）不得伪造数据。
3. **失败语义延续 §4.5.4**：拒因（未授权/scope 不足/未安装 CLI）必须指向**不同的下一步动作**。
4. **隐私默认**：仅同步「能匹配到我方客户粒子」的条目；未匹配项**不落库**（对齐 ATTIO 默认）；时间窗默认 30 天可配（沿用已批设计）。
5. **写回一律走既有闸门**：Agent 经 crm-native MCP 写入仍需 HITL / 决策第 0 闸；`sourceKind` 不构成任何提权理由。

## 6. 分阶段交付（待批准后执行）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **P1** | `sourceKinds.js` 单一事实源 + 描述符 `sourceKind` 字段 + 归一化/守卫测试 | 无 |
| **P2** | 向导改「引导卡」（A/B/C）+ 凭据去向声明 + 运行期校验器（含变异自证） | P1 |
| **P3** | connector 验证协议（Agent 侧只读探测 → MCP 回写 `{sourceKind,verified_at,tool,ok}`）+ 平台侧接收与展示 | P1 |
| **P4** | 本机桥命令生成器（按通道产出可粘贴命令/配置片段）+ 手册章节 | P1 |
| **P5** | （可选）`direct` 兜底路径回归，保持不退化 | P1 |

## 7. 与已批准设计的关系（防漂移声明）

- **不变**：§3.0 事件行契约、§3.1–§3.4 enrichment 落点键、§5 图谱汇入、§4.5.1 三步语义、§4.5.4 失败语义。
- **变更**：接入主入口的**承载形态**（引导 vs 表单）与**凭据持有位置**（对方/本机 vs 我方）。
- **不删**：现有 `direct` 探针、vault 路径、向导兜底表单全部保留（禁 DELETE 精神），仅**降级定位**并在界面标注。

## 8. 待批准问题（一次一问）

1. **本机桥的 CLI 选型**：直接用成熟 CLI（IMAP：`himalaya`；CalDAV：`khal`）生成配置命令，还是自研轻量 MCP server（可控性更好、需维护）？
2. **connector 验证回写的信任档映射**：连接器验证通过后，默认给 L1 只读即可，还是允许把「对方应用内的只读 scope」直接映射为 L2？

> 批准 P1–P4 后，我将按「每 Task 一 commit、显式 add」推进。
