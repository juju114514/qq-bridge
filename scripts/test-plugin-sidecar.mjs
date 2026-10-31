// sidecar 客户端的离线测试：用假 fetch，不碰真实 sidecar。
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, '..', 'plugin', 'sidecar.js')).href);

const results = [];
const check = (n, f) => { try { f(); results.push(['ok', n]); } catch (e) { results.push(['FAIL', n + ' — ' + (e?.message ?? e)]); } };
const checkAsync = async (n, f) => { try { await f(); results.push(['ok', n]); } catch (e) { results.push(['FAIL', n + ' — ' + (e?.message ?? e)]); } };

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const key = String(url).replace(/^https?:\/\/[^/]+/, '');
    const route = routes[key] ?? routes[key.split('?')[0]];
    if (!route) return { status: 404, headers: new Map(), text: async () => '{"ok":false,"error":"not found"}' };
    const r = typeof route === 'function' ? route(init) : route;
    return {
      status: r.status ?? 200,
      headers: new Map(Object.entries(r.headers ?? {})),
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
    };
  };
  return { impl, calls };
}

await checkAsync('health：200 且 ok:true → ok', async () => {
  const f = fakeFetch({ '/health': { body: { ok: true, mode: 'bridge', version: '1.2.3' } } });
  const c = mod.createSidecarClient({ baseUrl: 'http://127.0.0.1:3100', fetchImpl: f.impl });
  const h = await c.health();
  assert.equal(h.ok, true);
  assert.equal(h.mode, 'bridge');
});

await checkAsync('health：网络异常 → ok:false 且带 error（不抛）', async () => {
  const c = mod.createSidecarClient({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const h = await c.health();
  assert.equal(h.ok, false);
  assert.match(h.error, /ECONNREFUSED/);
});

await checkAsync('snapshot：带 Bearer，返回 state 并缓存 ETag', async () => {
  const f = fakeFetch({ '/snapshot': { body: { ok: true, etag: '"abc"', state: { key: 'group:1' } } } });
  const c = mod.createSidecarClient({ baseUrl: 'http://x', token: 'T', fetchImpl: f.impl });
  const s = await c.snapshot('group:1');
  assert.equal(s.ok, true);
  assert.equal(s.state.key, 'group:1');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer T');
  assert.match(String(f.calls[0].url), /key=group%3A1/);
});

await checkAsync('snapshot：第二次带 If-None-Match，304 时返回上次的 state', async () => {
  let n = 0;
  const f = fakeFetch({
    '/snapshot': () => (n++ === 0
      ? { body: { ok: true, etag: '"abc"', state: { key: 'k', v: 1 } } }
      : { status: 304, body: '' }),
  });
  const c = mod.createSidecarClient({ baseUrl: 'http://x', token: 'T', fetchImpl: f.impl });
  await c.snapshot('k');
  const second = await c.snapshot('k');
  assert.equal(second.notModified, true);
  assert.deepEqual(second.state, { key: 'k', v: 1 });
  assert.equal(f.calls[1].init.headers['if-none-match'], '"abc"');
});

await checkAsync('snapshot：500 → ok:false，不缓存', async () => {
  const f = fakeFetch({ '/snapshot': { status: 500, body: { ok: false, error: 'boom' } } });
  const c = mod.createSidecarClient({ fetchImpl: f.impl });
  const s = await c.snapshot('k');
  assert.equal(s.ok, false);
  assert.match(s.error, /boom/);
});

await checkAsync('postIntent：202 → 返回 json；非 202 → 抛错', async () => {
  const okF = fakeFetch({ '/intents': { status: 202, body: { ok: true, applied: 1 } } });
  const c1 = mod.createSidecarClient({ token: 'T', fetchImpl: okF.impl });
  const r = await c1.postIntent({ key: 'group:1', intent: 'read.mark', payload: { throughSeq: 5 } });
  assert.equal(r.applied, 1);
  assert.equal(okF.calls[0].init.method, 'POST');
  assert.match(okF.calls[0].init.body, /read\.mark/);

  const badF = fakeFetch({ '/intents': { status: 400, body: { ok: false, error: 'key 不能为空' } } });
  const c2 = mod.createSidecarClient({ fetchImpl: badF.impl });
  await assert.rejects(() => c2.postIntent({ key: '', intent: 'x' }), /key 不能为空/);
});

await checkAsync('postEvent：成功 true，失败 false（不上抛）', async () => {
  const okF = fakeFetch({ '/events': { status: 202, body: { ok: true } } });
  assert.equal(await mod.createSidecarClient({ fetchImpl: okF.impl }).postEvent({ kind: 'x' }), true);
  const bad = mod.createSidecarClient({ fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(await bad.postEvent({ kind: 'x' }), false);
});

check('baseUrl 末尾斜杠被去掉', () => {
  const c = mod.createSidecarClient({ baseUrl: 'http://127.0.0.1:3100///' });
  assert.equal(c.baseUrl, 'http://127.0.0.1:3100');
});

const failed = results.filter(([s]) => s !== 'ok');
for (const [s, n] of results) console.log(`  ${s === 'ok' ? 'ok  ' : 'FAIL'} ${n}`);
console.log(`\n结果：${results.length - failed.length} 通过，${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);