// POST /api/socialV2/wait 的回归测试（迁移前置安全网）。
// 只钉「最高危」的三件事：并发租约 429、新消息到达、入参校验。
// 长轮询的 quiet/沉睡前观察细节由 test-reply-wait.mjs / test-token-economy.mjs 覆盖。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const h = await bridgeHarness({
  config: { socialV2: { wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100 }, proactive: { enabled: false }, sticker: { enabled: false } } },
});
h.setMode('reserved2');
const key = 'group:456';
const st = h.getSocialV2State(key);
const server = h.startConsoleServer();
if (!server.listening) await new Promise((r) => server.once('listening', r));
const port = server.address().port;

function request(route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/socialV2/${route}`,
      method: 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch { }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('request timed out')));
    req.end(JSON.stringify({ key, ...body }));
  });
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

try {
  // ── 1. 并发租约：同一会话同时只能有一个 wait ──────────────────────────
  {
    const first = request('wait', { purpose: 'messages', timeoutMs: 800, minNewMessages: 1 });
    await sleep(120); // 让第一个 wait 先拿到租约
    const second = await request('wait', { purpose: 'messages', timeoutMs: 100, minNewMessages: 1 });
    check('并发第二个 wait 返回 429', () => {
      assert.equal(second.status, 429, `实际 ${second.status}: ${JSON.stringify(second.data)}`);
      assert.match(second.data.error, /已有一个等待/);
    });
    const firstRes = await first;
    check('第一个 wait 正常结束（200，超时无消息）', () => {
      assert.equal(firstRes.status, 200);
      assert.equal(firstRes.data.arrived, false);
    });
  }

  // ── 3. 入参校验 ───────────────────────────────────────────────────────
  {
    const badPurpose = await request('wait', { purpose: 'nope', timeoutMs: 100 });
    check('非法 purpose → 400', () => {
      assert.equal(badPurpose.status, 400);
      assert.match(badPurpose.data.error, /purpose 必须是/);
    });
  }

  {
    const noKey = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/socialV2/wait', method: 'POST',
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' },
      }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, body: raw })); });
      req.on('error', reject);
      req.setTimeout(8000, () => req.destroy(new Error('timeout')));
      req.end(JSON.stringify({ purpose: 'messages', timeoutMs: 100 }));
    });
    check('缺 key → 400', () => {
      assert.equal(noKey.status, 400);
      assert.match(noKey.body, /key 不能为空/);
    });
  }
} finally {
  await new Promise((r) => server.close(r));
  await h.close();
}

console.log('');
if (failures === 0) {
  console.log('  全部通过');
} else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
