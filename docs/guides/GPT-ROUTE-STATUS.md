# GPT / OpenAI 通道现状（2026-10-31 实测）

## 一、结论先行

| 步骤 | 结果 |
| --- | --- |
| Key 鉴权（`GET /v1/models`） | ✅ **有效**，可见 **128 个模型** |
| 文本补全（`POST /v1/chat/completions`） | ❌ **HTTP 429 `credit_balance_exhausted`** |
| 我们的 DSH 版本 | **`0.2.1-rc.2`**（`runtime.json` 的 `desktopVersion`，与 `compat.json` 的 `testedWith.dsh` 一致） |
| DSH 是否支持 openai provider | ✅ 支持（见第三节的 asar 证据） |

**一句话**：卡点不在代码、不在配置、不在版本 —— **是账户余额为 0**。

## 二、怎么自己复验（一条命令）

```powershell
node scripts/gpt-smoke.mjs          # 只查鉴权（免费）
node scripts/gpt-smoke.mjs --chat   # 再发一次 5 token 的补全（验额度与模型）
```

输出三分法（脚本刻意把失败原因分开）：

| 输出 | 含义 | 该做什么 |
| --- | --- | --- |
| `✓ 鉴权 OK：可见 N 个模型` | key 有效 | 继续 |
| `✗ 额度不足：HTTP 429 credit_balance_exhausted` | key 有效、**没钱** | 充值，或换兼容网关 |
| `✗ 模型不可用` | 模型 id 不对 | 从脚本打印的候选里换 |

Key 来源（按优先级）：`--key` → `$env:OPENAI_API_KEY` → `state/openai-key.txt`（**已 gitignore**）。

## 三、DSH 0.2.1-rc.2 的 provider 能力（从 app.asar 里读出来的证据）

```
AGENT_METHODS = {
  providers_list: "providers/list",
  providers_set:  "providers/set",      // { providerId, apiType: "openai", baseUrl }
  providers_disable: "providers/disable",
  ...
}
```

另外 asar 里还有 `azure-openai-config.js` / `azure-openai-responses.js`，
以及设置界面里的 `CustomProviderCard`（注释原文：*"declares a provider pi-ai does not ship —
an OpenAI-compatible gateway, a self-hosted server, or a provider newer than the installed catalog"*）。

**所以「加一个 OpenAI / 兼容网关 provider」是 DSH 自带能力，不需要改桥接代码。**

## 四、我们这边的适配到底做了什么

| 位置 | 内容 |
| --- | --- |
| `src/bridge.js` | `provider` / `model` 原样透传；非 `deepseek-official` 时启动打三条警告（只验证过官方 / 工具·多模态·人格未验证） |
| `src/config.js` | 不设白名单，自定义 provider 值直接透传 |
| 本节 | 把"已验证/未验证"的边界写清楚 |

**没有针对 GPT 的特殊分支** —— 这是有意为之：一旦为某个厂商加分支，就会变成"每条路都只测过一半"。

## 五、充值之后要做的事（按顺序，别跳）

1. `node scripts/gpt-smoke.mjs --chat` → 看到 `✓ 补全成功` 才算过第一步
2. DSH → **Settings → Models** → 添加 provider：`apiType=openai`、`baseUrl=https://api.openai.com/v1`、粘 key
3. 在模型选择器里选**脚本打印出的那个真实 model id**（别凭记忆写 `gpt-4o`，可能没有权限）
4. 沙箱验证（**不要直接改真机**）：复制一份桥接目录、`consolePort=3199`、`dsh.provider=<新 provider id>`、`dsh.model=<上一步的 id>`，先只测**纯文本一问一答**
5. 通过后再测工具调用 —— 这是最可能翻车的一环（`reserved2` 是"一切皆工具"模式，每轮 5~10 次工具调用）
6. 最后才测图片输入

## 六、为什么不建议先动真机

真机现在跑的是 `deepseek-official / deepseek-flash / reasoningEffort=low`，
一改 provider 就会影响正在使用的 QQ 会话。沙箱验证通过再切，回滚成本最低。