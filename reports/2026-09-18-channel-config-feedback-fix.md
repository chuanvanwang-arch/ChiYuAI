# 通道配置台「点了就没反应」— 缺陷定位与修复（2026-09-18）

## 结论先行

**不是「没反应」，是反应被渲染成了用户认不出的东西。**

点击 `确认接入` 的 handler **正常执行、确实写了 DOM**——但反馈被写进与周围静态说明**同色同字号的灰字**（`<p class="hint" id="out">`），
且该行实机落在**视口底边**（`y=719` / 视口高 `720`）。用户看到的唯一变化是一行「和说明文字长得一样」的灰字；
再点一次文本**一字不变** ⇒ 读作「点了没反应」。

> 用户截图底部那行 `凭据须为合法 JSON` —— **就是这条反馈**，只是它长得像帮助文本。

已修复（`src/web/channel-config.html`），并用运行期探针 + 变异自证锁死。

## 一、实机复现（Playwright 真登录 → 真点击，非推测）

| 场景 | 点击后 `#out` | 位置 | 样式 | 判定 |
|---|---|---|---|---|
| A 凭据填裸密码（=用户截图同形态：`admin123`，8 个点） | `凭据须为合法 JSON` | y=719 / vh=720（**压在视口底边**） | `color: rgb(203,213,225)`＝`--mut` 灰字，与静态说明**完全同形** | 用户读作「没反应」 |
| B 合法 JSON 缺 host/pass | `缺必填字段：host、pass（后端也会拒…）` | 同上 | 同上 | 同上 |
| C 合法 JSON 完整（真探测 ENOTFOUND） | `接入失败：connect_failed:ENOTFOUND` | 同上 | 同上 | 同上 |

**根因链**：`$('connect').onclick` 各分支**都写了 `#out`** → 但 `#out` 是 `.hint`（灰字）且位于按钮下方、实机在视口底边 →
无态区分、无图标、无滚动、无按钮状态变化 → **反馈存在但不可辨识**。

⚠ 反证一条：处理函数**不是**没绑定。`test/web/channelConfigPage.test.js` 当时 **9 条全绿**——
它断言的是「页面里有没有 `/api/channels/connect` 这个串」：**绿在「有端点」，死在「用户看不见」**。

## 二、修复（`src/web/channel-config.html`，仅前端，未动后端契约）

| # | 改动 | 修复的观感 |
|---|---|---|
| 1 | 反馈区改为三态着色容器 `busy / ok / err`（`err` 走 `--err` + `--err-soft` 令牌，不自带 rgba） | 失败＝红框红字，不再与灰字说明同形 |
| 2 | `role="status" aria-live="polite"` + `white-space: pre-wrap` + 出现即 `scrollIntoView({block:'nearest'})` | 出现在视线内；多行「↳ 下一步」不再被压成一行 |
| 3 | 校验错误**就地**落在凭据框原位：标红 + `focus()` + 给出**本通道必填键与可照抄示例** + 指回「新增通道（走向导）」 | 用户知道**改哪里、填什么**（原话只有一句「须为合法 JSON」＝不可执行提示） |
| 4 | 提交期按钮 `disabled` + 文案「提交中…」，`finally` 恢复 | 点下去**立刻**有变化；异常路径不会把按钮变砖 |
| 5 | 失败时**保留**凭据输入（成功才清空，维持「明文不驻留 DOM」） | 失败可就地改错，不必重敲 |

实机复验（同一套 Playwright 脚本）：

```
A 裸密码        #out class="status show err"  color=rgb(248,113,113)  bg=rgba(248,113,113,0.1)
                #cred-hint 标红 → 「⛔ 凭据须为合法 JSON —— 本通道必填 host、user、pass，例如：{...}」
                #f-cred class="bad"  光标已聚焦=true
C 真探测失败    点击后 50ms 按钮文案="提交中…" → 结束后 class="status show err"，按钮恢复可点
```

## 三、锁定资产（防「下次重构静默退化」）

- `scripts/verify-channel-config-feedback.mjs`：抽 `<script type="module">` + DOM 桩 + fetch 桩，**真跑 `onclick`**，32 条断言
  （不发请求 / show+err / 原位标红 / 聚焦 / busy+disabled / 按钮恢复 / 成功清空 / 重复点击状态被重新施加）。
  入口：`npm run probe:channel-ui`（`test/web/channelConfigPage.test.js` 断言该 npm script 存在，防探针被孤立）。
- 变异自证 `tmp/_mutate_channel_feedback.mjs`：把修复回退成缺陷形态，探针**必须变红**——
  m1 回退灰字 → 红 9 条；m2 去掉就地标红 → 红 5 条；m3 去掉 busy 态 → 红 2 条。**3/3 被抓**（探针有鉴别力，非摆设）。
- 新增 4 条静态契约（`test/web/channelConfigPage.test.js`，13 条全绿）：反馈区语义与令牌、就地改错锚点、提交中即刻反馈、探针在册。

## 四、顺带发现（未擅自改，需裁决）

| 级别 | 发现 | 证据 | 建议 |
|---|---|---|---|
| **P1** | **探测失败，凭据已落保险库（残留）**：`channelRouter.js:55` 先 `saveSecret` 再 `verifyScope`；探测失败只回 400，**不清残留槽** ⇒ 之后「凭据留空（沿用已有）」的提交会**复用上次的脏凭据**，把「没填」误报成「连不通」 | 复现实测：场景 C 失败后，场景 D（凭据留空）复用了残留 host → `connect_failed:ENOTFOUND`（用户会以为是自己没填凭据） | 与设计 §4.5.1「②验证 → ③确认才入库」对齐：删档失败即回滚槽（或改用 `verify_only` 先探后落） |
| **P1** | **`connect_failed:<code>` 无 `hint`**（原样吐 socket 错码） | `probes.js:51` 连接层故障分支不挂 hint；实测 `{"error":"connect_failed:ENOTFOUND","hint":null}` | 按 §4.5.4「失败提示必须指向一个不同的下一步动作」补归因（如「域名解析失败 → 核对 host」） |
| **P2** | 接入向导 step③ `#result` 沿用灰字 `.hint` 同款写法 | `onboarding-guide.html:92/217` | 每次点击文本会变，观感轻于本页；下次动该页时统一三态着色 |

## 五、本轮范围与副作用声明

- **改动文件**：`src/web/channel-config.html`、`test/web/channelConfigPage.test.js`、`package.json`（加 npm script）、新增 `scripts/verify-channel-config-feedback.mjs`。
- ⚠ **我的复现写入了开发库一条残留凭据**：`config_store` → tenant `system` / key `integration-secrets` / slot `channel-email-system`
  （`updated_at 2026-09-17T23:05:12Z`，密文 178 字符，内容为复现用的假凭据 `imap.invalid-host-xyz.test`）。
  按**禁 DELETE 铁律**未自行清理 —— 需要你批准后移除该槽（否则它会污染你下次「凭据留空」的提交，见 P1 第 1 条）。
- `npx vitest run test/web`：**593 通过 / 4 失败**，4 条失败在 `calibrationMonitor` / `decision-network-linkage` / `pipeline-new-deal`，
  断言对象是 `pipeline.html` / `decision-scenarios.html` / 校准页 —— **均非本轮改动文件**，属工作区既有红。
