// DSH 契约测试：验证我们**依赖的那几个接口**还长什么样。
//
// 由来（2026-10-31）：一天 11 个 bug 里 4 个是「DSH 静默升级 / 我们猜错 API」，
// 而 DSH 没有公开契约文档。所以把它变成可执行的断言：
//   settings.describe / sessions.create / sessions.prompt / events.mux / archiveSession
//
// 设计取舍：
//   · 连不上 DSH 就**跳过并 exit 0**（CI 里没有 DSH，不能因此变红）
//   · 会创建一个临时会话并在结束时归档（与 src/self-test.js 同策略）
//   · 不挂进 test-audit，单独跑：node scripts/test-dsh-contracts.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } = await import(
  new URL('../src/dsh-client.js', import.meta.url).href
);

let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); } catch { cfg = null; }
const baseUrl = process.argv[2] ?? cfg?.dsh?.baseUrl ?? 'http://127.0.0.1:3080';
const auth = {
  token: cfg?.dsh?.authToken || discoverDshLaunchToken(),
  header: cfg?.dsh?.authHeader,
  prefix: cfg?.dsh?.authPrefix,
};

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const api = new NodeApiClient(baseUrl, undefined, auth);

// ── 0) 可达性：不可达就跳过（不是失败）─────────────────────────────
let reachable = false;
try {
  const res = await fetch(`${baseUrl}/`, { method: 'GET' });
  reachable = res.status > 0;
} catch { reachable = false; }
if (!reachable) {
  console.log(`  ⏭  跳过：连不上 DSH（${baseUrl}）—— CI 环境正常现象`);
  console.log('\n结果：跳过');
  process.exit(0);
}

// ── 1) settings.describe ─────────────────────────────────────────
let sessionId = null;
await check('settings.describe 返回可解析对象（契约：settings 命名空间存在）', async () => {
  const desc = unwrap(await api.settings.describe({}), 'settings.describe');
  assert.equal(typeof desc, 'object');
  assert.ok('namespaces' in desc || 'writable' in desc, `形状变了：${Object.keys(desc).join(',')}`);
});

// ── 2) sessions.create ───────────────────────────────────────────
await check('sessions.create 接受 cwd 并返回 sessionId', async () => {
  const cwd = path.join(os.tmpdir(), 'qq-bridge-contract');
  fs.mkdirSync(cwd, { recursive: true });
  const created = unwrap(await api.sessions.create({ cwd }), 'sessions.create');
  sessionId = created?.sessionId;
  assert.ok(sessionId, '没有 sessionId');
});

// ── 3) events.mux + session.prompt ───────────────────────────────
await check('events.mux 可订阅 + session.prompt 被接受 + 回合能结束', async () => {
  assert.ok(sessionId, '前置失败：没有会话');
  const collector = createTurnCollector();
  const stream = api.events.mux({});
  const opened = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WebSocket open 超时（8s）')), 8000);
    stream.onOpen?.(() => { clearTimeout(t); resolve(); });
    // 兼容：部分版本没有 onOpen 回调，退化成 500ms 后当作已打开
    setTimeout(() => { clearTimeout(t); resolve(); }, 500);
  });
  const done = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待回复超时（40s）')), 40000);
    (async () => {
      for await (const env of stream) {
        const frame = env.payload;
        if (frame.type === 'session/event' && frame.sessionId === sessionId) {
          const ended = collector.push(frame.event);
          if (ended) { clearTimeout(t); resolve(ended); return; }
        }
        if (frame.type === 'stream/error') { clearTimeout(t); reject(new Error(JSON.stringify(frame.error))); return; }
      }
    })().catch((e) => { clearTimeout(t); reject(e); });
  });
  await opened;
  stream.follow(sessionId);
  unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '只回复两个字：收到' }] }), 'sessions.prompt');
  const ended = await done;
  assert.equal(ended.reason?.kind, 'completed', `回合没正常结束：${ended.reason?.kind}`);
  assert.match(String(ended.text ?? ''), /收到/, '回复内容不符');
});

// ── 4) archiveSession ────────────────────────────────────────────
await check('workspace.archiveSession 能归档临时会话', async () => {
  if (!sessionId) return; // 前面失败就跳过
  await api.workspace.archiveSession({ sessionId });
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}（${baseUrl}）`);
process.exit(failures ? 1 : 0);
