// 外部触发入口（src/api/inject.js）的契约测试：全离线。
//
// 这是唯一允许"外部系统推动机器人"的入口，鉴权/白名单/限流任何一处漏了都危险，
// 所以逐条钉住：令牌、开关、格式、白名单、限流、两种模式。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const m = await import(new URL('../src/api/inject.js', import.meta.url).href);
const { CONV_KEY_RE, convId } = await import(new URL('../src/conv-key.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const TOKEN = 'inject-token-abc123';
const mkDeps = (over = {}) => {
  const calls = { sent: [], prompted: [], json: [], logged: [] };
  const cfg = { inject: { enabled: true, token: TOKEN, maxPerMinute: 2 }, allow: { groups: [123], private: [] } };
  const deps = {
    sendJson: (obj, status = 200) => calls.json.push({ obj, status }),
    readBody: async () => over.body ?? {},
    log: (msg) => calls.logged.push(String(msg)),
    getCfg: () => over.cfg ?? cfg,
    getMode: () => 'chat',
    modeAllowed: (key, kind, id) => over.allowed !== false,
    appendActivity: () => {},
    deliverPrompt: async (key, text) => { calls.prompted.push({ key, text }); return over.promptResult ?? { ok: true }; },
    sendSay: async (key, text) => { calls.sent.push({ key, text }); if (over.sayThrows) throw new Error('send failed'); },
    CONV_KEY_RE, convId
  };
  return { deps, calls };
};

const req = (token = TOKEN, method = 'POST') => ({
  method,
  headers: token ? { authorization: `Bearer ${token}` } : {}
});

await check('未带令牌 401；令牌错误 401；开关关闭 401', async () => {
  {
    const { deps, calls } = mkDeps({ body: { key: 'group:official-X', text: 'hi' } });
    const h = m.createInjectHandler(deps);
    await h(req(null), { pathname: '/api/inject' });
    assert.equal(calls.json[0].status, 401);
  }
  {
    const { deps, calls } = mkDeps({ body: { key: 'group:official-X', text: 'hi' } });
    const h = m.createInjectHandler(deps);
    await h(req('wrong-token'), { pathname: '/api/inject' });
    assert.equal(calls.json[0].status, 401);
  }
  {
    const { deps, calls } = mkDeps({ body: { key: 'group:official-X', text: 'hi' }, cfg: { inject: { enabled: false } } });
    const h = m.createInjectHandler(deps);
    await h(req(), { pathname: '/api/inject' });
    assert.equal(calls.json[0].status, 401);
    assert.match(calls.json[0].obj.error, /未启用/);
  }
});

await check('只认 POST；非 /api/inject 路径不认领', async () => {
  {
    const { deps, calls } = mkDeps({ body: {} });
    const h = m.createInjectHandler(deps);
    const claimed = await h(req(), { pathname: '/api/other' });
    assert.equal(claimed, false, '别的路径应返回 false 交给后续处理器');
    assert.equal(calls.json.length, 0);
  }
  {
    const { deps, calls } = mkDeps({ body: {} });
    const h = m.createInjectHandler(deps);
    await h(req(TOKEN, 'GET'), { pathname: '/api/inject' });
    assert.equal(calls.json[0].status, 405);
  }
});

await check('参数校验：key/text 必填、mode 只允许 prompt|say、text 上限 2000', async () => {
  for (const [body, want] of [
    [{ text: 'x' }, /key/],
    [{ key: 'group:1' }, /text/],
    [{ key: 'group:1', text: 'x', mode: 'bad' }, /mode/],
    [{ key: 'group:1', text: 'x'.repeat(2001) }, /2000/]
  ]) {
    const { deps, calls } = mkDeps({ body });
    const h = m.createInjectHandler(deps);
    await h(req(), { pathname: '/api/inject' });
    assert.equal(calls.json[0].status, 400, JSON.stringify(body).slice(0, 40));
    assert.match(calls.json[0].obj.error, want);
  }
});

await check('key 格式非法 400；不在白名单 403', async () => {
  {
    const { deps, calls } = mkDeps({ body: { key: 'weird:1', text: 'x' } });
    const h = m.createInjectHandler(deps);
    await h(req(), { pathname: '/api/inject' });
    assert.equal(calls.json[0].status, 400);
  }
  {
    const { deps, calls } = mkDeps({ body: { key: 'group:999', text: 'x' }, allowed: false });
    const h = m.createInjectHandler(deps);
    await h(req(), { pathname: '/api/inject' });
    assert.equal(calls.json[0].status, 403);
  }
});

await check('mode=say 直接发；mode=prompt 交给 AI；失败返回 502', async () => {
  {
    const { deps, calls } = mkDeps({ body: { key: 'group:official-ABC', text: '构建失败', mode: 'say' } });
    const h = m.createInjectHandler(deps);
    await h(req(), { pathname: '/api/inject' });
    assert.equal(calls.json[0].status, 200);
    assert.equal(calls.sent[0].text, '构建失败');
    assert.equal(calls.sent[0].key, 'group:official-ABC');
  }
  {
    const { deps, calls } = mkDeps({ body: { key: 'group:official-ABC', text: '有人 @ 你', mode: 'prompt' } });
    const h = m.createInjectHandler(deps);
    await h(req(), { pathname: '/api/inject' });
    assert.equal(calls.json[0].status, 200);
    assert.equal(calls.prompted[0].text, '有人 @ 你');
  }
  {
    const { deps, calls } = mkDeps({ body: { key: 'group:official-ABC', text: 'x', mode: 'prompt' }, promptResult: { ok: false, error: 'DSH 未就绪' } });
    const h = m.createInjectHandler(deps);
    await h(req(), { pathname: '/api/inject' });
    assert.equal(calls.json[0].status, 502);
  }
  {
    const { deps, calls } = mkDeps({ body: { key: 'group:official-ABC', text: 'x', mode: 'say' }, sayThrows: true });
    const h = m.createInjectHandler(deps);
    await h(req(), { pathname: '/api/inject' });
    assert.equal(calls.json[0].status, 500);
  }
});

await check('限流：超过 maxPerMinute 返回 429', async () => {
  const { deps, calls } = mkDeps({ body: { key: 'group:official-A', text: 'x', mode: 'say' } });
  const h = m.createInjectHandler(deps);
  await h(req(), { pathname: '/api/inject' });
  await h(req(), { pathname: '/api/inject' });
  await h(req(), { pathname: '/api/inject' });
  assert.equal(calls.json[2].status, 429);
});

await check('接线：bridge 注册 /api/inject，令牌存 state/inject-token', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /createInjectHandler/, '要创建 handler');
  // 路由判定已搬到 src/api/console-misc.js（波次 4）；bridge 必须仍把它接进派发链
  assert.match(read('src/api/console-misc.js'), /'\/api\/inject'/, '要注册路由');
  assert.match(bridge, /handleConsoleMiscRoutes\(req, url/, 'bridge 必须把杂项路由接进派发链');
  assert.match(bridge, /inject-token/, '令牌文件');
  assert.match(bridge, /makeInjectToken/, '首次启动生成');
  const cfg = JSON.parse(read('config.example.json'));
  assert.ok(cfg.inject, '示例配置要有 inject 段');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
