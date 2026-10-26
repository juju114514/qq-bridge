/**
 * POST /api/session/reset 的回归测试（迁移前置安全网）。
 *
 * 这条路径要同时清掉 ~30 个 Map + state 四个字段，并 retire DSH 旧会话；
 * 漏一个不会报错，只会让会话幽灵化（唤醒变慢 / token 暴涨）。
 * 所以先钉住「清干净了没有」，再谈把代码搬走。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'private:123';   // closed-agent 模式只放行该会话（其它测试同款 fixture）
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}

const h = await bridgeHarness();
const server = h.startConsoleServer();
if (!server.listening) await new Promise((r) => server.once('listening', r));
const port = server.address().port;

function call(path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-console-token': 'fixture-console-token',
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { }
          resolve({ status: res.statusCode, body: data, json });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request hung')));
    req.end(payload);
  });
}

try {
  // ── 前置：造一个活会话 ────────────────────────────────────────────────
  h.setMode('closed-agent');
  const sessionId = await h.ensureSession(KEY);
  assert.ok(sessionId, '前置：ensureSession 应返回 sessionId');
  assert.equal(h.state.sessions[KEY], sessionId, '前置：state.sessions 应有该映射');

  // 再故意塞一些「只在这个 sessionId 上」的状态，验证 reset 会清掉
  h.collectors.set(sessionId, { fixture: true });
  h.v2TurnStartAt.set(sessionId, Date.now());
  h.turnLeaseNoted.add(sessionId);   // Set，不是 Map
  h.getSocialV2State(KEY); // 建会话级 v2 状态

  // ── 1. 正常重置 ───────────────────────────────────────────────────────
  const r1 = await call('/api/session/reset', { key: KEY });
  check('返回 200 且带 archived 字段', () => {
    assert.equal(r1.status, 200, `实际 ${r1.status}: ${r1.body}`);
    assert.equal(r1.json.ok, true);
    assert.equal(r1.json.archived, sessionId);
    assert.equal(r1.json.key, KEY);
  });

  check('state.sessions 映射已删除', () => {
    assert.equal(h.state.sessions[KEY], undefined);
  });

  check('state.sessionPolicies 权限元数据已删除', () => {
    assert.equal(h.state.sessionPolicies?.[KEY], undefined,
      '权限元数据残留会永久写进 sessions.json');
  });

  check('按 sessionId 记的 Map 都清掉了', () => {
    assert.equal(h.collectors.has(sessionId), false, 'collectors 残留');
    assert.equal(h.v2TurnStartAt.has(sessionId), false, 'v2TurnStartAt 残留');
    assert.equal(h.turnLeaseNoted.has(sessionId), false, 'turnLeaseNoted 残留');
  });

  check('会话级 v2 状态已删除', () => {
    const convs = h.socialV2?.conversations;
    if (convs) assert.equal(convs.has(KEY), false, 'socialV2.conversations 残留');
  });

  check('DSH 侧旧会话被 stop + archive', () => {
    assert.ok(h.calls.cancelled.includes(sessionId), 'stopSessionWork 未调用');
    assert.ok(h.calls.archived.includes(sessionId), 'archiveSession 未调用');
  });

  // ── 2. 幂等：同一 key 再重置应 404（不是 500）──────────────────────────
  const r2 = await call('/api/session/reset', { key: KEY });
  check('重复重置返回 404（会话已不存在）', () => {
    assert.equal(r2.status, 404, `实际 ${r2.status}: ${r2.body}`);
    assert.equal(r2.json.ok, false);
  });

  // ── 3. 缺 key / 空 key ───────────────────────────────────────────────
  for (const [label, body] of [
    ['缺 key', {}],
    ['空 key', { key: '' }],
    ['不存在的 key', { key: 'private:987654321' }],
  ]) {
    const r = await call('/api/session/reset', body);
    check(`${label} 返回 404 且不 500`, () => {
      assert.equal(r.status, 404, `实际 ${r.status}: ${r.body}`);
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
