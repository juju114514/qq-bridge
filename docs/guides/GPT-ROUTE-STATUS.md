# 非 DeepSeek 通道现状（2026-10-31 实测）

## 〇、结论先行

| 项 | 结果 |
| --- | --- |
| OpenAI 官方 key | ❌ 鉴权有效但 `429 credit_balance_exhausted`（无余额，且无法充值） |
| **千问 dashscope：文本** | ✅ **端到端跑通**（`qwen-flash` / `qwen-plus` 都能回话） |
| **千问 dashscope：工具调用** | ⚠️ **模型会调、但参数不对**：`qq_list_stickers` / `qq_get_prompt` 都被调起，工具回 `未授权：智能体调用携带的会话令牌无效` —— qwen 传的 `token` 参数不对（同一提示词下 DeepSeek 传得对） |
| amazon-bedrock | ⚠️ provider 已注册、193 个模型可选（含 `openai.gpt-5.x/6-x`、`claude-*`、`nova-*`），但 key 不是 Bedrock 格式（`Invalid API Key format`） |
| 我们的 DSH 版本 | **`0.2.1-rc.2`** |

## 一、这一轮修掉的两个真问题

### 1. 思考强度硬编码 → 非 DeepSeek provider 静默退回默认模型

`ensureChatModel` 原来只会把"设置模型"原样重试两次。遇到**不声明 reasoning 档位**的模型
（`qwen-flash`、`qwen-plus`、`amazon.nova-lite-v1:0`）必然失败：

```
session/model-unavailable: provider "dashscope" model "qwen-flash" does not support reasoning effort "low"
```

于是会话**静默用默认模型**，用户只看到"回复不像那个模型"。

现在：第一次照配置带 `reasoningEffort`；报"不支持思考强度"时**去掉该字段**再试一次，
并记一行 `↳ … 不支持思考强度「low」，改为不带该字段重试`。DeepSeek 路径完全不变。

### 2. 自定义 provider 的模型条目没声明上下文窗口 → 真实会话直接溢出

只写 `id` 时 DSH 用很小的默认上下文，真机注入一条 prompt 就报：

```
pi-ai detected context overflow for model "qwen-flash"
```

修法（写进 DSH 的 `profiles/desktop/cordis.patch.yml`，**热加载生效，不用重启**）：

```yaml
      dashscope:
        displayName: 阿里百炼（千问）
        apiKeyEnv: DASHSCOPE_API_KEY
        api: openai-completions
        baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
        models:
          - id: qwen-flash
            contextWindow: 1000000
            maxTokens: 8192
          - id: qwen-plus
            contextWindow: 131072
            maxTokens: 8192
```

## 二、工具调用实测（真机，owner 私聊）

```
06:05:12 已设置会话模型 … -> dashscope/qwen-plus (默认)
          [inject] 请调用 qq_list_stickers（limit 3），只回复表情数量
22:03:25 mcp__snowluma__qq_list_stickers  ok=False  未授权：智能体调用携带的会话令牌无效
22:03:29 mcp__snowluma__qq_get_prompt      ok=False  未授权：智能体调用携带的会话令牌无效
```

**解读**：模型**选对了工具**、也发出了 tool_calls，但**参数保真度不足**（`token` 传错）。
这不是桥接的问题，也不是 provider 配置问题 —— 换 DeepSeek 用同一份提示词就正常。
这正是"小参数模型做工具调用"的典型短板。

## 三、下一步可选（按性价比）

| 方案 | 说明 |
| --- | --- |
| **换更强的模型** | 同一 provider 加 `qwen-max` / `qwen3-max`（`contextWindow: 131072`），再跑同一条工具测试 |
| **只把千问当纯聊天用** | `reserved2` 重度依赖工具；纯文本场景（`chat` 模式）千问完全够用 |
| **拿 Bedrock `ABSK` key** | 那边有 `deepseek.v3-v1:0`、`gpt-oss-20b`、`claude-haiku` —— 工具保真度大概率比 qwen-flash 好 |
| **改桥接：让 MCP 不信模型传的 token** | 安全边界变更，需要单独评审（当前设计是"模型必须带对 token"） |

## 四、DSH 里怎么加 OpenAI 兼容 provider（实测步骤）

设置 → 模型 → **添加模型提供商** → **自定义模型 API**：

| 字段 | 值 |
| --- | --- |
| Provider ID | `dashscope`（小写字母开头） |
| 显示名称 | 任意 |
| API 地址 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| API 协议 | `OpenAI Chat Completions` |
| API 密钥 | `sk-…` |
| 模型目录 | 至少一条；**记得填上下文窗口**（见上文第 2 点） |

保存后 `session/modelCatalog` 会多出对应分组；桥接侧只需改 `dsh.provider` / `dsh.model`。

## 五、沙箱验证要点（踩过的坑）

- 沙箱必须 `snowluma.wsUrl: ""` + `official.enabled: false`，否则第二个桥接会连上同一个
  SnowLuma / 抢官方实例锁 → **重复回复**。
- **不要删 `state/sessions.json` 来做"强制新会话"**：它同时承载会话映射与工具令牌关联，
  删了之后工具调用会回 `令牌无效`（这一轮就是因此浪费了两次测试）。
- 区分实例**按端口归属**（3100 真机 / 3199 沙箱），不要按命令行匹配（会误杀真机）。
---

# 决议（2026-10-31 06:20）：千问只做纯文本，工具场景继续用 DeepSeek

## 一、为什么这么定

| 能力 | DeepSeek（deepseek-official） | 千问（dashscope） |
| --- | --- | --- |
| 文本对话 | ✅ | ✅ 已实测（qwen-flash / qwen-plus） |
| 工具调用：选对工具 | ✅ | ✅ 已实测（会调 `qq_list_stickers` / `qq_get_prompt`） |
| 工具调用：**参数正确** | ✅ | ❌ `token` 传错 → `未授权：智能体调用携带的会话令牌无效` |
| 上下文 | ✅ | ⚠️ 需手填 `contextWindow`，否则 `pi-ai detected context overflow` |

结论：**`reserved2` 是"一切皆工具"的模式**（每轮 5~10 次工具调用），参数错一次这一轮就废了。
所以：

- **`reserved2`（QQ 群/私聊）** → 继续 `deepseek-official / deepseek-flash`
- **千问** → 只在纯文本场景用（`chat` 模式的问询、或把它当第二意见）

真机当前就是 `deepseek-official / deepseek-flash`，未改动。

## 二、如果以后想让千问进 `reserved2`，先验这三条

1. 换成更强的模型（`qwen-max`：`contextWindow: 131072`），重跑同一条工具测试
2. 观察 tool-log：`/api/socialV2/tool-log?key=…` 里 `ok=true` 的比例
3. 连续 3 轮都成功，再谈切换；单轮通过不算

## 三、Bedrock 上的 GPT：能不能测？现在不能，缺凭据

DSH 自带 `@aws-sdk/client-bedrock-runtime`，模型目录里也已经能看到
`openai.gpt-5.4 / gpt-5.5 / gpt-5.6-* / gpt-6-*`、`anthropic.claude-*`、`amazon.nova-*` 共 **193 个**。
但本机现在**没有任何可用的 Bedrock 凭据**：

| 检查 | 结果 |
| --- | --- |
| `ABSK…` 格式的 Bedrock API key | ❌ 磁盘上没有 |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 环境变量 | ❌ 没有 |
| `~/.aws/credentials` | ❌ 不存在 |
| DSH 里 `amazon-bedrock` 的 apiKeyEnv | ⚠️ 填的是**千问的 `sk-ws-` key**（所以报 `Invalid API Key format: Must start with pre-defined prefix`） |

### 要测 GPT，需要二选一

**方案 A：Bedrock API key（最省事）**

1. AWS 控制台 → **Amazon Bedrock → API keys**（区域选 `us-east-1`）
2. **Create long-term API key** → 得到 `ABSK…`
3. DSH → 设置 → 模型 → `amazon-bedrock` → 编辑 → 把 `ABSK…` 填进 API 密钥
4. 桥接侧只改两行：`dsh.provider = "amazon-bedrock"`、`dsh.model = "openai.gpt-5.6-sol"`（或其它）

**方案 B：AWS 访问密钥（SigV4）**

DSH 用的是标准 AWS SDK，凭据链支持环境变量：

```powershell
setx AWS_ACCESS_KEY_ID "AKIA…"
setx AWS_SECRET_ACCESS_KEY "…"
setx AWS_REGION "us-east-1"
```

然后重启 DSH。注意：`amazon-bedrock` 那条 provider 的 `apiKeyEnv` 要清空，否则它会走 API-key 分支。

### 两者都需要一个前提

**AWS 账号 + 已开通 Bedrock 模型访问**（`Model access` 里把 Anthropic / OpenAI / Amazon 的模型申请通过）。
这一步和 OpenAI 一样要外币卡，所以"无法申请国外账户"这条限制**同样卡住 Bedrock**。

## 四、国内可替代的"真工具调用"路线（不需要外币）

| 平台 | 说明 |
| --- | --- |
| 阿里百炼 `qwen-max` | 同一把 key 就能用，只需在 DSH 里加一条模型条目（`contextWindow: 131072`） |
| 智谱 GLM-4 / GLM-4-Plus | 国内支付，OpenAI 兼容，工具调用是它的强项 |
| 火山方舟 `doubao-pro` | 同上 |
| 硅基流动 | 聚合多家，OpenAI 兼容，注册门槛低 |

**建议顺序**：先加 `qwen-max`（零成本，改一条配置）→ 不行再考虑智谱/火山。
