// sidecar 契约（N2）的离线测试：4 个端点 + 落盘 IO。
// 用假 req/res/fs，不碰真实 state。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const api = await import(pathToFileURL(path.join(root, 'src', 'api', 'plugin-bridge.js')).href);
const ioMod = await import(pathToFileURL(path.join(root, 'src', 'domains', 'plugin-sidecar-io.js')).href);

const results = [];
const check = (n, f) => { try { f(); results.push(['ok', n]); } catch (e) { results.push(['FAIL', n + ' — ' + (e?.message ?? e)]); } };
const checkAsync = async (n, f) => { try { await f(); results.push(['ok', n]); } catch (e) { results.push(['FAIL', n + ' — ' + (e?.message ?? e)]); } };

const TOKEN = 'test-plugin-token-0123456789';
function harness(extra = {}) {
  const calls = [];
  const sendJson = (obj, status = 200, headers) => calls.push({ obj, status, headers });
  const handler = api.createPluginBridgeHandler({
    sendJson,
    readBody: async () => (extra.body ?? {}),
    pluginToken: TOKEN,
    version: '9.9.9',
    startedAt: Date.now() - 1000,
    mode: 'bridge',
    getSocialV2State: () => ({ wakeConfig: { sleepMs: 60000 }, recent: [{ text: 'hi' }] }),
    readRoleState: () => ({ role: 'xiaojingyu' }),
    roleHint: () => '你是小鲸鱼',
    peopleSummary: (key) => ({ key, level: 2 }),
    readMemory: (key) => `## §〇 交接\n\n### 上次聊到哪\n${key}\n`,
    writeMemory: () => {},
    appendEvent: (e) => calls.push({ event: e }),
    applyIntent: extra.applyIntent ?? (async (i) => ({ applied: 1, echo: i.intent })),
    ...extra.deps,
  });
  return { handler, calls };
}
const req = (method, headers = {}) => ({ method, headers });
const url = (p) => new URL('http://127.0.0.1:3100' + p);
const AUTH = { authorization: 'Bearer ' + TOKEN };

await checkAsync('/health 不需要认证，返回 mode/version/uptime', async () => {
  const { handler, calls } = harness();
  const handled = await handler(req('GET'), url('/health'));
  assert.equal(handled, true);
  assert.equal(calls[0].status, 200);
  assert.equal(calls[0].obj.mode, 'bridge');
  assert.equal(calls[0].obj.version, '9.9.9');
  assert.ok(calls[0].obj.uptimeMs >= 0);
});

await checkAsync('/snapshot 无 token → 401', async () => {
  const { handler, calls } = harness();
  await handler(req('GET'), url('/snapshot?key=group:1'));
  assert.equal(calls[0].status, 401);
});

await checkAsync('/snapshot 带 token → 200 + ETag + 快照内容', async () => {
  const { handler, calls } = harness();
  await handler(req('GET', AUTH), url('/snapshot?key=group:1'));
  const r = calls[0];
  assert.equal(r.status, 200);
  assert.ok(r.headers?.ETag);
  assert.equal(r.obj.state.key, 'group:1');
  assert.equal(r.obj.state.role.name, 'xiaojingyu');
  assert.match(r.obj.state.memory.text, /交接/);
});

await checkAsync('/snapshot 带 If-None-Match → 304', async () => {
  const { handler, calls } = harness();
  await handler(req('GET', AUTH), url('/snapshot?key=group:1'));
  const etag = calls[0].headers.ETag;
  await handler(req('GET', { ...AUTH, 'if-none-match': etag }), url('/snapshot?key=group:1'));
  assert.equal(calls[1].status, 304);
});

await checkAsync('/snapshot 缺 key → 400', async () => {
  const { handler, calls } = harness();
  await handler(req('GET', AUTH), url('/snapshot'));
  assert.equal(calls[0].status, 400);
});

await checkAsync('/events 需要 token，写入后返回 202', async () => {
  const { handler, calls } = harness({ body: { key: 'group:1', kind: 'inbound' } });
  await handler(req('POST', AUTH), url('/events'));
  const resp = calls.find((c) => c.status !== undefined);
  const evt = calls.find((c) => c.event !== undefined);
  assert.equal(resp.status, 202);
  assert.equal(resp.obj.ok, true);
  assert.equal(evt.event.kind, 'inbound');
});

await checkAsync('/intents 缺 key/intent → 400', async () => {
  const { handler, calls } = harness({ body: { key: 'group:1' } });
  await handler(req('POST', AUTH), url('/intents'));
  assert.equal(calls[0].status, 400);
});

await checkAsync('/intents 正常 → 202 并把意图转给 applyIntent', async () => {
  const { handler, calls } = harness({ body: { key: 'group:1', intent: 'memory.handoff', payload: { nextStep: '问问吃饭没' } } });
  await handler(req('POST', AUTH), url('/intents'));
  assert.equal(calls[0].status, 202);
  assert.equal(calls[0].obj.applied, 1);
});

await checkAsync('/intents applyIntent 抛错 → 500 且不把堆栈漏给调用方', async () => {
  const { handler, calls } = harness({
    body: { key: 'group:1', intent: 'boom' },
    applyIntent: async () => { throw new Error('EACCES'); },
  });
  await handler(req('POST', AUTH), url('/intents'));
  assert.equal(calls[0].status, 500);
  assert.match(calls[0].obj.error, /EACCES/);
});

check('未知路径返回 false（让后面的路由继续）', async () => {
  const { handler } = harness();
  return handler(req('GET'), url('/api/status')).then((h) => assert.equal(h, false));
});

// ── 落盘 IO ────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-io-'));
const io = ioMod.createSidecarIo({ fs, path, stateDir: tmp });

check('writeMemory/readMemory 往返；文件名把 : 保留成安全字符', () => {
  io.writeMemory('group:123', '## §〇 交接\nX\n');
  assert.match(io.readMemory('group:123'), /X/);
  assert.ok(ioMod.memoryFileName('group:123').endsWith('.md'));
  assert.doesNotMatch(ioMod.memoryFileName('group:123'), /[\\/:*?"<>|]/);
});

await checkAsync('intent memory.handoff 写入交接段并可 check', async () => {
  const r = await io.applyIntent({ key: 'group:9', intent: 'memory.handoff', payload: { lastTalkedAbout: '聊了歌单' } });
  assert.equal(r.applied, 1);
  assert.equal(r.check.ok, true);
  assert.match(io.readMemory('group:9'), /聊了歌单/);
});

await checkAsync('intent memory.append 追加一行', async () => {
  const r = await io.applyIntent({ key: 'group:9', intent: 'memory.append', payload: { text: '新印象：爱听周杰伦' } });
  assert.equal(r.applied, 1);
  assert.match(io.readMemory('group:9'), /爱听周杰伦/);
});

check('appendEvent 落 JSONL（每行一个 JSON）', () => {
  io.appendEvent({ key: 'group:1', kind: 'test' });
  const lines = fs.readFileSync(io.eventFile, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.kind, 'test');
  assert.ok(last.at);
});

await checkAsync('未知意图 → applied:0，不抛错', async () => {
  const r = await io.applyIntent({ key: 'group:1', intent: 'nope' });
  assert.equal(r.applied, 0);
});

const failed = results.filter(([s]) => s !== 'ok');
for (const [s, n] of results) console.log(`  ${s === 'ok' ? 'ok  ' : 'FAIL'} ${n}`);
console.log(`\n结果：${results.length - failed.length} 通过，${failed.length} 失败`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed.length ? 1 : 0);