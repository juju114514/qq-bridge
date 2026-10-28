# 快速开始（一页版）

> 5 分钟内跑起来。装不上先看最后一节「卡住了怎么办」。

---

## 0. 先做一件事：体检

```bash
git clone https://github.com/juju114514/qq-bridge.git
cd qq-bridge
npm run doctor
```

它会把**四个最容易卡住的地方**逐条告诉你（还带修法）：

| 卡点 | 体检会告诉你 |
| --- | --- |
| Node 版本 | 够不够 22，不够给 `winget` 或便携版方案 |
| DSH 位置 | 有没有找到 `.dsh`（找不到只是警告，不挡启动） |
| SnowLuma | 有没有在跑、扫码页是什么地址 |
| 官方通道 | 缺 AppID/Secret 还是缺白名单 |

---

## 1. 选一条路线

```
你有 Docker 吗？
├─ 有 → A. Docker（最省事，不需要 Node）
└─ 没有
   ├─ Windows → B. 一键脚本（推荐）
   └─ 其它系统 → C. 手动
```

### A. Docker（不需要 Node）

```bash
cp config.example.json config.json     # 改里面的 allow.groups / allow.private
docker compose up -d
docker compose ps                      # 看到 healthy 就成功
```

控制台：<http://127.0.0.1:3101>（容器用的是 3101，宿主机那套才用 3100）
token 在 `state-docker/console-token`。

> 详细说明与容器专属坑（`consoleHost` / `consolePort` 必须对齐）见 [DOCKER.md](docs/guides/DOCKER.md)。

### B. Windows 一键脚本（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

它会自动：

1. 检查 Node，**低于 22 就问你要不要下载便携版**到 `tools\node`（不动系统环境）
2. `npm ci --omit=dev`
3. 没有 `config.json` 才从示例复制（**绝不覆盖已有配置**）
4. 问你要放行的群号，写进 `allow.groups`
5. 官方通道可选：粘贴 AppID/Secret 后**当场调 `getAppAccessToken` 验证**，通过才写盘
6. 探到 SnowLuma 的 5099 端口就**自动打开扫码页**
7. 结尾跑一遍体检

参数：`-SkipOfficial`（不碰官方通道）、`-Docker`（只打印 Docker 路线）、`-Yes`（无人值守）、`-Force`（重装依赖）。

### C. 手动（任意系统）

```bash
# 1) Node >= 22
node --version          # 低于 22 就别往下走了

# 2) 依赖
npm ci --omit=dev

# 3) 配置
cp config.example.json config.json
#    改 allow.groups / allow.private —— 空白名单 = 谁都不回

# 4) 启动
node src/bridge.js
```

---

## 2. 两个外部程序（本仓库不装、不代启动）

| 程序 | 干什么 | 装完要做的 |
| --- | --- | --- |
| **DeepSeek Harness（DSH）** | AI 本体，会话在这里跑 | 安装并登录；桥接会自动探测它的端口 |
| **SnowLuma** | 个人 QQ 的 OneBot 网关 | 启动后打开 <http://127.0.0.1:5099> 扫码登录 |

不想用个人号？那可以只跑**官方机器人**（q.qq.com 的 AppID/Secret），SnowLuma 可以不装。

---

## 3. 验证它真的活着

```bash
# 控制台是否可达（401 = 活着但需要令牌，正常）
curl -i http://127.0.0.1:3100/api/status

# 令牌
cat state/console-token      # Windows: type state\console-token
```

再跑一次体检，应该全绿：

```bash
npm run doctor
```

---

## 4. 让它回消息

1. 把机器人拉进你的群，或在私聊里发一句
2. 看日志（`state/bridge.log`）有没有收到消息
3. 没回，先确认 **`config.json` 的 `allow` 里有这个群/人** —— 空白名单是故意的安全默认

---

## 卡住了怎么办

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| `EBADENGINE` / 启动崩 | Node < 22 | `winget install OpenJS.NodeJS.LTS`，或重跑 `setup.ps1` |
| 装 preset 报找不到 `.dsh` | DSH 路径没探测到 | 设 `DSH_HOME=<你的 .dsh 目录>` |
| 个人号永远连不上 | SnowLuma 没起 / 没扫码 | 起 SnowLuma → <http://127.0.0.1:5099> 扫码 |
| 官方通道 `100016` | AppID/Secret 错 | 重跑 `setup.ps1`（会当场验证），或手动核对 `config.official` |
| 官方通道 `403` / 群没反应 | 白名单里没有这个群的 openid | 启动后看日志打印的 openid，填进 `official.allow` |
| 容器 `unhealthy` | 健康检查打不到端口 | 确认 `QQB_CONSOLE_PORT` 与 `-p` 映射一致（[DOCKER.md](docs/guides/DOCKER.md)） |
| 端口 3100 被占 | 已有一个实例在跑 | 停掉旧实例；官方通道还抢同一个 bot，见「实例互斥」 |

更多排障：[TROUBLESHOOTING.md](TROUBLESHOOTING.md) ｜ 完整文档目录：[docs/README.md](docs/README.md)

---

## 用 NapCat 替代 SnowLuma（实测通过）

SnowLuma 连不上 / 想换网关时可以换 **NapCat**：两者都是 OneBot v11，
**桥接零改动**，只改 config.json 的 `snowluma.wsUrl`。

### 接线步骤

```powershell
# 1) 彻底退出 QQ 客户端（含 QQProtect），否则 NapCat 注入失败
# 2) 启动 NapCat（-q 复用登录态，或直接扫码）
D:\QQBot\tools\napcat\napcat\launcher-win10.bat -q <机器人QQ号>

# 3) 确认 OneBot 两个服务都在监听
Get-NetTCPConnection -LocalPort 3000,3001 -State Listen
```

config.json（**字段名是 `snowluma.*`，不是 `onebot`** —— 写错了不会报错，只是不生效）：

```json
"snowluma": {
  "httpUrl": "http://127.0.0.1:3000",
  "wsUrl": "ws://127.0.0.1:3001",
  "accessToken": "<NapCat 里那个 token>"
}
```

### 四个必踩的坑（都实测过）

| 坑 | 现象 | 解法 |
| --- | --- | --- |
| **只开了 HTTP，没开 WS** | 桥接一直 `1006` 重连，但 `get_login_info` 是通的 | NapCat 配置里 `websocketServers` 也要 `enable: true`（端口 3001） |
| **NapCat 与 QQ 客户端同时登录** | NapCat 启动失败，提示"已经登录，无法重新登录" | 先彻底退出 QQ（含 QQProtect 进程），再启动 NapCat |
| **二维码只有 147px** | 手机扫不动，终端里的 ASCII 码更不行 | 用 `scripts\napcat-login.ps1 -Qq <号>`，它会把二维码放大 4 倍并打开 |
| **配置写到 `onebot` 段** | 桥接日志仍报 SnowLuma 连不上 | 字段名是 `snowluma.httpUrl / wsUrl / accessToken` |

### 验证通了的样子

```
[bridge] SnowLuma 已连接：ws://127.0.0.1:3001
```

（名字还叫 SnowLuma，因为它是 OneBot 客户端的代称，不代表只能用 SnowLuma。）
