# 外部触发入口（`POST /api/inject`）

> 让 webhook / cron / 监控 / GitHub Actions 能推动机器人做事 —— 而不用给它们控制台令牌。

## 一、为什么单独一把令牌

| 令牌 | 能做什么 | 给谁 |
| --- | --- | --- |
| `state/console-token` | 改配置、重启、看全部状态 | 你自己（控制台） |
| **`state/inject-token`** | **只能往指定会话注入一条消息** | CI / 监控 / 外部系统 |

外部系统即使被拖库，也拿不到改配置或读全量数据的权限。
`/api/inject` **故意不接受**控制台令牌（prelude 里单独放行，鉴权在 handler 内用定长比较做）。

## 二、接口

```
POST /api/inject
Authorization: Bearer <state/inject-token>
Content-Type: application/json

{
  "key":   "group:official-<openid>"   // 或 group:<群号> / private:<QQ号>
  "mode":  "prompt" | "say",           // 默认 prompt
  "text":  "构建 #123 失败了",
  "source": "github-actions"           // 可选，写进活动日志便于溯源
}
```

| 模式 | 行为 |
| --- | --- |
| `prompt` | 把这段文字**交给 AI**，由它决定怎么在群里说（走正常唤醒/发言链路） |
| `say` | **直接**把这句发到会话（不经过 AI） |

响应：

```json
{ "ok": true, "key": "group:official-…", "mode": "prompt", "injected": true }
```

## 三、示例

```bash
# CI 失败 → 让 AI 去群里说一声（它自己组织语言）
curl -X POST http://127.0.0.1:3100/api/inject \
  -H "Authorization: Bearer $(cat state/inject-token)" \
  -H "content-type: application/json" \
  -d '{"key":"group:official-<openid>","mode":"prompt","text":"CI 构建 #123 失败了，看一下","source":"github-actions"}'

# 监控告警 → 直接发（不经 AI，措辞固定）
curl -X POST http://127.0.0.1:3100/api/inject \
  -H "Authorization: Bearer $(cat state/inject-token)" \
  -H "content-type: application/json" \
  -d '{"key":"private:official-<openid>","mode":"say","text":"磁盘使用率 92%"}'
```

## 四、护栏

| 护栏 | 规则 |
| --- | --- |
| 开关 | `config.inject.enabled=false` 时整体关闭（返回 401） |
| 令牌 | 首次启动自动生成到 `state/inject-token`（48 位 hex）；可 `config.inject.token` 覆盖 |
| 白名单 | 目标必须在 `allow` / 当前模式允许范围内，否则 403 |
| 限流 | `config.inject.maxPerMinute`（默认 30/分钟），超了 429 |
| 长度 | `text` ≤ 2000 字 |
| Host | 仍受 prelude 的 Host 校验：只能本机回环访问（要远程请加反代） |

## 五、故障排查

| 现象 | 原因 |
| --- | --- |
| 401「未启用」 | `config.inject.enabled=false` |
| 401「缺少令牌」 | 没带 `Authorization: Bearer` |
| 401「令牌无效」 | 令牌和 `state/inject-token` 不一致（重启不会变，删文件会重新生成） |
| 403「Host 头不被允许」 | 用了非回环地址访问（如局域网 IP），请走反代 |
| 403「不在白名单」 | 目标会话没在 `allow.groups` / `allow` 里 |
| 429 | 超过 `maxPerMinute` |
| 502 | `prompt` 模式下 DSH 不可用（消息没进去） |
| 500 | `say` 模式发送失败（看桥接日志的 `[inject]` 行） |

## 六、验证状态

| 项 | 结果 |
| --- | --- |
| 单测（`test-inject.mjs`，9 项） | ✅ 鉴权/开关/参数/白名单/限流/prompt|say/失败分支 |
| 线上：无令牌 | ✅ 401 |
| 线上：非法 key | ✅ 400 |
| 线上：非白名单 | ✅ 403 |
| 线上：成功注入 | ⏳ 未跑真实群发（避免打扰群；逻辑由单测覆盖） |
