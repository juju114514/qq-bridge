// 更新检查（src/update-check.js）：版本比较 / release 解析 / 带缓存与 TTL 的检查器
//
// 全程离线：fetch 一律注入假的实现（真打 GitHub 会让测试变慢、还会受网络与限流影响）。
// 缓存文件写在系统临时目录，结束时清理。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import(new URL('../src/update-check.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-update-check-'));
const tmpFile = (name) => path.join(tmpRoot, name);

// ---- 假 fetch 工具 ----
const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return payload; }
});

/** 记录每次调用的假 fetch；返回值上挂 calls 数组方便断言调用次数。 */
function makeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
  fn.calls = calls;
  return fn;
}

const RELEASE = {
  tag_name: 'v9.9.9',
  html_url: 'https://github.com/example/qq-bridge/releases/tag/v9.9.9',
  published_at: '2026-11-01T10:00:00Z',
  body: '- 修了若干问题'
};

try {
  // ---------- 1. compareVersions：数字段比较 ----------
  await check('compareVersions：0.4.113 比 0.4.112 新 → 1', () => {
    assert.equal(m.compareVersions('0.4.113', '0.4.112'), 1);
  });

  await check('compareVersions：相同版本 → 0', () => {
    assert.equal(m.compareVersions('0.4.113', '0.4.113'), 0);
    assert.equal(m.compareVersions('v0.4.113', '0.4.113'), 0);
  });

  await check('compareVersions：v0.4.9 比 0.4.10 旧 → -1（按数字不按字符串）', () => {
    assert.equal(m.compareVersions('v0.4.9', '0.4.10'), -1);
    assert.equal(m.compareVersions('0.4.10', 'v0.4.9'), 1, '反过来应为 1');
  });

  await check('compareVersions：缺失段按 0（0.4 === 0.4.0），段数不同也能比', () => {
    assert.equal(m.compareVersions('0.4', '0.4.0'), 0);
    assert.equal(m.compareVersions('1', '0.9.9'), 1);
    assert.equal(m.compareVersions('0.4.113', '0.4.113.1'), -1);
  });

  // ---------- 2. compareVersions：预发布 ----------
  await check('compareVersions：0.4.113-beta.1 小于 0.4.113', () => {
    assert.equal(m.compareVersions('0.4.113-beta.1', '0.4.113'), -1);
    assert.equal(m.compareVersions('0.4.113', '0.4.113-beta.1'), 1);
  });

  await check('compareVersions：预发布逐标识符比（beta.2 < beta.10，beta < beta.1）', () => {
    assert.equal(m.compareVersions('0.4.113-beta.2', '0.4.113-beta.10'), -1);
    assert.equal(m.compareVersions('0.4.113-beta', '0.4.113-beta.1'), -1);
    assert.equal(m.compareVersions('0.4.113-beta.1', '0.4.113-beta.1'), 0);
    assert.equal(m.compareVersions('0.4.113-alpha', '0.4.113-beta'), -1, '字母按 ASCII 比');
  });

  // ---------- 3. parseRelease ----------
  await check('parseRelease：正常响应正确映射四个字段', () => {
    const r = m.parseRelease(RELEASE);
    assert.deepEqual(r, {
      latest: '9.9.9',            // v 前缀要剥掉
      url: RELEASE.html_url,
      publishedAt: RELEASE.published_at,
      body: RELEASE.body
    });
  });

  await check('parseRelease：null / 非对象 / 缺 tag_name → null，不抛', () => {
    assert.equal(m.parseRelease(null), null);
    assert.equal(m.parseRelease(undefined), null);
    assert.equal(m.parseRelease('oops'), null);
    assert.equal(m.parseRelease([RELEASE]), null);
    assert.equal(m.parseRelease({}), null);
    assert.equal(m.parseRelease({ html_url: 'https://x' }), null, '没有 tag_name 应解析不出');
    assert.equal(m.parseRelease({ tag_name: 'nightly' }), null, 'tag 不像版本号也算不出来');
  });

  await check('parseRelease：次要字段缺失不炸（url 空串 / publishedAt null / body 空串）', () => {
    const r = m.parseRelease({ tag_name: '0.4.113' });
    assert.equal(r.latest, '0.4.113');
    assert.equal(r.url, '');
    assert.equal(r.publishedAt, null);
    assert.equal(r.body, '');
  });

  // ---------- 4. createUpdateChecker：成功路径 ----------
  const fetchOk = makeFetch(() => jsonResponse(RELEASE));
  const cacheA = tmpFile('cache-a.json');
  const checkerA = m.createUpdateChecker({
    currentVersion: '0.4.113',
    repo: 'example/qq-bridge',
    fetchImpl: fetchOk,
    cacheFile: cacheA
  });

  const first = await checkerA.check();
  await check('checker：远端 v9.9.9 → latest 9.9.9、hasUpdate: true、cached: false', () => {
    assert.equal(first.ok, true);
    assert.equal(first.latest, '9.9.9');
    assert.equal(first.current, '0.4.113');
    assert.equal(first.hasUpdate, true);
    assert.equal(first.cached, false);
    assert.equal(first.url, RELEASE.html_url);
    assert.equal(first.publishedAt, RELEASE.published_at);
    assert.equal(typeof first.checkedAt, 'number');
    assert.equal('error' in first, false, '成功时不该带 error');
  });

  await check('checker：请求 URL 与必需 header 正确', () => {
    assert.equal(fetchOk.calls.length, 1);
    const { url, opts } = fetchOk.calls[0];
    assert.equal(url, 'https://api.github.com/repos/example/qq-bridge/releases/latest');
    assert.equal(opts.headers.accept, 'application/vnd.github+json');
    assert.equal(opts.headers['user-agent'], 'qq-bridge-update-check');
    assert.ok(opts.signal, '应带 AbortSignal.timeout 的超时信号');
  });

  await check('checker：成功时写缓存文件 { at, latest, url, publishedAt }', () => {
    assert.equal(fs.existsSync(cacheA), true, '缓存文件应已写出');
    const cached = JSON.parse(fs.readFileSync(cacheA, 'utf8'));
    assert.equal(cached.latest, '9.9.9');
    assert.equal(cached.url, RELEASE.html_url);
    assert.equal(cached.publishedAt, RELEASE.published_at);
    assert.equal(typeof cached.at, 'number');
    assert.equal(first.checkedAt, cached.at, 'checkedAt 应等于缓存时间戳');
  });

  // ---------- 5. 缓存命中：不再打网络 ----------
  await check('checker：第二次 check() 命中缓存（cached: true），假 fetch 只调用一次', async () => {
    const second = await checkerA.check();
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(second.latest, '9.9.9');
    assert.equal(second.hasUpdate, true);
    assert.equal(fetchOk.calls.length, 1, `fetch 应只被调用 1 次，实际 ${fetchOk.calls.length} 次`);
  });

  await check('checker：force: true 绕过缓存，重新请求', async () => {
    const forced = await checkerA.check({ force: true });
    assert.equal(forced.cached, false);
    assert.equal(fetchOk.calls.length, 2);
  });

  // ---------- 6. TTL：过期后重新请求 ----------
  await check('checker：缓存超过 ttlMs 后失效并重新请求', async () => {
    const clock = { t: Date.parse('2026-11-02T00:00:00Z') };
    const fetchTtl = makeFetch(() => jsonResponse(RELEASE));
    const cacheTtl = tmpFile('cache-ttl.json');
    const checker = m.createUpdateChecker({
      currentVersion: '0.4.113',
      repo: 'example/qq-bridge',
      fetchImpl: fetchTtl,
      cacheFile: cacheTtl,
      ttlMs: 1000,
      now: () => clock.t
    });
    const a = await checker.check();
    assert.equal(a.cached, false);
    clock.t += 500;
    const b = await checker.check();
    assert.equal(b.cached, true, 'TTL 内应命中缓存');
    clock.t += 2000;
    const c = await checker.check();
    assert.equal(c.cached, false, '超过 TTL 应重新请求');
    assert.equal(fetchTtl.calls.length, 2);
  });

  await check('checker：缓存 JSON 坏掉时静默降级为重新请求', async () => {
    const fetchBadCache = makeFetch(() => jsonResponse(RELEASE));
    const cacheBad = tmpFile('cache-corrupt.json');
    fs.writeFileSync(cacheBad, '{ 这不是 json', 'utf8');
    const checker = m.createUpdateChecker({
      currentVersion: '0.4.113',
      repo: 'example/qq-bridge',
      fetchImpl: fetchBadCache,
      cacheFile: cacheBad
    });
    const r = await checker.check();
    assert.equal(r.ok, true);
    assert.equal(r.cached, false);
    assert.equal(fetchBadCache.calls.length, 1);
  });

  // ---------- 7. 失败路径：都不抛，只回 ok:false ----------
  await check('checker：fetch 抛错 → ok:false + error，且不抛异常', async () => {
    const fetchThrow = makeFetch(() => { throw new Error('fetch failed'); });
    const checker = m.createUpdateChecker({
      currentVersion: '0.4.113',
      repo: 'example/qq-bridge',
      fetchImpl: fetchThrow,
      cacheFile: tmpFile('cache-fail.json')
    });
    const r = await checker.check();
    assert.equal(r.ok, false);
    assert.equal(r.hasUpdate, false);
    assert.equal(r.current, '0.4.113');
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0);
    assert.match(r.error, /fetch failed/);
  });

  await check('checker：超时错误被翻成可读提示', async () => {
    const fetchTimeout = makeFetch(() => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    });
    const checker = m.createUpdateChecker({
      currentVersion: '0.4.113',
      repo: 'example/qq-bridge',
      fetchImpl: fetchTimeout,
      cacheFile: tmpFile('cache-timeout.json')
    });
    const r = await checker.check();
    assert.equal(r.ok, false);
    assert.match(r.error, /超时/);
  });

  await check('checker：HTTP 404 → ok:false 且提到 404', async () => {
    const fetch404 = makeFetch(() => jsonResponse({ message: 'Not Found' }, 404));
    const checker = m.createUpdateChecker({
      currentVersion: '0.4.113',
      repo: 'example/qq-bridge',
      fetchImpl: fetch404,
      cacheFile: tmpFile('cache-404.json')
    });
    const r = await checker.check();
    assert.equal(r.ok, false);
    assert.equal(r.hasUpdate, false);
    assert.match(r.error, /404/);
  });

  await check('checker：JSON 坏掉 → ok:false，不抛', async () => {
    const fetchBadJson = makeFetch(() => ({
      ok: true,
      status: 200,
      async json() { throw new SyntaxError('Unexpected token < in JSON'); }
    }));
    const checker = m.createUpdateChecker({
      currentVersion: '0.4.113',
      repo: 'example/qq-bridge',
      fetchImpl: fetchBadJson,
      cacheFile: tmpFile('cache-badjson.json')
    });
    const r = await checker.check();
    assert.equal(r.ok, false);
    assert.equal(r.hasUpdate, false);
    assert.match(r.error, /JSON/);
  });

  await check('checker：成功响应但缺 tag_name → ok:false，不写坏缓存', async () => {
    const fetchNoTag = makeFetch(() => jsonResponse({ html_url: 'https://x', body: 'hi' }));
    const cacheNoTag = tmpFile('cache-notag.json');
    const checker = m.createUpdateChecker({
      currentVersion: '0.4.113',
      repo: 'example/qq-bridge',
      fetchImpl: fetchNoTag,
      cacheFile: cacheNoTag
    });
    const r = await checker.check();
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(cacheNoTag), false, '解析失败不该写缓存');
  });

  // ---------- 8. 本地版本更高 / 缓存文件不可写 ----------
  await check('checker：当前版本 0.5.0 比远端 0.4.113 新 → hasUpdate: false', async () => {
    const payload = { tag_name: 'v0.4.113', html_url: 'https://x/tag', published_at: '2026-11-01T00:00:00Z' };
    const fetchOld = makeFetch(() => jsonResponse(payload));
    const checker = m.createUpdateChecker({
      currentVersion: '0.5.0',
      repo: 'example/qq-bridge',
      fetchImpl: fetchOld,
      cacheFile: tmpFile('cache-newer.json')
    });
    const r = await checker.check();
    assert.equal(r.ok, true);
    assert.equal(r.latest, '0.4.113');
    assert.equal(r.hasUpdate, false);
  });

  await check('checker：缓存路径不可写时静默降级（检查照常成功）', async () => {
    const dirAsCache = tmpFile('cache-is-a-dir');
    fs.mkdirSync(dirAsCache, { recursive: true });   // 当文件写会 EISDIR
    const logs = [];
    const fetchOk2 = makeFetch(() => jsonResponse(RELEASE));
    const checker = m.createUpdateChecker({
      currentVersion: '0.4.113',
      repo: 'example/qq-bridge',
      fetchImpl: fetchOk2,
      cacheFile: dirAsCache,
      log: (msg) => logs.push(String(msg))
    });
    const r = await checker.check();
    assert.equal(r.ok, true);
    assert.equal(r.hasUpdate, true);
    assert.equal(logs.length, 1, '写缓存失败应只留一条日志，不影响结果');
  });

  await check('checker：没配 repo → ok:false，且不发起请求', async () => {
    const fetchNever = makeFetch(() => jsonResponse(RELEASE));
    const checker = m.createUpdateChecker({
      currentVersion: '0.4.113',
      repo: '',
      fetchImpl: fetchNever,
      cacheFile: tmpFile('cache-norepo.json')
    });
    const r = await checker.check();
    assert.equal(r.ok, false);
    assert.match(r.error, /repo/);
    assert.equal(fetchNever.calls.length, 0);
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('');
  if (failures === 0) console.log('  全部通过');
  else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
}
