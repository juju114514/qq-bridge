# room-pet ↔ 抖音（集成说明）

> 本目录是 `qq-bridge` 的**抖音集成**部分：用 CDP 驱动本机浏览器操作抖音网页版，
> 做「自动回私信 / 自动回评论」，并给 QQ 侧的看板提供状态。
>
> **两套技术栈，同一个仓库**：`src/` 是 Node（QQ 侧桥接），本目录是 Python（抖音侧）。
> 两边唯一的硬契约是**安全词语义**（`off / skip|reset / pause`）与看板接口，
> 所以放在一起维护，避免改一边忘另一边。
>
> 目录里还有一个 `index.html` / `app.js` 构成的「深夜书房」互动页（纯前端，见 README.md），
> 那是另一件事，跟抖音脚本没关系。

## 一、它能做什么 / 不能做什么

| 能做 | 不能做 |
| --- | --- |
| 自动回抖音私信（`auto_dm_reply.py`） | ❌ 刷推荐流 / 自动看视频 |
| 自动回评论（`auto_reply_comments.py`） | ❌ 绕过登录 / 破解接口 |
| 登录（扫码 / 验证码截图点选，`douyin_login.py`） | ❌ 无账号批量操作 |
| 导出 cookies 给 QQ 侧下载视频用（`export_cookies.py`） | ❌ 自动加好友 / 群发 |
| 点赞 / 收藏 / 发评论（默认**全关**） |  |
| 直播页轮询（`live_douyin.py`） |  |

## 二、开关（`douyin/auto.json`）

```json
{
  "enabled": false,
  "dm_reply": false,
  "reply_comments": false,
  "auto_like": false,
  "auto_collect": false,
  "auto_comment": false,
  "safetyWords": ["安全词", "别回了", "停下"],
  "safetyAction": "skip",
  "safetyPauseMinutes": 30
}
```

> `douyin/` 已 gitignore（里面有抓下来的页面数据），第一次跑按代码默认值来。

## 三、安全词（与 QQ 侧同一套语义）

| `safetyAction` | 行为 |
| --- | --- |
| `off` | 不检查安全词 |
| `skip` | 命中这一条不生成、不发送（标记已处理） |
| `pause` | 命中 + **整个自动回复静默 N 分钟**（写 `dy_safety_pause.json`） |

实现：`safety_words.py`；调用点 `auto_dm_reply.py` / `auto_reply_comments.py`。

## 四、前置条件

```
1 Python 3.10+（本机验证 3.12）
2 pip install -r requirements.txt
3 Edge 或 Chrome（用 ProgramFiles 环境变量找，不写死路径）
4 一个已登录的抖音账号（扫码登录，见 使用说明.md）
5 调试浏览器开 CDP 端口（默认 9237 / 9238）
```

环境变量（都可选，不设就用家目录下的默认值）：

| 变量 | 作用 |
| --- | --- |
| `DY_PROFILE` | 浏览用的调试 profile（默认 `~/QQBot/temp/dy/browseprofile`） |
| `DY_LOGIN_PROFILE` | 登录专用 profile |
| `DY_LIVE_PROFILE` | 直播页 profile |
| `QQB_CONSOLE_TOKEN` / `QQB_BRIDGE_LOG` | 桥接控制台令牌 / 日志 |
| `QQB_CONFIG` / `QQB_COOKIES` | 桥接 config / cookies 输出路径 |

## 五、素材不在本仓库

`assets/`、`unity/`、`screenshots/` 里的立绘、Live2D 模型、PSD、预览图**都没有进仓库**：
体积大（54MB+），且**版权**属于第三方，本项目没有权利分发。要跑完整看板需要自备素材，
详见 [NOTICE.md](NOTICE.md)。

## 六、快速开始

```powershell
pip install -r requirements.txt
python douyin_login.py --status     # 看登录态
python auto_dm_reply.py --dry       # 只看会回什么，不发
python auto_reply_comments.py --dry
```

详细操作（含验证码怎么过、cookies 怎么导出）见 [使用说明.md](使用说明.md)。

## 七、两份代码怎么同步（重要）

仓库里只有代码；**实际运行的那份**在你自己机器上（带 `assets/` 和抓下来的数据）。
改了仓库不同步，跑起来还是旧的。所以有一个单向同步脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\sync-room-pet.ps1            # 仓库 → 运行目录
powershell -ExecutionPolicy Bypass -File .\scripts\sync-room-pet.ps1 -DryRun    # 只看会改哪几个
powershell -ExecutionPolicy Bypass -File .\scripts\sync-room-pet.ps1 -To "<运行目录>"
```

- **只覆盖代码/文档**（`*.py *.js *.html *.css *.md *.txt *.bat *.ps1`），不碰素材与数据
- 不删除运行目录里多出来的文件（`settings.json`、`douyin/`、`assets/` 都安全）
- 用 SHA256 比对，只拷变化的文件；连跑两次第二次会显示「已是最新」

> 运行目录默认是本机 `tools/room-pet`（脚本里写的是占位默认值），用 `-To` 或环境变量 `ROOM_PET_RUNTIME` 指定最稳。
