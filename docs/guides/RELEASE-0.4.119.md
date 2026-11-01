# 发布清单：0.4.107 → 0.4.119（13 个版本，一次性推）

> 生成于 2026-11-02。所有提交都在本地，`origin/main` 还停在 `0.4.106`。
> 这份文件既是**操作清单**，也是**Release 说明的底稿**。

## 一、现状核对

| 项 | 值 |
| --- | --- |
| 远端版本 | `0.4.106`（commit `450caa7`） |
| 本地版本 | `0.4.119`（commit `13245f0`） |
| 领先提交 | **13 个** |
| 文件改动 | **49 个**（+4,669 / −72） |
| 新增文件 | **31 个** |
| 审计 | **174/174** |
| 工作区 | 干净（0 项未提交） |

## 二、这 13 个版本做了什么

### 安全（0.4.107 / 0.4.109 / 0.4.110）

- **设备配对 + HMAC 签名**：`/api/auth/pair` 领 `deviceId + secret`，每个请求签 `method+path+ts+nonce+bodyHash`，
  服务端校验 ±60 秒时间窗 + nonce 去重 + 常量时间比较，可一键吊销设备
- **局域网访问**：`consoleHost: 0.0.0.0` + Host 白名单自动放行本机私有 IP（含 Tailscale 的 `100.64/10`）
- **控制台限流 + 审计**：同源 60 秒失败 12 次 → 429；`state/access-log.jsonl` 记录谁、从哪、被拒原因

### 官方通道（0.4.113 – 0.4.117）

- **429 / 5xx 退避重试**：读 `retry-after`，否则指数退避，最多 3 次；重试时 `msg_seq += 1`（否则被去重直接拒）
- **`res.ok` ≠ 成功**：官方 201/202 是「异步成功」但响应体仍可能带 error body，改为按 `err_code` 判定
- **配额修正**：单聊被动回复是 **4 条 / 60 分钟**（不是 5 条），群聊 5 条 / 5 分钟，按 kind + TTL 记账
- **错误码订正**：删掉 4 个编错的码（`11241`/`304003`/`304023`/`11244`），未知码只显示原始信息
- **扫码绑定**：`q.qq.com/lite/create_bind_task` → 轮询 → **AES-256-GCM** 解出 AppSecret，用户不用手抄 AppID
- **markdown 出站**：`msg_type: 2` + 按 `err_code` 降级纯文本 + 10 分钟记忆化（被拒过就不再试）
- **告诉模型「通道支持 markdown」**：它之前会主动说「QQ 不吃这套」，现在按通道注入能力说明

### 体验（0.4.108 / 0.4.111 / 0.4.112 / 0.4.114 / 0.4.118 / 0.4.119）

- **手机版页面 + PWA**：一屏六个大按钮（状态/日志/会话/重置/空间/配对），可安装到主屏幕
- **二维码修正**：`/api/console/addresses` 让二维码编局域网地址，而不是 `127.0.0.1`（手机扫了连自己）
- **手机端排版**：顶部导航两行 + 折叠；记忆星图窄屏单列 + 图例收起
- **版本更新提示**：`/api/update/check` 比对 GitHub Releases，6 小时缓存，顶部横幅
- **长文本转图（t2i）**：Edge headless 渲染卡片；桥接里 spawn 不动 → 改 **CDP 侧车**，**0.75 秒**出图

### 人格（0.4.117 / 0.4.119）

- **通道能力提示**：每个会话告诉模型当前通道能渲染什么（官方 markdown / 个人号纯文本）
- **示例对话（few-shot）**：人格卡里写「## 示例对话」，注入时从正文摘出并格式化成语气样例

## 三、31 个新文件

| 类别 | 文件 |
| --- | --- |
| 安全 | `src/access-guard.js` `src/device-auth.js` `src/lan-hosts.js` `src/api/device-auth-route.js` |
| 官方通道 | `src/official-bind.js` `src/official-errors.js` `src/official-limits.js` `src/official-test-send.js` `src/md-to-qq-markdown.js` `src/api/official-bind-route.js` `src/api/official-test-route.js` |
| 渲染 | `src/t2i.js` `src/t2i-cdp.js` `src/t2i-send.js` `src/browser-detect.js` `src/api/t2i-route.js` `scripts/t2i-sidecar.ps1` `scripts/t2i-sidecar.cmd` |
| 人格 | `src/role-dialogues.js` |
| 更新 | `src/update-check.js` `src/api/update-route.js` |
| 分发 | `scripts/build-download-page.mjs` |
| 测试 | `scripts/test-{access-guard,device-auth,lan-hosts,official-bind,official-retry,qq-markdown,channel-hint,role-dialogues,update-check}.mjs` |

## 四、明天推送步骤

```powershell
cd D:\QQBot-open\qq-bridge

# 1) 最后一次自检（应该 174/174）
D:\QQBot-open\..\..\node\bin\node.exe scripts\test-audit.mjs   # 或你的 node 路径

# 2) 确认没有敏感内容（应该通过）
node scripts/check-privacy.mjs

# 3) 推送提交 + 13 个 tag
git push origin main
git push origin v0.4.107 v0.4.108 v0.4.109 v0.4.110 v0.4.111 v0.4.112 v0.4.113 v0.4.114 v0.4.115 v0.4.116 v0.4.117 v0.4.118 v0.4.119

# 4) 建一个合并 Release（比建 13 个清爽）
gh release create v0.4.119 --title "v0.4.119 · 官方通道扫码绑定 + markdown + 长文本转图" --notes-file <本文件第三节后的 Release 文案>
```

> 建议：**只建 `v0.4.119` 一个 Release**，正文用下面那份；13 个 tag 留着方便 `git checkout`。

## 五、Release 正文（可直接用）

```markdown
## 这次一口气补了 13 个版本（0.4.107 → 0.4.119）

### 安全
- 设备配对 + HMAC 请求签名（手机端凭证，可一键吊销）
- 局域网访问：`consoleHost: 0.0.0.0` + Host 白名单（含 Tailscale 网段）
- 控制台限流（失败 12 次 / 分钟 → 429）+ 访问审计 `state/access-log.jsonl`

### 官方 QQ 机器人
- **扫码绑定**：不用再手抄 AppID/Secret，手机扫码即得（AES-256-GCM 解密）
- **markdown 渲染**：标题/加粗/列表/引用/链接，按 err_code 自动降级纯文本
- **429 退避重试** + 重试换 msg_seq（避免被去重拒）
- 单聊被动回复配额修正为 4 条 / 60 分钟；错误码表订正（删掉 4 个错的）
- 让模型知道「官方通道支持 markdown」（它之前会主动拒绝格式）

### 手机端
- 手机版页面（六个大按钮）+ 可安装 PWA
- 二维码改成编局域网地址（之前是 127.0.0.1，手机扫了连自己）
- 窄屏排版：导航折叠、记忆星图单列

### 长文本转图片
- 个人号不吃 markdown，长回复自动渲染成卡片图
- Edge headless + CDP 侧车，单张约 0.75 秒；失败自动回退发文本

### 人格
- 人格卡支持「## 示例对话」，按 few-shot 注入语气样例
- 按通道注入能力提示（官方 markdown / 个人号纯文本）

**审计 174/174。**
```

## 六、推送前最后检查（勾一遍）

- [ ] `git status` 干净
- [ ] `test-audit.mjs` 174/174
- [ ] `check-privacy.mjs` 通过（`dist/` 已被 gitignore）
- [ ] `config.json` **没有**被提交（含 appid/secret/consoleToken）
- [ ] 13 个 tag 都在本地（`git tag -l "v0.4.1*"` 应该有 13 个）
- [ ] README 里的「下载（国内加速）」段一起推上去
- [ ] 桌面 APK 与 `dist/download.html` 与这次源码版本一致（APK 0.5.2 对 0.4.119，兼容）
