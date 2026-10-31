// 自测脚本：不依赖 SnowLuma / QQ，只验证 DSH 侧链路——
//   1. 连接 DSH Web API
//   2. 创建一个独立测试会话（不会碰现有会话）
//   3. 通过 events.mux 订阅事件流
//   4. session.prompt 注入一条消息
//   5. 等 agent 回复（turn/end）并打印
// 用法：node src/self-test.js [baseUrl]
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 自测会话的清理句柄（见 cleanupSelfTestSession）。
let selfTestApi = null;
let selfTestSessionId = null;

/**
 * 归档自测会话。本脚本刻意不指定 agentPreset —— 它必须在跑过 setup-dsh.mjs 之前
 * 也能用来诊断 DSH 链路；正因如此这个会话会带上 DSH 默认 preset（含 bash/文件工具），
 * 更不能留在用户的 DSH 里累积。
 */
async function cleanupSelfTestSession() {
  if (!selfTestApi || !selfTestSessionId) return;
  const sid = selfTestSessionId;
  selfTestSessionId = null;
  try {
    await selfTestApi.workspace.archiveSession({ sessionId: sid });
    console.log('🧹 已归档自测会话:', sid);
  } catch (error) {
    console.log('⚠️ 自测会话归档失败（可在 DSH 里手动删除）:', sid, error?.message ?? error);
  }
}

async function main() {
  // 优先级：命令行参数 → config.json 的 dsh.baseUrl → 旧默认 3080
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { cfg = null; }
  const baseUrl = process.argv[2] ?? cfg?.dsh?.baseUrl ?? 'http://127.0.0.1:3080';
  let auth;
  try {
    auth = {
      token: cfg?.dsh?.authToken || discoverDshLaunchToken(),
      header: cfg?.dsh?.authHeader,
      prefix: cfg?.dsh?.authPrefix
    };
  } catch { auth = undefined; }
  const api = new NodeApiClient(baseUrl, undefined, auth);
  selfTestApi = api;
  const promptText = process.argv[3] ?? '只回复两个字：收到';

  // 连不上时给出**可操作**的提示：`fetch failed` 本身什么都不说明（干净环境实测）。
  let desc;
  try {
    desc = unwrap(await api.settings.describe({}), 'settings.describe');
  } catch (error) {
    const msg = String(error?.message ?? error);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(msg)) {
      console.error(`❌ 连不上 DSH：${baseUrl}`);
      console.error('   可能是：① DSH 没在跑  ② 端口变了（DSH 每次启动可能换端口）');
      console.error('   排查：');
      console.error('     · 看 config.json 的 dsh.baseUrl 是不是当前端口（控制台 /api/status 里有）');
      console.error('     · 或直接指定：node src/self-test.js http://127.0.0.1:<端口>');
      console.error('     · 桥接在跑的话，它启动时会自动探测并写回正确端口');
      await cleanupSelfTestSession();
      process.exit(1);
    }
    if (/401|unauthorized|forbidden/i.test(msg)) {
      console.error(`❌ DSH 拒绝鉴权（${baseUrl}）：${msg}`);
      console.error('   DSH 需要 launch token：确认 config.json 的 dsh.authToken，或先跑 node scripts/setup-dsh.mjs');
      await cleanupSelfTestSession();
      process.exit(1);
    }
    throw error;
  }
  console.log('✅ DSH 连接成功:', JSON.stringify(desc).slice(0, 200));

  // 独立测试会话，cwd 用**系统临时目录**（不是仓库的 state/）：
  // state/ 被 scripts/harden-state-acl.mjs 收紧了 ACL（去掉继承 ACE，只留当前用户 /
  // SYSTEM / Administrators），DSH 沙箱的能力 SID 不在 ACL 里 ⇒ 在沙箱内跑自检
  // 会直接 EPERM 建目录。自检是一次性探针，产物本来也不该落进仓库状态目录。
  const cwd = path.join(os.tmpdir(), 'qq-bridge-self-test');
  fs.mkdirSync(cwd, { recursive: true });
  const created = unwrap(await api.sessions.create({ cwd }), 'session.create');
  const sessionId = created.sessionId;
  selfTestSessionId = sessionId;
  console.log('✅ 测试会话已创建:', sessionId);

  // 先订阅事件流（在 prompt 之前），再注入消息。
  // 必须等 WebSocket 真正 open 后再 prompt，否则 turn 事件可能在连接建立前产生而被漏掉。
  const collector = createTurnCollector();
  let resolveOpened;
  let openTimer;
  const opened = new Promise((resolve, reject) => {
    openTimer = setTimeout(() => reject(new Error('等待 WebSocket open 超时（10s）')), 10_000);
    resolveOpened = () => { clearTimeout(openTimer); resolve(); };
  });
  const stream = api.events.mux({}, undefined, () => resolveOpened());
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待回复超时（60s）')), 60_000);
    (async () => {
      for await (const envelope of stream) {
        const frame = envelope.payload;
        if (frame.type === 'session/event' && frame.sessionId === sessionId) {
          const ended = collector.push(frame.event);
          if (ended) {
            clearTimeout(timer);
            resolve(ended);
            return;
          }
        }
        if (frame.type === 'stream/error') {
          clearTimeout(timer);
          reject(new Error('事件流错误: ' + JSON.stringify(frame.error)));
          return;
        }
      }
    })().catch((error) => { clearTimeout(timer); reject(error); });
  });
  await opened;
  // 新版 DSH 需要显式 follow 该会话，事件才会通过 remote.mux 推过来。
  stream.follow(sessionId);

  const accepted = unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] }), 'session.prompt');
  console.log('✅ prompt 已接受:', JSON.stringify(accepted));

  const ended = await done;
  console.log('✅ 回合结束 reason =', ended.reason.kind);
  console.log('🤖 agent 回复:');
  console.log(ended.text || '（无文本）');
  await cleanupSelfTestSession();
  console.log('🎉 自测通过 —— DSH 侧链路可用');
  process.exit(0);
}

main().catch(async (error) => {
  console.error('❌ 自测失败:', error?.message ?? error);
  await cleanupSelfTestSession();
  process.exit(1);
});
