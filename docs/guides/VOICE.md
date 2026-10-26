# 语音系统

桥接的语音能力分三层：**语音内核**（`src/voice-core.js`）、**发语音通道**（桥接路由 + MCP 工具）、**独立小工具**（`voice-gui.mjs` / `voice-cli.mjs`）。

## 一句话结论

> AI 发语音**默认是关的**。要开就把 `config.json` 里 `voice.enabled` 设成 `true`；
> 不开也能用图形界面手动试发（操作者通道不受这个开关限制）。

## 组件

| 组件 | 作用 |
| --- | --- |
| `src/voice-core.js` | 语音内核：音量/响度、格式转换、临时文件清理，全部纯函数 |
| `src/send-voice-lib.js` | 只是把 `voice-core.js` 转发出去的薄壳，不放实现 |
| `src/bridge.js` 的语音路由 | `/api/voice/send`、`/api/voice/preview` 等，含额度检查与回读校验 |
| `voice-tool/voice-gui.mjs` | **图形界面**：选文件、调音量、试听、发送 |
| `voice-tool/voice-cli.mjs` | 命令行版，适合脚本调用 |
| `发语音-图形界面.cmd` | Windows 双击直接开图形界面 |

## 图形界面怎么开

三种都行：

1. 双击 `发语音-图形界面.cmd`
2. `node voice-tool/voice-gui.mjs`
3. `node voice-tool/voice-cli.mjs --help`（命令行）

图形界面会读三处配置（后者覆盖前者）：

```
环境变量 → voice-tool/config.json → ../qq-bridge/config.json → 内置默认值
```

## 通道区别

| 通道 | 受 `voice.enabled` 限制 | 用途 |
| --- | --- | --- |
| 操作者通道（控制台 / GUI / CLI） | ❌ 不受限 | 自己手动试发、调音、验证链路 |
| AI 通道（`qq_send_voice`） | ✅ 受限 | 让模型主动发语音 |

这样设计的原因：`voice.enabled` 默认关闭是为了**省 token 和防意外外发**，
但不该把「人想手动发一条试试」也堵死。

## 音量与响度

| 参数 | 范围 | 说明 |
| --- | --- | --- |
| `volume` | `0.1 ~ 5` | 倍数增益，`1` = 原样不转码 |
| `normalize` + `loudness` | `-40 ~ -5` LUFS | 响度归一；档位 `quiet`(-20) / `normal`(-16) / `loud`(-13) |

`normalize` 与 `volume` 互斥，同时给时以 `normalize` 为准。

## 安全约束

| 约束 | 行为 |
| --- | --- |
| 文件名审计 | `assertOutboundAuditOk` 拦住可疑出站文件名 |
| 发送后回读 | `verifyVoiceMessageSent` 确认消息真的落地，不靠「我以为发了」 |
| 静默模式 | `shouldBlockSilentReply` 让 AI 语音也尊重潜水状态 |
| 绝对路径 | 受 `allowAbsolutePath` 配置约束，默认只允许语音库内文件 |
| 额度 | `voiceBudgetCheck` / `voiceBudgetCommit` 检查与记账分离，避免并发超发 |

## 常见问题

**Q：发了没声音？**
看回读结果里的 `verified`。`verified: false` 表示消息没落地，桥接会记一行日志。

**Q：语音库在哪？**
`audio/` 目录。`qq_list_voices` 只列这个目录里的文件。

**Q：能发任意本地路径吗？**
不能。默认只允许语音库相对路径，除非配置里显式放开了绝对路径。

**Q：想换成 TTS 现场合成？**
那是另一条通道（`/api/socialV2/say`），走系统 TTS，和这里的「发语音文件」不是一回事。
