# Docker 部署

> 目标：把"装 Node + 探 DSH + 配 systemd"压缩成 `docker compose up -d`。
> 适用场景：**官方机器人通道**（q.qq.com）。个人号通道（SnowLuma）要扫码登录，请留在宿主机。

## 一、能跑什么 / 不能跑什么

| ✅ 能 | ❌ 不能 |
| --- | --- |
| 官方通道：收群 @ / 单聊、被动回复、主动消息、互动召回 | 个人号通道（SnowLuma 需要手机扫码，容器里没有交互界面） |
| 视频/语音处理（镜像内已装 ffmpeg） | systemd 服务管理（容器由 Docker 管） |
| 控制台（3100）+ 全部 HTTP API | 真实的 QQ 登录（那是 SnowLuma 的事） |

想同时用个人号：在宿主机跑 SnowLuma，然后把 `config.json` 的
`snowluma.wsUrl` / `snowluma.httpUrl` 指向宿主机（容器内用 `host.docker.internal`）。

## 二、三步起

```bash
# 1) 准备配置：把示例复制成实际配置
cp config.example.json config.json

# 2) 填官方机器人凭证（AppID / AppSecret）
mkdir -p state
cat > state/official.json <<'EOF'
{ "appid": "102xxxxxxx", "secret": "32位secret", "sandbox": false }
EOF

# 3) 起
docker compose up -d
docker compose logs -f
```

首次启动会自动做 state schema 迁移（`state/.schema.json`），迁移前把旧 JSON 备份到
`state/backups/schema-<from>-<ts>/`。

## 三、必须改的三处

| 位置 | 改什么 | 不改会怎样 |
| --- | --- | --- |
| `config.json` → `official.enabled` | 改成 `true` | 官方通道不启动 |
| `config.json` → `official.allow` | 填群/用户的 `official-<openid>` | 收得到消息但一律拒绝（白名单默认全拒） |
| 群设置 | 群主给机器人开「主动推送消息」「接收群内全部消息」 | 主动消息失败 / 收不到非 @ 消息 |

> `openid` 从哪来：让机器人在群里被 @ 一次，日志会打
> `[official] 进入处理：kind=group openid=xxxx…`，或看 `state/social-v2.json` 的会话 key。
> **openid 不是 QQ 号**，不能和 `allow.groups` 混用。

## 四、端口与安全

- 控制台只绑 `127.0.0.1:3100`，要远程访问请自己加反代（不要裸暴露）
- 令牌在 `state/console-token`，首次启动自动生成
- `state/` 与 `config.json` 都是挂载卷，容器重建不丢数据

## 五、体检

```bash
# 容器内
docker compose exec qq-bridge node scripts/check-health.mjs --skip-audit

# 或宿主机（挂在同一个 state 上）
node scripts/check-health.mjs --skip-audit
```

健康检查（`HEALTHCHECK`）每 30 秒打一次 `/api/status`，容器状态会显示 `healthy / unhealthy`。

## 六、已知限制

| 限制 | 说明 |
| --- | --- |
| 镜像未做多阶段构建 | 现在直接 `npm install`；体积偏大（含 ffmpeg），但简单可靠 |
| 依赖装在构建期 | 改 `package.json` 后要重新 build |
| 无 `docker compose watch` | 开发场景建议直接 `node src/bridge.js` |

## 七、故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `unhealthy` | `/api/status` 401（没带令牌） | 健康检查只探端口，401 也算可达；若真为 unhealthy 看 `docker compose logs` |
| 官方通道没起来 | `official.enabled=false` 或凭证为空 | 改 `config.json` / `state/official.json` 后重启 |
| 收得到但不回 | `official.allow` 没加 openid | 加白名单并重启 |
| 主动消息 403 | 群主没开「主动推送消息」 | 群主在群机器人设置里打开 |

## 八、验证状态（真机跑过）

| 项 | 结果 |
| --- | --- |
| `docker compose config` | ✅ |
| `docker compose build` | ✅ 镜像 `qq-bridge:latest` 1.05GB |
| `docker run` + 端口映射 | ✅ 宿主机 `http://127.0.0.1:3102/api/status` → 401（无令牌）/ 200（带令牌） |
| `HEALTHCHECK` | ✅ `Up (healthy)`，日志 ExitCode 0 |
| 数据卷 | ✅ `config.json` + `state/` 挂载生效 |

### 容器里必须对齐的两件事

1. **`consoleHost` 必须是 `0.0.0.0`**（否则容器内只绑回环，宿主机映射不进来）
   compose 已用环境变量 `QQB_CONSOLE_HOST=0.0.0.0` 解决
2. **`consolePort` 必须和端口映射一致**（否则 Host 头校验 403）
   用 `QQB_CONSOLE_PORT` 环境变量与 `-p` 映射同步；默认映射 `3100:3100` 时无需设置

### 健康检查为什么接受 401

`/api/status` 需要令牌，未带令牌返回 401 —— 401 说明 HTTP 活着，不能当"不健康"。
早期用 `curl -fsS` 会因此一直 unhealthy，现已改为 `docker/healthcheck.sh`（200 或 401 都算健康）。

## 九、旧版验证记录（C: 空间不足那次）

| 项 | 结果 |
| --- | --- |
| `docker compose config` 语法 | ✅ 通过 |
| 镜像构建 11 个步骤 | ✅ 全部 DONE（基础镜像拉取、apt 装 ffmpeg、npm install、COPY 源码） |
| 导出镜像 / unpacking | ❌ 失败：`commit failed: input/output error` |

失败原因是**宿主机 C: 盘满了（0GB 可用）**，Docker Desktop 的 WSL 存储随后变成
`read-only file system` —— 不是 Dockerfile 的问题。腾出空间后重跑：

```bash
docker compose build
```

若 C: 长期吃紧，两条路（都验证过）：

1. **GUI**：Docker Desktop → Settings → Resources → Advanced → Disk image location → 改到别的盘
2. **目录联接**（本次采用，无需重启 Docker Desktop 的数据迁移向导）：

```powershell
docker desktop stop
wsl --shutdown
Move-Item "$env:LOCALAPPDATA\Docker\wsl" "D:\Docker\wsl"
cmd /c mklink /J "$env:LOCALAPPDATA\Docker\wsl" "D:\Docker\wsl"
docker desktop start
```

> 实测：C: 从 0.06GB 释放到 4.05GB，镜像/容器/数据全部保留（Docker 仍按原路径找，只是指向 D）。
