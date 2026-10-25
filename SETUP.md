# 三步接上你自己的 DeepSeek

> 这个机器人**不直接存 DeepSeek 密钥**。它连的是本机的 **DeepSeek Harness（DSH）**，
> DeepSeek 的登录/密钥放在 DSH 里。所以「换一个人用」= 换他自己登录的 DSH，机器人代码不用改。

## 一、准备两样东西

| 需要 | 干什么 | 去哪弄 |
| --- | --- | --- |
| **DeepSeek Harness（DSH）** | 真正跟 DeepSeek 对话的 agent 运行时 | 安装后打开，用自己的 DeepSeek 账号登录（或在 DSH 设置里填自己的 API Key） |
| **SnowLuma** | QQ ↔ OneBot 网关，让机器人收得到 QQ 消息 | 安装后扫码登录你的 QQ 小号，记下 HTTP 端口和 access token |

DSH 默认监听 `http://127.0.0.1:3080`（以 DSH 窗口里显示的地址为准）。
SnowLuma 默认 `ws://127.0.0.1:3001`（WebSocket）+ `http://127.0.0.1:3000`（HTTP）。

## 二、跑一下配置向导

```bash
npm install
```

Windows 上直接双击或在 PowerShell 里：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

它会依次问你：

1. **DSH 地址** —— 默认 `http://127.0.0.1:3080`，直接回车即可
2. **SnowLuma WebSocket / HTTP 地址** —— 默认填好，回车即可
3. **SnowLuma access token** —— 在 SnowLuma 的 WebUI 里复制（留空也能跑，但建议填）
4. **你的 QQ 号**（管理员号）—— 只有这个号能用管理命令
5. **允许的群号 / 私聊号** —— 逗号分隔，留空表示都不放行

答完会在当前目录生成 `config.json`。想手动改也行：`cp config.example.json config.json` 然后编辑。

## 三、启动

```bash
npm start
```

看到这些日志就是通了：

```
SnowLuma 已连接：ws://127.0.0.1:3001
机器人昵称: xxx
DSH 已就绪（模式: chat）
```

然后用你的 QQ 给机器人发条消息试试。

## 常见问题

**Q：为什么不直接在机器人里填 DeepSeek API Key？**
A：因为所有对话、工具调用、上下文压缩都由 DSH 负责，机器人只是「QQ ↔ DSH」的搬运工。
把密钥留在 DSH 里，换模型（flash / pro）、换思路强度、换 provider 都在 DSH 里点一下就行，机器人不用重启。

**Q：我自己的 DeepSeek 账号和作者的不一样，会影响吗？**
A：完全不影响。机器人不知道也不关心你用的是哪个账号，费用记在你自己的 DSH 上。

**Q：DSH 端口不是 3080 怎么办？**
A：DSH 窗口标题栏/设置里会显示实际地址，把它填进 `config.json` 的 `dsh.baseUrl` 即可。

**Q：能不用 DSH，直接调 DeepSeek HTTP API 吗？**
A：可以，但需要自己写一层适配（`src/dsh-client.js` 是唯一跟 DSH 通信的地方，接口就在那里）。
上游和本分支都只维护 DSH 这条路，改造成本不高但需要熟悉协议。

**Q：QQ 那边要准备什么？**
A：一个能登录的 QQ 小号（建议小号，别用大号）。SnowLuma 扫码登录后，机器人就以这个号的身份说话。
