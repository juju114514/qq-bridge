# 排障手册 · TROUBLESHOOT

> 这份手册按**症状**索引。每条都来自真实事故，不是设想。
> 遇到问题先做一件事：**跑一次网关体检**

```bash
node scripts/doctor-gateway.mjs        # 只诊断
node scripts/doctor-gateway.mjs --fix  # 自动修（会先备份 config.json）
```

---

## 1. 日志每秒钟刷 `[gateway] WS 断开，等待自动重连`

**症状**

```
[gateway] WS 错误：
[gateway] WS 断开，等待自动重连（同类日志每分钟最多一条）
```

一分钟一次，永远连不上。群里发消息没反应。

**最常见原因**：**配置写的网关 ≠ 实际在跑的网关**

真实事故（2026-11-04）：配置里是 `gateway.provider=napcat`（指向 6198/6199），
但机器上真正在跑的是 SnowLuma（3000/3001）。桥接一直在连一个不存在的端口。

**怎么确认**

```bash
node scripts/doctor-gateway.mjs
```

输出会直接写清楚：

```
配置：provider=napcat  http=http://127.0.0.1:6198  ws=ws://127.0.0.1:6199
端口：
  ✓ 3000  snowluma-http   LISTEN
  ✓ 3001  snowluma-ws     LISTEN
  ✗ 6198  napcat-http     ECONNREFUSED
发现的问题：
  · 配置指向 napcat，但实际在跑的是 snowluma（端口对不上，桥接会无限重连）
```

**怎么修**

```bash
node scripts/doctor-gateway.mjs --fix    # 会自动改成实际在跑的那个
# 然后重启桥接
```

也可以手动改 `config.json`：

```json
"gateway": {
  "provider": "snowluma",
  "httpUrl": "http://127.0.0.1:3000",
  "wsUrl": "ws://127.0.0.1:3001",
  "token": "<SnowLuma 的 wsServers[0].accessToken>",
  "httpToken": "<SnowLuma 的 httpServers[0].accessToken>"
}
```

> 桥接启动时也会自检：配置和实际不符会在日志里打
> `⚠️ 网关自检：配置写的网关是 napcat，但实际在听的是 snowluma…`

---

## 2. `get_login_info` 返回 401 未经授权

**症状**：桥接连上了 ws，但读不到登录信息；或者手动 curl 网关的 HTTP 端口返回 401。

**原因**：**token 不一致**。SnowLuma 的 HTTP 和 WS 端口是**两个不同的 token**，
配置里只填一个就会有一个通、一个 401。

真实事故（2026-11-04）：`snowluma.accessToken` 填的是 `qb-token-2026`（13 位，随手写的），
真实 ws token 是 43 位随机串。

**怎么确认**：同机部署时直接读 SnowLuma 自己的配置：

```
<SnowLuma 目录>/config/onebot_<QQ号>.json
  networks.httpServers[0].accessToken   ← HTTP 端口用
  networks.wsServers[0].accessToken     ← WS 端口用
```

`doctor-gateway.mjs` 会自动读这个文件并把 token 打印出来（`--fix` 时直接写进配置）。

**怎么修**：`node scripts/doctor-gateway.mjs --fix`，或按上面两个字段手动填。

---

## 3. `连不上 DSH（http://127.0.0.1:XXXX）：fetch failed`

**原因**：DeepSeek Harness **每次启动都会换端口**，配置里写的是上次的。

**怎么确认**

1. 看 DSH 窗口标题栏 / 它自己的设置页，当前端口是多少
2. 或者看桥接日志里自动探测的结果

**怎么修**：把 `config.json` 的 `dsh.baseUrl` 改成当前端口，或直接在控制台
「接入与登录」页点「探测端口」。

> 桥接会自动探测并写回 config.json，但它只扫常见端口段；DSH 换到很偏的端口时需要手动填。

---

## 4. `⚠️ agent 处理出错：Service is too busy. We advise users to temporarily switch…`

**这不是配置问题，是上游过载。** DeepSeek 官方 API 在高峰期会返回这个（带 `request_id`）。

| 判断 | 说明 |
| --- | --- |
| 响应里有 `request_id` | 请求确实到了服务器 = 本地没问题 |
| 偶发、过几分钟就好 | 正常，重发即可 |

**怎么确认 API 本身是好的**：换一个最简单的请求直接打官方端点

```bash
curl -s https://api.deepseek.com/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer sk-你的key" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"max_tokens":4}'
```

返回 200 就说明 key 和端点都没问题。

**怎么缓解**

- 重发（多数情况一次就过）
- 配 `agent.fallbackModel` 用备用模型
- 避开晚高峰

> `request_id` 不是密钥、也不是可查询的编号；它只是 DeepSeek 侧给这一次请求的追踪号，
> 提工单时给他们用。

---

## 5. 白名单为空，机器人一条都不回

**症状**：日志有 `⚠️ 白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息`。

**这是安全默认值**，不是 bug：新装默认谁都不理，避免陌生人一句话就触发。

**怎么修**：控制台「访问与安全」页填 `ownerQQ` 与 `allow.private` / `allow.groups`，
或改 `config.json`：

```json
"ownerQQ": 123456789,
"allow": { "private": [123456789], "groups": [123456789] }
```

---

## 6. 手机端（一体化 APK）

### 6.1 屏幕显示 `容器失败：解压 rootfs 失败 … Permission denied`

**原因**：rootfs 里有**硬链接**，Android 的 toybox tar 在 App 私有目录建硬链接被 SELinux 拒。

**怎么修（打包侧）**：把 rootfs 里的硬链接实体化后重新打包（`tarfile` 遍历、`islnk()` 的成员
按目标文件内容写成普通文件）。0.5.59 之后仓库里的 `ubuntu-base-arm64.tar.gz` 已经是实体化版本。

### 6.2 屏幕显示 `ERR_INVALID_PACKAGE_CONFIG … readPackageJSON`

**原因**：在 **x86_64 模拟器**里跑 **arm64 node**（ARM 翻译层），不是代码问题。
**真机 arm64 不会出现。**

### 6.3 白屏、没有任何提示

0.5.59 之前的老包有这个毛病（`weight=1` 的双层布局互相覆盖）。
0.5.59 之后改成「工具条 + 日志面板」，失败会显示具体分类（解压失败 / apt 失败 / pip 失败 / 启动超时）。

### 6.4 QQ 登录二维码怎么扫（手机只有一台）

二维码出现在容器里，手机没法自己扫自己。三个入口：

| 按钮 | 用法 |
| --- | --- |
| 保存到相册 | 存进 `Pictures/qq-bridge/` → QQ → 扫一扫 → 右上角「相册」 |
| 分享给 QQ | 分享到 QQ → 打开图片 → 长按 → 识别二维码 |
| 用 QQ 打开 | 直接调起 QQ 打开登录链接（`txz.qq.com`） |

---

## 附：一条命令收集诊断信息（贴给别人看时用）

```bash
node scripts/doctor-gateway.mjs --json > diag.json
node scripts/report.mjs > report.md      # 脱敏的运行报告
```

两个文件都**不含 token 明文**，可以直接贴出来。
