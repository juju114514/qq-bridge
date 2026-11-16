# 网关（SnowLuma / NapCat）现状与获取方式

> 最后更新：2026-11-17
> 为什么新增这篇：2026-11 开始，两个主流网关的**上游仓库都不在了**，新同学装环境会卡在「网关下不了」。

## 1. 一句话现状

| 网关 | 上游 | 现在 |
| --- | --- | --- |
| SnowLuma | `github.com/SnowLuma/SnowLuma` | **404**（2026-11-09 转 private；社区称因律师函，官方无公告） |
| NapCat | `github.com/NapNeko/NapCatQQ` | **源码清空**（2026-11-12，README 只剩 `## Ending`），releases/tags 全删 |

两个都还能用，但**只能从社区镜像拿**，且都不会再有官方更新。

## 2. 一键获取（推荐）

仓库自带脚本，走镜像链 + SHA256 校验：

```powershell
# 看有哪些可选
powershell -ExecutionPolicy Bypass -File scripts\fetch-gateway.ps1 -Kind list

# SnowLuma v2.4.2（Windows x64，41 MB）
powershell -ExecutionPolicy Bypass -File scripts\fetch-gateway.ps1 -Kind snowluma -To D:\QQBot\snowluma

# NapCat v4.18.42（Windows Shell + Node，118 MB）
powershell -ExecutionPolicy Bypass -File scripts\fetch-gateway.ps1 -Kind napcat -To D:\QQBot\napcat

# 只看会从哪下（不落盘）
powershell -ExecutionPolicy Bypass -File scripts\fetch-gateway.ps1 -Kind snowluma -DryRun
```

脚本行为：

1. 按顺序试**镜像链**（下面第 3 节），第一个下成功且 SHA256 匹配的就用；
2. 校验失败自动换下一个镜像；
3. 解压到 `-To`，并检查标志文件（SnowLuma 看 `package.json`，NapCat 看 `napcat.mjs`）；
4. **不启动、不配置、不改**任何东西 —— 启动与扫码登录仍然是你自己的事（见 [LAUNCHER.md](LAUNCHER.md) 与设计不变量 L6）。


## 3.0 本项目的自建镜像（首选）

为了不再依赖别人的仓库，本 fork 已把两个安装包存档到自己的 Release：

| 仓库 | 内容 | 直链 |
| --- | --- | --- |
| `juju114514/snowluma-mirror` | SnowLuma v2.4.2 win-x64（41.4 MB）+ 上游 checksums | `https://github.com/juju114514/snowluma-mirror/releases/download/v2.4.2/SnowLuma-v2.4.2-win-x64.zip` |
| `juju114514/napcat-mirror` | NapCat v4.18.42 四个 Windows 包 | `https://github.com/juju114514/napcat-mirror/releases/download/v4.18.42/NapCat.Shell.Windows.Node.zip` |

`scripts/fetch-gateway.ps1` 已经把它们放在镜像链**第一位**，所以默认就走这里；
后面仍保留 TomyJan / zhx57 / 19901115 等社区镜像做兜底。

## 3. 镜像清单（2026-11-17 实测可用）

### SnowLuma v2.4.2

| 仓库 | star | 备注 |
| --- | --- | --- |
| `TomyJan/SnowLuma` | 483 | 完整镜像，release 8 个资产（win-x64.zip 41.4 MB） |
| `zhx57/SnowLuma` | 22 | 存档镜像 |
| `venti1112/snowluma` | 10 | 备份，描述写明「上游已因律师函 private」 |
| `XingYunStar/snowluma` | 88 | 完整源码历史 + Docker 镜像 |

直链（脚本里已内置）：

```
https://github.com/TomyJan/SnowLuma/releases/download/v2.4.2/SnowLuma-v2.4.2-win-x64.zip
sha256 0912926c5e73260f35b000278a8658493fc9452f36782c32fa86f0e825bad81a
```

### NapCat v4.18.42

| 仓库 | star | 备注 |
| --- | --- | --- |
| `19901115/NapCatQQ` | 0 | 归档：完整源码 + v4.15.0~v4.18.42 release 产物 + Docker |
| `talentestors/NapCatQQ` | 0 | 同款镜像（自 `XingYunStar/NapCatQQ`） |
| `Mrkalilunx/NapCatQQ` | 1 | 完整历史（5028 条提交、761 个 tag） |
| `bamboosir1109/napcatqq-backup` | 1 | v4.18.42 源码归档 |

直链（脚本里已内置）：

```
https://github.com/19901115/NapCatQQ/releases/download/v4.18.42/NapCat.Shell.Windows.Node.zip
sha256 77397ac38d66f46383e48f08f35d5f9d37ec575c22069f62d6c600e73b4521ed
```

同版本还有 `NapCat.Shell.zip`（34.3 MB）、`NapCat.Shell.Windows.OneKey.zip`（0.9 MB）、
`NapCat.Framework.zip`（35.1 MB）、docker tar（583 MB）—— 需要就换 `-Kind` 或手动下。

## 4. 自己托管（最稳，推荐团队这么做）

镜像迟早也会消失。**把 zip 传到自己仓库的 Release**，然后：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\fetch-gateway.ps1 `
  -Kind snowluma `
  -Mirror https://github.com/<你的账号>/<你的仓库>/releases/download/gateway-v2.4.2/SnowLuma-v2.4.2-win-x64.zip `
  -To D:\QQBot\snowluma
```

`-Mirror` 会排在镜像链最前面，SHA256 仍然校验，所以传上去的文件没坏就能用。

> 注意许可：SnowLuma 是「源码可见、非商业」许可，NapCat 是「非商业」许可。
> 在自己仓库的 Release 里放**原始 zip**（不修改、不再分发源码树）是社区通行做法；
> **不要**把它们的代码合进本仓库（`NOTICE.md` 有说明，本仓库也不分发任何网关代码）。

## 5. 拿到之后

1. 解压目录里按各自文档启动（SnowLuma：`node index.mjs`；NapCat：`launcher.bat`）；
2. 扫码登录 QQ 小号；
3. 确认 `config.json`：

```json
{
  "gateway": {
    "provider": "snowluma",
    "httpUrl": "http://127.0.0.1:3000",
    "wsUrl": "ws://127.0.0.1:3001"
  }
}
```

NapCat 默认是 `http://127.0.0.1:6199`（WS 同端口），把上面两行换掉即可。

4. 连不上：`node scripts/doctor-gateway.mjs`，再查 [TROUBLESHOOT.md](TROUBLESHOOT.md)。

## 6. 长期选型

| 网关 | 状态 | 适合 |
| --- | --- | --- |
| SnowLuma 2.4.2 | 镜像可下，无更新 | 已经在用、不想迁移 |
| NapCat 4.18.42 | 镜像可下，无更新 | 需要 NTQQ 生态插件 |
| `LuckyLilliaBot`（原 LLOneBot） | 活跃（3.8k★） | 想要还在维护的 |
| `Lagrange.Core` | 活跃（3.0k★） | 不想依赖 NTQQ 客户端 |

本仓库只走 **OneBot v11**，换网关只改 `gateway.httpUrl/wsUrl` 两个字段，代码不用动。
