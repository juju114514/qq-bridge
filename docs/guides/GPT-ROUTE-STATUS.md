# 非 DeepSeek 通道现状（2026-10-31 实测）

## 〇、结论先行（已跑通）

| 步骤 | 结果 |
| --- | --- |
| OpenAI 官方 key | ❌ 鉴权有效但 `429 credit_balance_exhausted`（无余额，且无法充值） |
| **千问 dashscope** | ✅ **端到端跑通**：`qwen-flash` 补全 200、函数调用返回 `tool_calls`、经桥接 → DSH → 回复正常 |
| amazon-bedrock | ⚠️ provider 已注册、模型可选（193 个），但 key 不是 Bedrock 格式（`Invalid API Key format: Must start with pre-defined prefix`） |
| 我们的 DSH 版本 | **`0.2.1-rc.2`**（`runtime.json` 的 `desktopVersion`，与 `compat.json` 的 `testedWith.dsh` 一致） |

**修掉的真问题**：`ensureChatModel` 以前只会把"设置模型"原样重试两次。
遇到**不声明 reasoning 档位**的模型（`qwen-flash`、`amazon.nova-lite-v1:0`）必然失败，
于是**静默退回默认模型** —— 用户只看到"回复不像那个模型"，日志里两行 `selectModel failed`。
现在改成：报"不支持思考强度"时**去掉该字段**重试一次（DeepSeek 路径完全不变）。

## 一、怎么复验

```powershell
# 只查鉴权（免费）
node scripts/gpt-smoke.mjs --base https://dashscope.aliyuncs.com/compatible-mode/v1 --model qwen-flash
# 再发一次 5 token 的补全（验额度与模型）
node scripts/gpt-smoke.mjs --base https://dashscope.aliyuncs.com/compatible-mode/v1 --model qwen-flash --chat
```

## 二、DSH 侧怎么加（实测通过的步骤）

设置 → 模型 → **添加模型提供商** → **自定义模型 API**：

| 字段 | 值 |
| --- | --- |
| Provider ID | `dashscope`（小写字母开头） |
| 显示名称 | 任意，如 `阿里百炼（千问）` |
| API 地址 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| API 协议 | `OpenAI Chat Completions` |
| API 密钥 | 千问的 `sk-…` |
| 模型目录 | 至少一条：模型 ID `qwen-flash`（目录外 ID 也能直接发） |

保存后 `session/modelCatalog` 会多出 `dashscope` 分组，桥接就能把 `dsh.provider=dashscope`
和 `dsh.model=qwen-flash` 透传过去。

## 三、桥接侧要改的只有两行配置

```json
"dsh": { "provider": "dashscope", "model": "qwen-flash" }
```

代码不需要任何 provider 分支 —— 这是刻意的：一旦为某个厂商加分支，就会变成"每条路都只测过一半"。

## 四、验证方法（沙箱，不碰真机）

```
QQ 消息 → 桥接(3199 沙箱) → DSH → dashscope/qwen-flash → 回复
```

沙箱配置要点：`consolePort: 3199`、`snowluma.wsUrl: ""`、`official.enabled: false`
（否则第二个桥接会连上同一个 SnowLuma / 抢官方实例锁，导致重复回复）。

## 五、已知差异（诚实清单）

| 项 | 状态 |
| --- | --- |
| 文本对话 | ✅ 已实测 |
| 函数调用（单轮） | ✅ 已实测：`finish_reason: "tool_calls"`，参数正确 |
| 工具调用（真实会话，每轮 5~10 次） | ⚠️ 未单独压测 |
| 图片输入 | ⚠️ 未测（`qwen-flash` 是否支持视觉需另配 VL 模型） |
| 人格/记忆注入 | ✅ 走同一套提示词，已随会话跑通 |

## 六、Bedrock（如果以后拿到 `ABSK…`）

模型目录里已有 `openai.gpt-5.x / 6-x`、`anthropic.claude-*`、`amazon.nova-*` 共 193 个。
把 Bedrock 的**长时 API key（`ABSK` 开头）**填进那个 provider 即可，桥接侧同样只改两行配置。