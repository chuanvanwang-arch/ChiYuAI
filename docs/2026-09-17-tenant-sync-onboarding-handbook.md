# 需求④ · 真实租户接入手册（Salesforce / 销售易 / 纷享逍客）

> 日期：2026-09-17
> 定位：交付/运维向操作手册——把「3 家 CRM 通用集成（Q2 线）」从代码落到真实租户。
> 前置：`docs/2026-09-15-final-design-coexistence-and-proactive.md` §6.1 A-B3~B6、§9；`docs/2026-09-14-external-data-integration-design.md`。
> 红线：**对接真实租户 = 配置驱动（config_store 描述符）+ 唯一通用适配器（generic-rest）**。任何厂商专属代码视为回归，拒绝合入。

---

## 0. 结论先行（交付核对单）

| # | 交付项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 通用适配器唯一实现 | ✅ | `src/sync/factory.js` `SYNC_PROVIDER_FACTORY = { 'generic-rest', neocrm }`（neocrm 为配置别名，零厂商代码） |
| 2 | 3 家预设（纯数据） | ✅ | `src/sync/presets/{salesforce,neocrm,fxiaoke}.js`，`PRESET_FACTORIES` 注册 |
| 3 | 生产装配（零接线→可构造） | ✅ | `src/scheduler/timers.js:532-536` ⑩ `syncFactories = { ...SYNC_PROVIDER_FACTORY, ...PRESET_FACTORIES }` → `mount.loadTenantSyncTargets` |
| 4 | 信任档闸门（L1 只读→L3 可回写） | ✅ | `src/sync/mount.js` `effectiveTrustLevel = min(descriptor, global)`，无自动提权 |
| 5 | 回写方向（第 0 闸放行） | ✅ | `src/sync/writeback.js` + `timers.js:564` dispatcher（decision 驱动） |
| 6 | **真实租户连通** | 🔴 **未做（Q2-5 缺口）** | 需接入方提供真实 endpoint/凭据/对象；**未接通不得宣称已连通**（判据②：成立行禁来自 smoke/mock） |

> 🔴 **本手册是「如何接通」的操作步骤，不是「已接通」的验收报告。** 接通动作需租户提供真实凭据后执行，产出 `verifyAuth ok` 才算数。

---

## 1. 架构一句话（防绕弯）

```
租户 config_store['integration-providers'] = [描述符...]
        ↓ normalizeProviderDescriptors（单一事实源：providerDescriptor.js）
        ↓ 仅 enabled + kind 受支持 + 有入向 objects[] → mount.loadTenantSyncTargets
        ↓ factories[kind]（= generic-rest 或预设名）
        ↓ createGenericRestSyncProvider(descriptor)   ← 唯一实现，差异全在配置
        ↓ sync engine（engine.js）：verifyAuth → discoverObjects → readIncremental(游标)
        ↓ 入向(in)落粒子 / 出向(out)经回写 dispatcher（决策第 0 闸）
```

- 描述符解释权唯一在 `providerDescriptor.js`（同 enrich 侧共用）。
- 预设本质 = 一段「**可复用的 descriptor 模板**」（含 auth steps / base / request / response / objects[]），工厂**不出现任何产品名**。

---

## 2. 接入前置（租户侧需提供）

| 项 | 说明 | 示例 |
|---|---|---|
| API 基址 | 厂商 API endpoint | `https://login.salesforce.com` / `https://api.xiaoshouyi.com` / `https://open.fxiaoke.com` |
| 凭据 | 各厂商鉴权所需（见 §4） | — |
| 对象清单 | 要同步哪些对象（Account/Lead/Contact…） | 缺省用预设全量对象 |
| 方向 | in（读入）/ out（回写） | 默认 in；out 需额外 mapping |
| 信任档 | L1 只读 / L2 读+受控写 / L3 全量回写 | 默认 L1（最严） |

> 未提供真实凭据时，`verifyAuth` 返回 `credentials_missing`（fail-closed 零请求）——**这是正确行为**，不是故障。

---

## 3. config_store 键位（接入唯一落点）

| 键 | 用途 | 形状 |
|---|---|---|
| `integration-providers` | 租户级 provider 描述符数组 | `[{ id, kind, enabled, objects[], direction, trust_level, auth… }]`（见 §5 样例） |
| `sync-mappings` | 字段映射（声明式，`direction:'in'` 才进读入表） | `{ version, mappings:[{ object, particle_type, identity, fields:[{external,particle}] }] }` |
| `sync-trust` | 全局信任档（与 descriptor 取 min） | `{ default_level: 'L1' }` |

> 键值一律经 `config_store` 写入（PK=(tenant_id,key)），**不落代码、不进 .env**。生产凭据应进 credentialVault（`resolveCredentials` 注入），不落描述符明文。

---

## 4. 厂商差异卡（预设已封装为模板，此处供诊断参考）

| 厂商 | 预设名/kind | 鉴权流 | 注入方式 | 游标语义 | 响应提取 |
|---|---|---|---|---|---|
| Salesforce | `salesforce` | OAuth2 client_credentials → access_token | header `Authorization: Bearer` | `SystemModstamp`（SOQL WHERE） | `records[]` |
| 销售易 | `neocrm` | getToken → data.accessToken | header `X-Access-Token` | `lastModifiedDate`（where） | `data.records` + `data.nextCursor` |
| 纷享逍客 | `fxiaoke` | **两步串联**：get_app_token → get_corp_token | body `{token}`（inject none） | `last_modified_time`（where） | `data.dataList` + `data.nextCursor` |

> 差异 100% 在预设 descriptor 表达；**三份预设共用同一个 `createGenericRestSyncProvider`**，无一行厂商专属代码（R3 红线保持）。

---

## 5. 接入步骤（操作手册）

### 5.1 选型
1. 确认厂商：Salesforce（海外/大型）/ 销售易（国内中大型）/ 纷享逍客（国内成长型）。
2. 确认对象：默认 Account/Lead/Contact；可按 `descriptor.objects[]` 裁剪（仅取出现的对象，保留预设 soql/request）。
3. 确认方向与信任档：默认 in + L1（只读）。**L3 回写需业务批准**（回写=写操作，过决策第 0 闸，无自动提权）。

### 5.2 配置凭据（不落描述符明文）
- 凭据进 **credentialVault**（生产密钥保险库），descriptor 只带 `id/kind/enabled`。
- 密钥缺失 → `credentials_missing` fail-closed（零请求），属预期。

### 5.3 写描述符（config_store['integration-providers']，按租户）
```json
[
  {
    "id": "sf-prod-01",
    "kind": "salesforce",
    "enabled": true,
    "direction": "in",
    "trust_level": "L1",
    "objects": [
      { "name": "Account", "direction": "in" },
      { "name": "Lead", "direction": "in" }
    ]
  }
]
```
- kind 支持：`generic-rest`（通用）/ `salesforce` / `neocrm` / `fxiaoke`（预设名→PRESET_FACTORIES）。
- **注意**：descriptor 的 kind 若未被工厂字典覆盖 → `mount.js` 静默跳过（零接线）→ 同步零数据。若发现「配置了但没数据」，先查 kind 是否可构造（§6 判据）。

### 5.4 映射（sync-mappings，声明式）
```json
{
  "version": 1,
  "mappings": [
    { "object": "Account", "particle_type": "CRM_ACCOUNT", "identity": "name",
      "fields": [ { "external": "Name", "particle": "name" }, { "external": "SystemModstamp", "particle": "updated_at" } ],
      "direction": "in" }
  ]
}
```
- 缺映射 → fail-closed：无映射对象被 mapping 层拒绝，不越权写。
- 出向回写映射由回写 Action 消费（`direction:'out'` 不进读入表）。

### 5.5 激活与验证（关键：**真实连通才算数**）
```bash
# 1) 直接调 verifyAuth（绕过定时器，确认凭据/鉴权流真实可用）
node -e "import('./src/sync/factory.js').then(async m=>{const p=m.createGenericRestSyncProvider({...(await import('./src/sync/presets/salesforce.js')).default, __fetch:globalThis.fetch}); console.log(await p.verifyAuth())})"
# 期望：{ ok: true }（真实网络往返）
# 若 { ok:false, error:'credentials_missing' } → 凭据未注入；若 auth_step_0_http_401 → 凭据错/权限不足

# 2) 确认生产装配（kind 可构造）
node -e "import('./src/sync/mount.js').then(async m=>{const {PRESET_FACTORIES}=await import('./src/sync/presets/index.js');const f={...(await import('./src/sync/factory.js')).SYNC_PROVIDER_FACTORY,...PRESET_FACTORIES};console.log(Object.keys(f))})"
# 期望：['generic-rest','neocrm','salesforce','fxiaoke']（全部可构造）

# 3) 观察定时器⑩ integration-poll 拉取日志 trace: integration-poll 无记录 / recordFailure
```

### 5.6 验收判据（防假绿——引用「13 条假绿判据」）
- ✅ `verifyAuth()` 返回 `{ok:true}`：真实 endpoint 网络往返成功。
- ✅ `readIncremental({object:'Account'})` 返回 `{ok:true, rows:[…]}`（真数据，非空）。
- ✅ 定时器⑩ 记录拉取行数（`integration-poll` trace），粒子落库（CRM_ACCOUNT 新增/更新）。
- 🔴 以下**不算连通**：mock/替身返回 OK、仅单测绿、仅「配置存在」、`enabled:false` 未启用、`objects[]` 为空（mount 空目标 no-op）。

---

## 6. 常见故障速查（Q&A）

| 症状 | 根因 | 处置 |
|---|---|---|
| 配置了但同步零数据 | kind 不在工厂字典 → mount 静默跳过 | 查 `Object.keys(syncFactories)`；预设名须在 PRESET_FACTORIES |
| `credentials_missing` | 凭据未注入 config_store/credentialVault | 注入凭据；fail-closed 属预期 |
| `auth_step_0_http_401/403` | 凭据错/无权限 | 核对厂商 appId/appSecret/corpId 权限 |
| `http_403/400` | 对象名错 / SOQL 语法错 | 对照 §4 差异卡与厂商 API 文档 |
| 回写不生效 | 信任档 L1（只读） | 需升 L2/L3（业务批准）+ 出向 mapping + 决策第 0 闸过审 |

---

## 7. 与四需求的关系

| 需求 | 对应落点 |
|---|---|
| ① 拓客/筛选/公海 | （同项目内）lead-pool + discovery |
| ② 邮箱/日历/会议/微信接入 | **本需求④同族的外部数据接入**（通用适配器模式可扩展）——见任务 #29 方案 |
| ③ 日期驱动自动化+推送+建日历 | signal 链（contact_change/relation_cooling/tender_deadline/report_due） |
| ④ 与原有 CRM 集成 | **本文档**：一次性抽取 / 定时获取（readIncremental 游标）/ MCP 回写（out + 第 0 闸） |

> 接入手册仅覆盖「真实租户连通」操作；「一次性抽取」= 首次 readIncremental 空游标全量；「定时获取」= 定时器⑩ 轮询；「MCP 回写」= 回写 dispatcher（决策驱动）。
