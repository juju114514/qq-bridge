// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  // DSH 会话队列（inbox 投影）解析：0.2.0 把队列从 control baseline 的
  // `value.queues[<id>]` 挪进了 `value.projections[<id>].values.inbox`。
  // 认错形状的后果不是"少清几条"，而是**每一次退役会话都抛错**、旧任务继续跑，
  // 且只留下一行日志 —— 必须有登记期断言钉住（活 DSH 侧的实测见
  // scripts/test-dsh-session-retire.mjs）。
  'test-dsh-inbox-projection.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-mux-reconnect.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  'test-reply-wait.mjs', 'test-preset-prompt.mjs', 'test-role-card.mjs',
  // 体检修复回归：无令牌智能体调用面、send-burst 失败回滚、唤醒限频重试、
  // 定时器类暂存唤醒补发、collector 生命周期、ownerQQ 覆盖语义、预设名校验、
  // wake triggers 白名单、memory-update 边界、wait 租约归一化、md/黑话/表情/账本；
  // 本轮新增：/api/send/* 失败路径的作用域错误（R15）、reserved2 落库丢表情识别字段（R16）。
  'test-audit-regressions.mjs',
  // 图片/表情链路（动图/表情包字段、CDN 优先与 emoji_id 兜底）+ 联网搜索
  // （DSH 同一路 DeepSeek 搜索、Bing RSS 兜底、凭据优先级与端点安全；
  //  本轮新增：空结果 note 必须在写缓存之前生成，否则缓存命中丢掉提示）。
  'test-media-search.mjs',
  // GitHub issue 回归：#22 模式 user 层优先 / #11/#19 回合判忙租约 / #29 机器人身份注入。
  'test-issue-regressions.mjs',
  // 二代「会话初始提示词」：只在首次唤醒注入、管理面隔离、损坏文件只读降级、
  // 以及控制台「立即唤醒」不得顶掉首次 bootstrap（否则初始提示词永远发不出去）。
  'test-v2-initial-prompt.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 语音发送（纯函数 + 端点存在性；真发语音只在 --live 或 CLI 里做）
  'test-voice.mjs',
  // 音量：参数校验 + 真的调用 ffmpeg 调音量 + 自算 RMS 验证增益
  'test-voice-volume.mjs',
  // 边界：并发/异常输入/上传限额/越权（纯函数段 + 可选的 live 段）
  'test-voice-edge.mjs',
  // 语音图形界面（参数解析/鉴权/路径穿越/文件名净化；live 段需普通终端）
  'test-voice-gui.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'test-console-static.mjs',
  // 语音系统整体结构检查（入口/依赖/端点/开关/文档一致性）
  'test-voice-system.mjs',
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'test-snowluma-conn.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  'test-encoding.mjs',
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'test-console-encoding.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 QSH_PLAN.md §0.1/§5.2），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'test-preset-local-tools.mjs',
  // qq-mode-console 的 settings 契约：0.2.0 删除了 ctx.settings.register()，
  // 命名空间改为由 loader entry id + 导出的 Config 推导。断言三点前提都在，
  // 并且那条已删除的 API 不会被照旧注释加回来。
  'test-qq-mode-plugin.mjs',
  // SnowLuma 上游健康（被误诊成「qq-bridge 注入失败」的那个失败形态）：
  //   · good 必须取自心跳 status.good / get_status —— 取自 get_login_info 会**静默失效**
  //     （SDK 不校验 data 载荷，good 会永远停在 null，整条权威信号变成死分支）；
  //   · 静默检测不得冒充 hook 检测（心跳是 SnowLuma 本地定时器无条件发的）；
  //   · 客户端库版本不得低于 bot_status 出现的版本。
  'test-snowluma-upstream-health.mjs',
  // Linux 部署脚本（deploy/*.sh）：这里钉的不是语法，而是**装完能不能跑**——
  //   降权到 qqbridge 之后仍必须能读 DSH 的本机签名密钥（$DSH_HOME/.credentials.yaml），
  //   unit 必须带 DSH_HOME，npm 必须用 `sudo -H -u`（否则缓存写 /root → EACCES）。
  //   这类问题只在服务器上暴露，所以放进 CI 而不是留给用户踩。
  'test-deploy-scripts.mjs',
  // 打包形态（外部 review 提的两条，实测都成立，且都属「不会让代码测试变红、
  // 但直接影响别人敢不敢用」的那类）：
  //   · 锁文件只能有一个 —— 同时留 package-lock.json 与 pnpm-lock.yaml，
  //     用不同包管理器的人会各自改各自的，依赖树迟早漂移；
  //   · LICENSE 只放协议正文 —— 附录（第三方组件/数据出机清单）塞在同一文件里会让
  //     GitHub 的 licensee 匹配失败，仓库页面显示 Other/NOASSERTION。附录现在在 NOTICE.md。
  'test-packaging.mjs',
  // OneBot WS 客户端（自带实现，替代 @snowluma/sdk）：
  //   echo 配对 / 事件分发 / call() 抛错 / 超时 / 断线重连 / 主动关闭不重连 ——
  //   这些坏了的表现是「机器人突然不说话、发错人、断线不自愈」，业务测试全绿也发现不了。
  'test-onebot-ws.mjs',
  // 换机器可移植性：「换台机器就废」的假设（硬编码盘符 / 只剩 Windows 才有的可执行 /
  //   示例配置混进本机值 / DPAPI 备份跨机不可解密 / 迁移清单缺失）。
  //   这类问题不会让任何功能测试变红，只会在用户换机那天一次性爆出来。
  'test-portability.mjs',
  // 兼容契约的「文档 ↔ 代码」一致性：COMPAT.md / compat.json 里声明的 OneBot 动作、
  //   平台能力、已移除的依赖，必须与代码真实情况一致（别人照着文档适配，写错就是坑）。
  'test-compat.mjs',
  // 角色卡 id 化：身份存在文件里（front matter），文件名随便改 —— 绑定不再随改名/搬机器失效。
  //   覆盖 front matter 解析、id 与文件名解耦、老卡片确定性 id、注入路径剥离元数据。
  'test-role-id.mjs',
  // HTTP 层（src/http/*）：响应头 / 请求体限额 / 前导关的每条拒绝 / 路由表分派。
  //   这一层坏了的症状不是报错，而是「某个 403 悄悄消失」——只能靠断言钉住。
  'test-http-layer.mjs',
  // 启动器与守护：设计不变量 L6（不代启 SnowLuma）、退出码契约、单实例/停止信号/
  //   退避重启/ExitCode 归一化、.ps1 必须带 BOM、文档与入口互链。
  'test-launcher-scripts.mjs',
  // 首次运行引导 first-run.ps1：不覆盖 config.json、不代启 SnowLuma、DryRun 行为。
  'test-first-run.mjs',
  // 「会话繁忙」静默失效面：诊断脚本 / status 快照 / 10+30 分钟两道租约 / 文档锚点。
  'test-session-busy.mjs',
  // 长图切片：长宽比 ≥2.4 走 slice（每片短边 1000、有重叠、片数≤6），普通图仍走 shrink。
  'test-long-image.mjs',
  // 长图 OCR：空格归一律、降级不抛异常、bridge/api/MCP 三处接线。
  'test-ocr.mjs',
  // 视频理解：故事板布局 / ffprobe 探元数据 / 真抽帧 / ASR 降级 / 接线契约。
  'test-video-frames.mjs',
  // 视频链接识别：B站/抖音白名单 + 只下前 N 秒 + 接线。
  'test-video-link.mjs',
  // 抖音专用解析器：取 id / cookie 域名过滤 / 去水印 / 分享页解析 / 接线。
  'test-video-resolve.mjs',
  // DSH 端口自动发现：平台闸门 / HTTP 探活 / 候选顺序 / 自愈接线。
  'test-dsh-port.mjs',
  // 排队消息落盘/恢复：序列化、剪枝、坏文件降级、接线。
  'test-pending-queue.mjs',
  // QQ 官方机器人客户端：文本清洗 / 事件翻译 / msg_seq 上限 / 路由。
  'test-official-client.mjs',
  // 官方通道适配层：ID 前缀隔离 / 事件合成 / 消息段降级 / 白名单 / 发送路由。
  'test-official-transport.mjs',
  // 长期记忆：衰减/强化/打分/预算/合并/容量/归档/迁移。
  'test-memory-store.mjs',
  // 会话 key 解析：官方 openid 与数字 QQ 号共存（发送工具的总闸）。
  'test-conv-key.mjs',
  // 官方主动消息：cron / 配额 / 权限降级 / 接线。
  'test-official-proactive.mjs',
  // 死信：被丢弃的消息要能查回来（append/轮转/坏行/分组统计/接线）。
  'test-dead-letter.mjs',
  // 实例互斥：同一 bot 只允许一个进程连 gateway（宿主机 + 容器共存）。
  'test-instance-lock.mjs',
  // 外部触发入口：鉴权/白名单/限流/prompt|say。
  'test-inject.mjs',
  // B 站增强：bvid 提取/字幕/热评/拼装/降级接线。
  'test-bili-enrich.mjs',
  // 装机体检：四个卡点的诊断与修法（离线）。
  'test-doctor.mjs',
  // 表情策展：含义识别 / 收藏判定 / 主动发送配额（离线）。
  'test-sticker-curator.mjs',
  // 表情笔记：独立存储 / 状态机 / 上限 / 默认不进提示词。
  'test-sticker-notes.mjs',
  // 表情提示词限幅 + /curate 客户端 fail-open。
  'test-sticker-hint.mjs',
  // 待判表情队列：scope 隔离 / FIFO / 提示渲染。
  'test-sticker-pending.mjs',
  // 私聊准入：好友放行 / 临时会话拒 / 默认关。
  'test-private-access.mjs',
  // 网关自动选择：默认 SnowLuma、连续失败降级、回滞。
  'test-gateway-select.mjs',
  // 官方通道富媒体：两步上传的请求构造与闸门（离线）。
  'test-official-media.mjs',
  // 官方通道：被动窗口判定 + 发图接线（离线）。
  'test-official-send-image.mjs',
  // 静默时段：跨零点 / 边界 / 时区可注入（离线）。
  'test-quiet-hours.mjs',
  // 人物库：身份只认 QQ 号 / 关系升档 / 作用域笔记 / 真删除。
  'test-people.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
