# 环境快照 · 2026-11-01

> 由 `node scripts/snapshot-env.mjs` 生成。升级 DSH 前后各跑一次，diff 出适配清单。

| 项 | 值 |
| --- | --- |
| DSH 安装目录 | `D:\deep seek` |
| DSH 更新通道 | nightly |
| DSH exe 大小 / 时间 | 235 MB / 2026-10-17T09:20:50 |
| DSH 版本（PowerShell FileVersion） | 0.2.1-rc.2 |
| Node | v24.21.0 |
| 仓库版本 | 0.4.69 (3866a96 · v0.4.68) |
| 插件版本（仓库） | 0.1.0 · id=qq-bridge · 工具 8 个 |
| 插件版本（已安装） | 0.0.1 |
| 插件要求 DSH | `>=0.2.1-0 <0.3.0-0` |
| 配置键数 | 21 |
| 官方通道 | enabled=false appid=false secret=false owner=false allow=0 |
| 白名单 | private 1 项 / groups 0 项 |

## 完整数据（JSON）

```json
{
  "generatedAt": "2026-11-01 02:07",
  "localDate": "2026-11-01",
  "dsh": {
    "installDir": "D:\\deep seek",
    "exe": "D:\\deep seek\\DeepSeek Harness.exe",
    "exeInfo": {
      "sizeMB": 235,
      "mtime": "2026-10-17T09:20:50.000Z"
    },
    "versionFromPs": "0.2.1-rc.2",
    "updateChannel": "nightly"
  },
  "runtime": {
    "node": "v24.21.0",
    "platform": "win32 x64"
  },
  "repo": {
    "version": "0.4.69",
    "head": "3866a96",
    "tag": "v0.4.68"
  },
  "plugin": {
    "version": "0.1.0",
    "name": "@juju114514/qq-bridge-plugin",
    "id": "qq-bridge",
    "engines": {
      "dsh": ">=0.2.1-0 <0.3.0-0"
    },
    "tools": 8,
    "installedVersion": "0.0.1"
  },
  "config": {
    "keys": [
      "ackMessage",
      "agentPreset",
      "allow",
      "allowAllWhenEmpty",
      "consolePort",
      "consoleToken",
      "deny",
      "dsh",
      "ownerQQ",
      "pricing",
      "questionTimeoutMs",
      "role",
      "security",
      "sendDelayMs",
      "sessionCwd",
      "slang",
      "snowluma",
      "social",
      "socialV2",
      "webSearch",
      "workspaceTitle"
    ],
    "official": {
      "enabled": false,
      "hasAppid": false,
      "hasSecret": false,
      "ownerOpenidConfigured": false,
      "allowCount": 0
    },
    "allowPrivateCount": 1,
    "allowGroupsCount": 0
  }
}
```
