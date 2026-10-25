# Fork 说明

本仓库是 **qq-bridge**（[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，MIT）的个人增强分支，
用于把 QQ（SnowLuma / OneBot v11）接到 **DeepSeek Harness（DSH）** 的 agent 上，让机器人能聊天、看图、发语音、点歌、斗图。

> 上游版权归原作者所有，本分支同样以 **MIT** 发布，保留原始 `LICENSE`。

## 这个分支加了什么

| 模块 | 说明 |
| --- | --- |
| **攻略模板** | `qq_guide action=template` 只给游戏名，就按统一模板从本地缓存渲染成合并转发卡片；支持**主题**（养成 / 副本 / 路线 / 装备 / 打法 / 兑换码），`/攻略 忍3 兑换码` 零 token 直出 |
| **点歌** | `/song 歌名[｜母带][｜整首]`，走网易云，支持 320k / 无损 / 母带，可发整首或截取 |
| **唱歌** | 歌词按字变调合成唱腔（`/sing`），也可以唱整首歌 |
| **说话** | edge-tts 现场合成语音条，带情绪（正常/雀跃/懒散/委屈/吐槽/温柔/着急） |
| **斗图** | 按情绪从收藏表情里挑，`sticker-pick` 返回候选再发 |
| **点赞** | `send_like`，群聊只允许点本群成员，不能点自己 |
| **发动态** | QQ 空间说说，仅管理员私聊可用，每日上限 5 条 |
| **@你 渲染** | 消息里 @ 机器人自己时渲染成 `@你`，避免模型把数字当成别人 |
| **常驻唤醒词** | `wake.alwaysKeywords` 命中即唤醒，模型改自己的触发词也绕不过 |
| **概率锁** | `wake.lockProbability` 开启后忽略模型自设的随机插话概率 |
| **私聊日限额** | 陌生私聊每天 N 条上限，超出只提示一次 |
| **临时会话兜底** | 非好友私聊发不出去时，自动改用共同群的临时会话送达 |
| **小程序卡片解析** | 卡片类消息尽量解析出标题/来源/链接，不再只剩一句「卡片消息」 |

## 配置

```bash
cp config.example.json config.json
# 然后填：ownerQQ、snowluma.httpUrl/accessToken、DSH 地址等
```

**本仓库不含任何真实账号、群号、令牌或 Cookie。** 文档与示例里的 `123456789` / `987654321` 都是占位符。

## 运行

```bash
npm install
npm start
```

需要同机运行 [SnowLuma](https://github.com/SnowLuma/SnowLuma)（QQ 网关）和 DeepSeek Harness。

## 目录

```
src/         桥接主程序（bridge.js 是入口）
roles/       人设文件（Markdown，可换成你自己的）
docs/        文档
scripts/     自检与测试脚本
plugins/     DSH 侧插件
dsh/         DSH 预设
```

## 致谢

- 上游 **qq-bridge** 作者 Derpyu520 与各位贡献者
- SnowLuma（QQ ↔ OneBot 网关）
- DeepSeek Harness
