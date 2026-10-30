# 官方通道富媒体（图片）实作记录

> 面向两种读者：想改这块代码的人，以及 AI 助手。
> 全部结论都来自 **2026-10-29 的真机验证**（官方群，机器人「小鲸鱼」），不是照抄文档。

---

## 一、协议：两步，缺一不可

```
① 上传    POST /v2/{groups|users}/{openid}/files
          body: { file_type, url | file_data(+file_name), srv_send_msg:false }
          → { file_info, ttl, file_uuid }

② 发送    POST /v2/{groups|users}/{openid}/messages
          body: { msg_type: 7, media: { file_info }, msg_id?, msg_seq?, content? }
```

- 单聊与群聊的**上传接口互相隔离**：用群接口传的文件只能发到群。
- `content` 可以和 `media` 并存 —— 单图带一句话时合并成一条，别拆成两条。
- `srv_send_msg: true` 可省掉第 ② 步，但**会占主动消息频次**；多数自建机器人没有该权限。

---

## 二、`file_type` 与大小限制

| file_type | 类型 | 格式 | 软限制 | 硬限制 |
| --- | --- | --- | --- | --- |
| 1 | 图片 | png / jpg | 20 MB | 200 MB |
| 2 | 视频 | mp4 | 30 MB | 200 MB |
| 3 | 语音 | silk（文档另处写 mp3/wav） | 20 MB | 200 MB |
| 4 | 文件 | 任意 | 200 MB | 200 MB |

超过软限制会**降级成文件**上传；超过硬限制直接报错。

三种上传方式的选择：

| 方式 | 适用 | 限制 |
| --- | --- | --- |
| URL | 文件已在公网可访问 | 平台要去下载，**可能下载失败（850026）** |
| **分片**（upload_prepare → PUT → part_finish → 合并） | 大文件、本地文件，**推荐** | 实现最复杂 |
| **二进制直传**（`file_data` base64） | ≤ **5MB** 的本地文件 | 我们目前用的这条 |

---

## 三、三个真机踩到的坑

### 坑 1：二进制上传 **`file_name` 必填**

只传 `file_data` 会直接 400。文档在"请求体"表里写了，但很容易漏：

```js
// ❌ 会被拒
{ file_type: 1, file_data: '<base64>', srv_send_msg: false }
// ✅
{ file_type: 1, file_name: 'image-1730.png', file_data: '<base64>', srv_send_msg: false }
```

### 坑 2：`file_info` 的 ttl **实测 86400 秒**（文档示例写 300）

```
✓ 上传成功：file_info 长度=1068 ttl=86400
```

两条实践结论：
- **上传后立刻发**，不要缓存复用（ttl 再长也会过期，且过期报错信息不直观）。
- 别信文档示例里的 300 秒去设超时。
- **不要用 ttl 做任何超时 / 缓存决策**：它不是 SLA，只是服务端返回的一个字段；
  ttl 只用于打日志。正确做法是「上传成功就立刻发」，失败重传，而不是「等 ttl 到期再说」。

### 坑 3：`msg_seq` 必须**递增且不重复**，否则「消息被去重」

真机第一次发图就撞上了：

```
✗ 发送失败：HTTP 400 消息被去重，请检查请求msgseq
```

原因：机器人先前的**文本回复已经用掉 seq=1**，发图又传了 1。
官方对同一个 `msg_id` 最多回 5 条，序号必须由调用方自己递增。

桥接里由 `bot.seqTracker.next(msgId)` 统一分配（`reply()` 一直如此，
新写的 `sendImage` 一开始漏了，现在已补）。

### 附加坑 4：主动消息**无权限**

```
✗ 发送失败：HTTP 400 主动消息失败, 无权限
```

自建机器人通常没开主动消息。所以：
- 必须带 `msg_id` 走被动回复；
- 被动窗口是 5 分钟（桥接按 4.5 分钟算，留 30 秒余量）；
- 序号用尽（5 条）后只能等用户再发消息。

---

## 四、真机验证记录（2026-10-29 13:31）

```
图片：4170 字节，格式=image/png
① 上传中（POST /v2/groups/{openid}/files）…
✓ 上传成功：file_info 长度=1068 ttl=86400
② 发送中（msg_type=7）…
✗ 第一次 msg_seq=1 → HTTP 400 消息被去重
✓ 重试 msg_seq=2 → 成功
```

群里实际收到：测试图 + 附言「官方通道发图自检」。

---

## 五、代码位置

| 文件 | 职责 |
| --- | --- |
| `src/official-media.js` | 纯函数：`sniffImageMime` / `buildUploadBody`（校验 file_name）/ `buildMediaMessage`（msg_type=7）/ `checkImageForOfficial` / `pickFileInfo` |
| `src/qqbot-official.js` | `uploadMedia` / `sendGroupMedia` / `sendC2CMedia` |
| `src/official-transport.js` | `sendImage(kind, id, buffer, opts)`：过闸门 → 上传 → **立刻**发；`shouldUsePassiveWindow()` 统一被动窗口判断 |
| `bridge.js` 官方发送分支 | 图片段走富媒体；单图+文本合并；失败降级成文本，不让整条消息丢 |
| `scripts/probe-official-image.mjs` | 真机探针（唯一能验证"官方到底认不认这些字段"的手段） |
| `scripts/test-official-media.mjs`、`test-official-send-image.mjs` | 离线契约测试 |

### 探针怎么用

```powershell
# 只看上传（发不出去也没关系，能验证 file_data/file_name）
node scripts/probe-official-image.mjs --kind group --openid <openid> --file D:\x.png

# 完整两步：需要最近一条入站的 msgId（被动回复才有权限）
node scripts/probe-official-image.mjs --kind group --openid <openid> --file D:\x.png ^
  --msgId <ROBOT1.0_...> --msgSeq 2 --content "自检"
```

`msgId` 从哪来：桥接每收到一条官方入站就写 `state/official-inbound.json`
（`{ kind, openid, msgId, at }`，需要 `createOfficialTransport({ inboundFile })`）。

---

## 六、格式的坑：官方文档自相矛盾

| 文档位置 | 说法 |
| --- | --- |
| 富媒体**概述**页 | 图片支持 jpg/png/**gif/webp/bmp** |
| **上传接口**页 + 限制表 | 图片只支持 **png / jpg** |

我们的策略（`checkImageForOfficial`）：

- png / jpg → 直接发
- gif / webp → 返回 `risky: true` + 提示「建议转 png」，由调用方决定

---

## 七、还没有做的（别误以为支持）

| 项 | 状态 |
| --- | --- |
| 分片上传（>5MB、视频） | ❌ 未实现 |
| 语音（`file_type:3`，silk 编码） | ❌ 未实现（silk 转码是独立工程） |
| 视频 / 文件（`file_type:2/4`） | ❌ 未实现，但字段已预留 |
| 官方通道的**接收**图片 | ⚠️ 入站图片目前只作为附件信息传入上下文，没有做 OCR / 转存 |

---

## 八、错误码速查

| 码 | 含义 | 先查什么 |
| --- | --- | --- |
| 850018 | 群或机器人被禁言 | 群状态 |
| 850019 | 不支持的文件格式 | `file_type` 与真实格式是否一致 |
| 850026 | 下载原始文件失败 | 用了 URL 上传？改二进制直传 |
| 850031 | 超过大小限制 | 是否 >5MB 直传 / >20MB 图片 |
| 40093002 | 超过当天发送文件容量 | 明天再试或减小体积 |
| —— | 消息被去重 | **`msg_seq` 重复**（本文坑 3） |
| —— | 主动消息失败, 无权限 | 没带 `msg_id`（本文坑 4） |
