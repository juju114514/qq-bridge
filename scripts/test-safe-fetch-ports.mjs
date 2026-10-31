// safe-fetch 的端口白名单（2026-10-31，backport 自上游 #85 的一半）。
//
// 由来：私网 IP 拦截挡住了「内网主机」，但没挡「公网 IP 的内网端口」
// （如 :6379 Redis、:9200 ES 的 HTTP 面）。媒体抓取只该碰 Web 端口。
import assert from 'node:assert/strict';

const mod = await import(new URL('../src/safe-fetch.js', import.meta.url).href);
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('http 默认端口 80 放行', () => {
  assert.equal(mod.assertSafePort('http://example.com/a.png'), 80);
});
check('https 默认端口 443 放行', () => {
  assert.equal(mod.assertSafePort('https://example.com/a.png'), 443);
});
check('白名单端口 8080 放行', () => {
  assert.equal(mod.assertSafePort('http://example.com:8080/x'), 8080);
});
check('非白名单端口 6379 拒绝', () => {
  assert.throws(() => mod.assertSafePort('http://example.com:6379/'), /非白名单端口/);
});
check('非白名单端口 9200 拒绝', () => {
  assert.throws(() => mod.assertSafePort('http://example.com:9200/'), /非白名单端口/);
});
check('白名单是冻结的（防止运行期被改）', () => {
  assert.ok(Object.isFrozen(mod.SAFE_PORTS));
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
