// HTTP 层（src/http/*）单测：响应 / 请求体 / 前导关 / 路由表。
//
// 为什么要这么细：这一层是**安全边界**（控制台令牌、Host 头、CSRF、智能体权限、
// 只读降级）。它坏了的症状不是报错，而是「某个 403 悄悄消失」或「某个 401 变成 200」——
// 功能测试全绿也发现不了。所以每条拒绝都单独钉一条断言。
//
// 不连网、不起服务：req 用 Readable 伪造，res 用记录型桩。

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { SECURITY_HEADERS, applyDenial, writeEmpty, writeHtml, writeJson } from '../src/http/response.js';
import { readJsonBody } from '../src/http/body.js';
import {
  ADMIN_ONLY_V2_PATHS, agentAllowed, allowedHosts, constantTimeEqual, runPrelude, tokenlessAgentAllowed,
} from '../src/http/prelude.js';
import { createRouter } from '../src/http/router.js';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

// ── 桩 ────────────────────────────────────────────────────────────────────
function fakeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(code, headers) { res.statusCode = code; res.headers = headers ?? {}; },
    end(chunk) { if (chunk !== undefined) res.body += String(chunk); },
  };
  return res;
}
function fakeReq({ method = 'GET', headers = {}, body = null, host = '127.0.0.1:3100' } = {}) {
  const req = Readable.from(body === null ? [] : [Buffer.from(body)]);
  req.method = method;
  req.headers = { host, ...headers };
  if (body !== null && req.headers['content-length'] === undefined) {
    req.headers['content-length'] = String(Buffer.byteLength(body));
  }
  return req;
}
const url = (p) => new URL(p, 'http://127.0.0.1:3100');

/** 跑一次 prelude，返回判定结果（null=放行）。 */
function prelude({ path = '/api/status', method = 'GET', headers = {}, host = '127.0.0.1:3100', over = {} } = {}) {
  return runPrelude({
    req: fakeReq({ method, headers, host }),
    url: url(path),
    boundPort: 3100,
    consoleToken: 'tok',
    crypto,
    isLiveAgentToken: (t) => t === 'live-agent',
    isSocialV2Paused: () => over.paused ?? false,
    isSocialV2Disabled: () => over.disabled ?? false,
    getMode: () => over.mode ?? 'reserved2',
    slangStoreWritable: over.slangWritable ?? true,
    stickerStoreWritable: over.stickerWritable ?? true,
  });
}
const TOKEN = { 'x-console-token': 'tok' };

// ── 1. 响应 ───────────────────────────────────────────────────────────────
await check('writeJson 带硬化头 + 2 空格缩进', () => {
  const res = fakeRes();
  writeJson(res, { ok: true }, 201);
  assert.equal(res.statusCode, 201);
  assert.match(res.headers['content-type'], /application\/json/);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers[k], v, `缺 ${k}`);
  assert.equal(res.body, JSON.stringify({ ok: true }, null, 2));
});

await check('writeEmpty 是 204 且不带 content-type', () => {
  const res = fakeRes();
  writeEmpty(res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['content-type'], undefined);
});

await check('writeHtml 带 text/html', () => {
  const res = fakeRes();
  writeHtml(res, '<h1>x</h1>', 401);
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal(res.headers['X-Frame-Options'], 'DENY');
});

await check('applyDenial 三种形态都能落响应', () => {
  const a = fakeRes(); applyDenial(a, { status: 403, json: { ok: false, error: 'x' } });
  assert.equal(a.statusCode, 403);
  const b = fakeRes(); applyDenial(b, { status: 401, html: 'need-token' });
  assert.equal(b.statusCode, 401); assert.equal(b.body, 'need-token');
  const c = fakeRes(); applyDenial(c, { status: 204, empty: true });
  assert.equal(c.statusCode, 204);
  const d = fakeRes(); applyDenial(d, null);
  assert.equal(d.statusCode, null, 'null 不该写响应');
});

// ── 2. 请求体 ─────────────────────────────────────────────────────────────
await check('空 body 解析成 {}（历史行为）', async () => {
  assert.deepEqual(await readJsonBody(fakeReq({ method: 'POST' })), {});
});

await check('对象 body 正常解析', async () => {
  const v = await readJsonBody(fakeReq({ method: 'POST', body: '{"a":1}' }));
  assert.deepEqual(v, { a: 1 });
});

await check('非法 JSON → 400「请求体必须是合法 JSON」', async () => {
  await assert.rejects(readJsonBody(fakeReq({ method: 'POST', body: 'not-json' })), (e) => {
    assert.equal(e.statusCode, 400);
    assert.match(e.message, /合法 JSON/);
    return true;
  });
});

await check('数组 body → 400「请求体必须是 JSON 对象」', async () => {
  await assert.rejects(readJsonBody(fakeReq({ method: 'POST', body: '[1,2]' })), (e) => {
    assert.equal(e.statusCode, 400);
    assert.match(e.message, /JSON 对象/);
    return true;
  });
});

await check('Content-Length 超限 → 413（不等数据流）', async () => {
  const req = fakeReq({ method: 'POST', body: '{}' });
  req.headers['content-length'] = String(2_000_000);
  await assert.rejects(readJsonBody(req), (e) => {
    assert.equal(e.statusCode, 413);
    assert.match(e.message, /请求体过大/);
    return true;
  });
});

await check('流式超限 → 413', async () => {
  const req = fakeReq({ method: 'POST', body: 'x'.repeat(64) });
  delete req.headers['content-length'];
  await assert.rejects(readJsonBody(req, { maxBytes: 16 }), (e) => {
    assert.equal(e.statusCode, 413);
    return true;
  });
});

await check('读取超时 → 400「请求体读取超时」', async () => {
  const req = new Readable({ read() {} }); // 永不 end
  req.method = 'POST';
  req.headers = { host: '127.0.0.1:3100' };
  await assert.rejects(readJsonBody(req, { timeoutMs: 30 }), (e) => {
    assert.equal(e.statusCode, 400);
    assert.match(e.message, /超时/);
    return true;
  });
});

// ── 3. 前导关 ─────────────────────────────────────────────────────────────
await check('favicon → 204（不走鉴权）', () => {
  assert.deepEqual(prelude({ path: '/favicon.ico' }), { status: 204, empty: true });
  assert.deepEqual(prelude({ path: '/apple-touch-icon.png' }), { status: 204, empty: true });
});

await check('Host 头不在白名单 → 403（DNS rebinding）', () => {
  const d = prelude({ headers: TOKEN, host: 'evil.example.com:3100' });
  assert.equal(d.status, 403);
  assert.match(d.json.error, /Host 头不被允许/);
  // 合法 Host 三种
  for (const host of allowedHosts(3100)) assert.equal(prelude({ headers: TOKEN, host }), null, `${host} 应放行`);
});

await check('缺控制台令牌 → 401；GET / 给 HTML，其余给 JSON', () => {
  const a = prelude({ path: '/' });
  assert.equal(a.status, 401);
  assert.match(a.html, /需要令牌/);
  const b = prelude({ path: '/api/status' });
  assert.equal(b.status, 401);
  assert.match(b.json.error, /未授权/);
});

await check('令牌支持 ?token= 与 x-console-token，且只认完全一致', () => {
  assert.equal(prelude({ path: '/api/status', headers: TOKEN }), null);
  assert.equal(prelude({ path: '/api/status?token=tok' }), null);
  assert.equal(prelude({ path: '/api/status', headers: { 'x-console-token': 'to' } }).status, 401);
  assert.equal(prelude({ path: '/api/status', headers: { 'x-console-token': 'toK' } }).status, 401);
});

await check('constantTimeEqual：长度不同/空值都返回 false', () => {
  assert.equal(constantTimeEqual(crypto, 'abc', 'abc'), true);
  assert.equal(constantTimeEqual(crypto, 'abc', 'ab'), false);
  assert.equal(constantTimeEqual(crypto, '', 'abc'), false);
  assert.equal(constantTimeEqual(crypto, 'abc', ''), false);
});

await check('智能体调用：无效令牌 403，无令牌只放行三个面', () => {
  const bad = prelude({ path: '/api/status', headers: { ...TOKEN, 'x-agent-call': '1', 'x-agent-token': 'nope' } });
  assert.equal(bad.status, 403);
  assert.match(bad.json.error, /会话令牌无效/);

  for (const p of ['/api/status', '/api/send/x', '/api/images/x']) {
    assert.equal(
      prelude({ path: p, headers: { ...TOKEN, 'x-agent-call': '1' } }), null,
      `${p} 无令牌应放行`,
    );
    assert.equal(tokenlessAgentAllowed(p), true);
  }
  const blocked = prelude({ path: '/api/roles', headers: { ...TOKEN, 'x-agent-call': '1' } });
  assert.equal(blocked.status, 403);
  assert.match(blocked.json.error, /必须携带有效的会话令牌/);

  // 带有效令牌
  assert.equal(prelude({ path: '/api/status', headers: { ...TOKEN, 'x-agent-call': '1', 'x-agent-token': 'live-agent' } }), null);
});

await check('CSRF：写操作必须 JSON，跨站 Origin 403', () => {
  const a = prelude({ path: '/api/role', method: 'POST', headers: TOKEN });
  assert.equal(a.status, 415);
  assert.match(a.json.error, /application\/json/);

  const b = prelude({
    path: '/api/role',
    method: 'POST',
    headers: { ...TOKEN, 'content-type': 'application/json', origin: 'http://evil.com' },
  });
  assert.equal(b.status, 403);
  assert.match(b.json.error, /跨站请求/);

  const c = prelude({
    path: '/api/role',
    method: 'POST',
    headers: { ...TOKEN, 'content-type': 'application/json', origin: 'http://127.0.0.1:3100' },
  });
  assert.equal(c, null, '同源写请求应放行');
});

await check('空 agent token → 403（不能退化成无令牌）', () => {
  const d = prelude({ path: '/api/status', headers: { ...TOKEN, 'x-agent-token': '' } });
  assert.equal(d.status, 403);
  assert.match(d.json.error, /不能为空/);
});

await check('暂停/关停/模式/管理端/表情库 对智能体调用分别拦住', () => {
  const agent = { ...TOKEN, 'x-agent-token': 'live-agent' };
  assert.equal(prelude({ path: '/api/socialV2/send', headers: agent, over: { paused: true } }).status, 403);
  assert.match(prelude({ path: '/api/socialV2/send', headers: agent, over: { paused: true } }).json.error, /已暂停/);

  assert.equal(prelude({ path: '/api/socialV2/send', headers: agent, over: { disabled: true } }).status, 403);
  assert.equal(prelude({ path: '/api/socialV2/send', headers: agent, over: { mode: 'reserved' } }).status, 403);
  assert.match(prelude({ path: '/api/socialV2/send', headers: agent, over: { mode: 'reserved' } }).json.error, /仅 reserved2/);

  for (const p of ADMIN_ONLY_V2_PATHS) {
    const d = prelude({ path: p, headers: agent });
    assert.equal(d.status, 403, `${p} 应仅控制台可用`);
  }
  assert.equal(prelude({ path: '/api/stickers/sync', headers: agent }).status, 403);
  assert.equal(prelude({ path: '/api/roles', headers: agent }).status, 403);
  // 白名单内放行
  for (const p of ['/api/status', '/api/socialV2/send', '/api/send/group', '/api/images/x', '/api/authorize/read']) {
    assert.equal(agentAllowed(p), true, `${p} 应在白名单`);
    assert.equal(prelude({ path: p, headers: agent }), null, `${p} 应放行`);
  }
});

await check('只读降级：黑话库/表情库写接口 → 503', () => {
  const a = prelude({ path: '/api/slang', method: 'POST', headers: { ...TOKEN, 'content-type': 'application/json' }, over: { slangWritable: false } });
  assert.equal(a.status, 503);
  assert.match(a.json.error, /黑话库处于只读降级/);

  const b = prelude({ path: '/api/stickers/sync', method: 'POST', headers: { ...TOKEN, 'content-type': 'application/json' }, over: { stickerWritable: false } });
  assert.equal(b.status, 503);
  assert.match(b.json.error, /表情库处于只读降级/);

  // 读接口不受影响
  assert.equal(prelude({ path: '/api/slang', method: 'GET', headers: TOKEN, over: { slangWritable: false } }), null);
});

// ── 4. 路由表 ─────────────────────────────────────────────────────────────
await check('chain 按注册顺序尝试，返回 true 即停', async () => {
  const order = [];
  const router = createRouter()
    .chain(() => { order.push('a'); return false; })
    .chain(() => { order.push('b'); return true; })
    .chain(() => { order.push('c'); return true; });
  assert.equal(await router.dispatch(fakeReq(), url('/x')), true);
  assert.deepEqual(order, ['a', 'b'], 'c 不该被调用');
  assert.equal(router.chainSize, 3);
});

await check('精确路由先于 chain', async () => {
  const order = [];
  const router = createRouter()
    .get('/api/x', () => { order.push('exact'); return true; })
    .chain(() => { order.push('chain'); return true; });
  await router.dispatch(fakeReq(), url('/api/x'));
  assert.deepEqual(order, ['exact']);
});

await check('无人认领 + 无 fallback → false（调用方回 404）', async () => {
  const router = createRouter().chain(() => false);
  assert.equal(await router.dispatch(fakeReq(), url('/nope')), false);
});

await check('fallback 兜底且能拿到 req/url', async () => {
  const seen = [];
  const router = createRouter()
    .chain(() => false)
    .setFallback?.((req, u) => { seen.push(u.pathname); return true; });
  // setFallback 不在本版 API 里时，用 dispatch 的 fallback 参数
  const ok = await createRouter().dispatch(fakeReq(), url('/legacy'), {
    fallback: (req, u) => { seen.push(u.pathname); return true; },
  });
  assert.equal(ok, true);
  assert.deepEqual(seen, ['/legacy']);
});

await check('method 不匹配不会命中精确路由', async () => {
  const router = createRouter().post('/api/x', () => true);
  assert.equal(await router.dispatch(fakeReq({ method: 'GET' }), url('/api/x')), false);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
