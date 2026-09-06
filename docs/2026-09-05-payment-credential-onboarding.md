# 真实支付商户申请 + 凭据获取清单（微信/支付宝）

> 用途：让 `billing.html` 从「模拟支付」切换为真实收款。
> 前置：真实支付代码已落地（Task A-H + 沙箱确认 Task I），本清单只需解决「凭据从哪来、怎么填」。
> ⚠ 字段名与代码严格对齐（`api_v3_key` 不是 `api_key`，`platform_cert_pem` 等勿写错字段名，否则会静默回落到 simulate）。

---

## §0 凭据速查表（填 `billing-settings` 用）

| 渠道 | 字段（JSON key，必须与代码一致） | 去哪拿 |
|---|---|---|
| 微信 | `appid` | 已认证**服务号/公众号**的 AppID（微信公众平台 mp.weixin.qq.com） |
| 微信 | `mch_id` | 微信支付商户平台（pay.weixin.qq.com）商户号 |
| 微信 | `serial_no` | 商户平台「账户中心 → API 安全 → API 证书」里证书的序列号（16 进制大写） |
| 微信 | `private_key_pem` | API 证书解压包里的 `apiclient_key.pem`（商户 API 私钥） |
| 微信 | `platform_cert_pem` | 微信支付**平台证书**的公钥 PEM（下载工具 `Wechatpay-Cert-Downloader`，从 `wechatpay_*.pem` 取） |
| 微信 | `api_v3_key` | 商户平台「API 安全 → APIv3 密钥」自助设置的 32 字节密钥（⚠ 字段名是 api_v3_key） |
| 微信 | `notify_url` | 你自己的公网回调：`https://你的域名/api/billing/wechat/notify` |
| 支付宝 | `app_id` | 支付宝开放平台（open.alipay.com）「电脑网站支付」应用的 APPID |
| 支付宝 | `private_key` | 支付宝开放平台密钥工具生成的**应用私钥**（RSA2，PEM） |
| 支付宝 | `alipay_public_key` | 开放平台应用详情 →「开发设置」→ 支付宝公钥（上传应用公钥后自动生成） |
| 支付宝 | `notify_url` | 公网回调：`https://你的域名/api/billing/alipay/notify` |

> 任一必填项缺失/字段名错 → `createPayment` 返回 `{simulate:true}`，前端仍弹「模拟支付」。核对依据：`src/billing/domesticGateway.js:49`（微信 5 项齐才走真实）。

---

## §1 微信支付（Native 扫码）

### 1.1 申请资质
- **主体**：营业执照（企业/个体户均可）；需对公账户。
- **配套**：一个**已认证的服务号**（微信公众平台，300 元/年认证费）——Native 支付的 `appid` 用服务号 appid；服务号与商户号在商户平台做「关联绑定」。

### 1.2 开通路径
1. 注册服务号并完成认证：`https://mp.weixin.qq.com`（获取 `appid`）。
2. 申请微信支付商户号：`https://pay.weixin.qq.com`（用服务号扫码注册申请，提交营业执照/对公账户验证）。
3. 商户平台 →「产品中心」→ 确认「Native 支付」已开通（默认开通，无需单独签约）。

### 1.3 取凭据（商户平台 `pay.weixin.qq.com`）
| 凭据 | 位置 |
|---|---|
| `mch_id` | 商户平台首页/账户中心 |
| `api_v3_key` | 账户中心 → API 安全 → **APIv3 密钥**（首次需用微信支付证书工具设置，32 字节） |
| `serial_no` + `private_key_pem` | 账户中心 → API 安全 → **API 证书** →「申请证书」（下载证书工具生成，压缩包内 `apiclient_key.pem` 即私钥；`apiclient_cert.pem` 是商户证书不用填 API） |
| `platform_cert_pem` | 下载**微信支付平台证书**：可用官方工具 `Wechatpay-Cert-Downloader`（github.com/wechatpay-apiv3/wechatpay-nodejs 或 cert downloader 工具），运行后得到 `wechatpay_*.pem`，其**公钥**（`-----BEGIN PUBLIC KEY-----` 段，若为证书格式则整个 PEM 均可，`createPublicKey` 兼容）填入 `platform_cert_pem` |
| `appid` | 服务号 AppID；并在商户平台「产品中心 → AppID 账号管理」绑定该服务号 |

### 1.4 注意事项
- `private_key_pem` 与 `platform_cert_pem` 是**不同的东西**：前者是你的私钥，后者是微信的平台公钥（验回调签名用），填反会导致回调验签失败。
- `api_v3_key` 用于 AES-256-GCM 解密回调内容，与 API 证书私钥互不替代。
- 回调验签依赖**平台证书**；请勿使用商户证书 `apiclient_cert.pem` 当作平台证书。

---

## §2 支付宝（电脑网站支付）

### 2.1 申请资质
- **主体**：企业支付宝账号（营业执照），需完成企业认证。
- **签约产品**：「电脑网站支付」——适配 B 端自助支付（用户被引导到支付宝收银台，支持扫码/登录支付）。

### 2.2 开通路径
1. `https://open.alipay.com` 用**企业支付宝**登录。
2. 创建应用 → 选择「**电脑网站支付**」模板 → 配置应用名称（如「XX 平台订阅」）。
3. 完善应用信息并**提交签约**（审核一般 1-3 个工作日，需营业执照截图等）。
4. 签约通过后应用状态为「已生效」，即可使用。

### 2.3 取凭据
| 凭据 | 位置 |
|---|---|
| `app_id` | 开放平台 → 控制台 → 应用详情（页面顶部 APPID） |
| `private_key` | 下载「支付宝开放平台**密钥工具**」（open.alipay.com 帮助中心），生成 RSA2 密钥对 → **应用私钥**（PEM）填入 |
| `alipay_public_key` | 应用详情 → 开发设置 → 接口加签方式：把工具生成的**应用公钥**上传 → 页面显示「支付宝公钥」→ 填入（⚠ 是支付宝公钥，不是你自己生成的那把） |

### 2.4 注意事项
- 支付宝验签用「支付宝公钥」；加签用「应用私钥」——两把钥不要写反。
- 沙箱与生产是两套 app_id/密钥：沙箱账号在开放平台沙箱环境（见 §3），**沙箱密钥不能用于生产**，上线前必须换成生产应用的公私钥。

---

## §3 沙箱联调指引（填生产凭据前的演练）

### 3.1 支付宝沙箱（零门槛，推荐先做）
1. `https://open.alipay.com/develop/sandbox` → 获取**沙箱应用 APPID + 沙箱网关** `https://openapi-sandbox.dl.alipaydev.com/gateway.do` + 沙箱密钥（工具生成）。
2. 我们代码的 `alipayPagePayRequest` 支持传 `gateway` 覆盖默认生产网关（`src/billing/alipayPage.js:53`），沙箱联调时填沙箱网关即可，**无需改代码**。
3. 沙箱有测试买家账号余额，直接可完成支付 → 命中 **`/api/billing/alipay/notify`** → 落单。

### 3.2 微信沙箱（需资质，或在生产小额测试）
- 微信支付官方沙箱环境需向商户平台申请（beta 试用），门槛略高。
- **务实替代**：用生产商户号做**小额真实支付**（`PAY_TEST_AMT=1` → 1 元订单），扫真实码支付 1 元 → 回调落地 → 验证成功后即可正常经营。1 元测试成本可忽略且链路最真实。
- 联调时设环境变量 `PAY_TEST_AMT=1` 控制金额（`src/billing/domesticGateway.js:46`），避免误扣大额。

### 3.3 沙箱验证成功标准（与 Task I 测试同口径）
1. `billing.html` 升级弹窗不再弹「模拟支付」；
2. 微信：显示真实二维码；支付宝：跳转真实收银台；
3. 支付完成后 `crm.payment_order` 该单 `status='paid'`；
4. `tenant_subscription` 最新行 `status='active'` 且 `online_order_no=该单 out_trade_no`；
5. `tenants.plan` 已切到目标档位。

---

## §4 填入配置（生产生效）

后台：`admin-billing-console.html#settings`（仅 admin/sysadmin）→「计费设置」→ 整档 JSON 保存；或直写 `config_store['billing-settings']`（tenant_id='system'）。

```json
{
  "enabled_providers": ["wechat", "alipay"],
  "default_provider": "wechat",
  "wechat": {
    "appid": "wx你的服务号appid",
    "mch_id": "你的商户号",
    "serial_no": "API证书序列号",
    "private_key_pem": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
    "platform_cert_pem": "-----BEGIN PUBLIC KEY-----|CERTIFICATE-----\n...",
    "api_v3_key": "32字节APIv3密钥",
    "notify_url": "https://你的域名/api/billing/wechat/notify"
  },
  "alipay": {
    "app_id": "你的支付宝应用appid",
    "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
    "alipay_public_key": "-----BEGIN PUBLIC KEY-----\n...",
    "notify_url": "https://你的域名/api/billing/alipay/notify"
  },
  "stripe": { "enabled": false }
}
```

> ⚠ 凭据只存 DB（`config_store`），**不进代码、不进 git**。PEM 换行在 JSON 里写 `\n`。

---

## §5 上线检查清单（切真实前逐项打勾）

- [ ] 微信 `appid/mch_id/serial_no/private_key_pem/platform_cert_pem/api_v3_key` 六项齐且字段名正确
- [ ] 支付宝 `app_id/private_key/alipay_public_key` 三项齐
- [ ] `notify_url` 两个回调公网可达（`POST` 放行，无鉴权拦截）
- [ ] 服务器 `server.js:52-55` 已挂 notify raw body 中间件（已就位）
- [ ] 生产域名有 HTTPS（微信/支付宝强制要求）
- [ ] 沙箱联调已跑通（或 1 元真实支付验证过）
- [ ] 首笔真实支付后核对：`payment_order.paid` + 订阅 `active` + `online_order_no` 锚点 + `tenants.plan` 已切换
- [ ] 退款链路：管理员「退款」后 `payment_order.refunded` + 订阅转 grace（fail-open 只告警不阻断）
