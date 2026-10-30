# 真发端点实测 · 2026-10-31 04:00

波次 4 剩下 8 条"必须真发东西才能验证"的端点，逐条实打了一遍。
全部发到 **owner 私聊**或经授权后的群 `123456789`，不打扰其它群。

## 一、结果

| 端点 | 结果 | 证据 |
| --- | --- | --- |
| `POST /api/send/private` | ✅ 200 | 日志 `[send] /api/send/private private:…: 成功 1/1 条` |
| `POST /api/voice/send` | ✅ 200（**修了 3 个 bug 才通**） | `已发送语音 bieji.mp3（2秒 · 12.1 KB, messageId=151113528）` |
| `POST /api/send/group`（群 123456789） | ✅ 200 | `[send] /api/send/group group:123456789: 成功 1/1 条` |
| `POST /api/send/reply`（非法 id） | ✅ 400 且原因明确 | `无法解析被引用消息，请确认 message id 正确…` |
| `POST /api/socialV2/sticker-list` | ✅ 200 | `total: 66, matched: 66`（触发了一次 OneBot 同步） |
| `POST /api/socialV2/wait`（1s） | ✅ 200 | `{ purpose:"messages", arrived:false, timeout:true, waitedMs:5294 }` |
| `POST /api/socialV2/song`（小星星 15s） | ✅ 200 + 真发语音 | `[song] 开始点歌 → 已发送语音 小星星_035754.mp3（15秒 · 176.7 KB）, 结束 code=0` |
| `POST /api/send/voice`（带 agent token） | ✅ 403 | `AI 请改用 /api/socialV2/send-voice`（安全边界生效） |
| `GET /api/tokens/<unknown>` + agent token | ✅ 403 | `该接口仅控制台可用`（前缀兜底按预期） |
| 未知路径 | ✅ 404 | `not found` |

## 二、这轮抓到的真 bug：`/api/voice/send` 一直是 500

连撞三个运行时错误：

```
voiceBudgetCommit is not defined
path is not defined
verifyVoiceMessageSent is not defined
```

**这个模块从 bridge.js 抽出来之后就没成功发过语音**（操作者通道每次 500）。
`node --check` 只查语法、全量审计也没覆盖这条路径 —— 只有真发一次才暴露。

修法：`src/api/voice-send.js` 的解构与 bridge 的传参各补 4 个名字
（`voiceBudgetCommit` / `path` / `appendActivity` / `verifyVoiceMessageSent`）。

## 三、试过但**没提交**的东西

想写静态守卫 `check-module-deps.mjs` 自动找"用了但没注入"的标识符，但启发式误报太多
（正则字面量里的 `group|private`、对象键、解构参数都识别不了，连 `scheduler/engine.js`
的参数 `now` 都被报）。**与其提交一个天天要人肉过滤的守卫，不如撤掉。**

## 四、教训

> 「语法检查 + 审计全绿」不能证明端点能用。
> 对**有副作用**的端点，唯一可信的验收是：真发一次 + 看日志里的成功行。

## 五、仍未覆盖

| 项 | 原因 |
| --- | --- |
| `/api/send/reply` 的成功路径 | 需要目标群真实 messageId（SnowLuma 的 HTTP 历史接口返回 401，取不到） |
| 群发到其它三个群 | 未经授权，没打 |