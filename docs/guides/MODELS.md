# 模型接入：provider 与档位

> 结论先说：**DeepSeek 官方（`deepseek-official`）已充分测试；
> OpenAI / GPT 等兼容 provider 属于"已接入但未测试"** —— 代码路径是通的（透传给 DSH），
> 但本仓库没有在那些模型上跑过完整回归。

## 一、架构：桥接不直连任何模型厂商

```
QQ ──► 桥接 ──► DSH（provider + model + reasoningEffort）──► 厂商 API
                    ▲
                    └── 桥接从这里读「模型目录」得到可用档位
```

桥接做的事只有两件：

1. 把 `config.json` 里的 `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` **原样交给 DSH**；
2. 通过 `session.modelCatalog` 读 DSH 公布的模型目录，用来渲染控制台的档位下拉（读不到才退回内置白名单）。

**含义**：接一个新 provider 主要在 **DSH 侧**配置，桥接不需要改代码——这也是它能"顺手支持"
别家模型的原因。但"不用改代码"不等于"验证过"。

## 二、DeepSeek 官方（✅ 已测试）

```jsonc
"dsh": {
  "baseUrl": "http://127.0.0.1:<DSH 端口>",
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "reasoningEffort": "low"        // off / low / high / max（词表来自 DSH 模型目录）
}
```

本仓库的 43 套离线回归 + 54 项全功能自测都是在这个组合下跑的。

## 三、OpenAI / GPT（⚠️ 已接入，**未测试**）

> **2026-10-31 实测更新**：拿到一个真实 key 试过 —— 鉴权通过（128 个模型可见），
> 但**账户额度为 0**，补全返回 `429 credit_balance_exhausted`。
> 也就是说"未测试"的原因已经定位到**钱**，而不是代码或版本。
> 一键复验：`node scripts/gpt-smoke.mjs --chat`；完整结论见 [GPT-ROUTE-STATUS.md](GPT-ROUTE-STATUS.md)。


代码路径完全一样（透传），所以"能接"，但以下这些**没有**验证过。请把它当
"可能能用，出问题别意外"，而不是"支持 GPT"。

### 3.1 在 DSH 侧加一个 OpenAI 兼容 provider

DSH 的 settings 里有一组 provider 命名空间，其中包含 `providers` 映射，以及每个 provider 自己的
`baseURL` / `apiKeyEnv` / `models` / `allowedModels`。典型做法（键名以你机器上 DSH 版本的实际
schema 为准，先用下面的探针看清）：

```powershell
node scripts/probe-dsh-providers.mjs
```

它会打印：

- `session.modelCatalog` 里现有的 provider 分组与模型清单；
- settings 里与模型接入有关的路径（`providers.*`、`apiKeyEnv`、`baseURL`、`allowedModels`…）。

> ⚠️ **不要把 API Key 写进仓库或文档**。DSH 走的是 `apiKeyEnv`（环境变量名）而不是明文 key，
> 请沿用这个方式：`setx OPENAI_API_KEY "sk-..."`，配置里只写变量名。

然后改 `config.json`（只动这三行）：

```jsonc
"dsh": {
  "provider": "openai",              // 换成 DSH 里那个 provider 的 id
  "model": "gpt-4o",                 // 换成 DSH 目录里真实存在的 model id
  "reasoningEffort": "off"           // 见 3.2：非 DeepSeek 模型可能没有这档
}
```

重启桥接后，启动日志会出现一条醒目的提示：

```
⚠️  当前 provider = openai（非 DeepSeek 官方）：
   · provider/model 是原样交给 DSH 的；本仓库只在 deepseek-official 上测试过；
   · 计价表只有 DeepSeek 的，其他模型会按 deepseek-flash 兜底估算并标 estimated；
   · 工具调用 / 多模态 / 人格协议在该 provider 上的表现未经本仓库验证。
```

### 3.2 已知缺口（为什么不标"已支持"）

| 缺口 | 具体表现 | 影响 |
| --- | --- | --- |
| **计价表只有 DeepSeek** | `src/model-prices.js` 的 `DEFAULT_PRICE_TABLE` 只有 DeepSeek 模型价；未知模型按 `fallbackModel: 'deepseek-flash'` 兜底，返回里带 `estimated: true` | 控制台「令牌与花费」的**金额不准**（会偏低或偏高），但不会崩；请以厂商账单为准 |
| **思考强度词表** | 档位取自 DSH 模型目录，DeepSeek 是 `off/low/high/max`；换 provider 可能是别的词或没有这一档 | 控制台切档位可能无效；非法值会被 `normalizeReasoningEffort` 规范化并告警 |
| **工具调用协议** | 二代仿真「一切皆工具」依赖模型稳定地按 schema 调 MCP 工具 | 未验证。弱模型可能漏调/乱调，表现为「不回话」或「乱发消息」 |
| **人格卡与分条节奏** | 人格卡与「分条/潜水/唤醒」都按 DeepSeek 的表现调过 | 未验证。可能话太多、太像客服、或完全不理人 |
| **多模态（识图/表情）** | `qq_get_message_images` 把图片交给模型 | 未验证。不同厂商的图片输入格式与体积限制不同 |
| **上下文与压缩** | 桥接按 DSH 的会话/压缩行为设计 | 未验证。可能更早触发压缩或更晚 |

### 3.3 接入后建议这样验证（按顺序）

```powershell
# 1) 看 DSH 是否真的认这个 provider
node scripts/probe-dsh-providers.mjs

# 2) 桥接侧是否读到目录（档位来源 = dsh 而不是 fallback）
#    GET /api/dsh/model  ->  catalogSource: "dsh" 表示读到了
$h = @{ 'X-Console-Token' = (Get-Content .\state\console-token -Raw).Trim() }
Invoke-RestMethod 'http://127.0.0.1:3100/api/dsh/model' -Headers $h | ConvertTo-Json -Depth 4

# 3) 全功能自测（只发你自己私聊；会消耗 token）
powershell -File .\scripts\live-full-test.ps1 -MaxSends 3

# 4) 真群里试一句：@它 看是否分条、是否用表情、是否乱发
```

任一步失败，先回到 `state/bridge.log` 看有没有 `selectModel` / `modelCatalog` 相关报错。

## 四、想加别的 provider（Anthropic / Gemini / 自建网关）

流程与第 3 节完全一样：**在 DSH 侧配 provider，桥接只改 `config.json` 那三行**。
缺口的性质也一样（计价、档位、工具协议、人格表现都未验证）。

判断标准很简单：

> 桥接里没有任何一处 `if (provider === 'deepseek-official')` 的分支 ——
> 它能接任何 DSH 认的 provider，也同样**不保证**任何非 DeepSeek provider 的表现。

## 五、如果你把某个 provider 测通了

欢迎更新这份文档：把那一节的 ⚠️ 换成 ✅，并写清**测了什么、版本是什么、发现了什么差异**。
这才是"支持"两个字的依据 —— 而不是"代码能跑"。
