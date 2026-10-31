// DSH 端口发现：DSH_WEB_URL 优先（移植自上游 #63）
import assert from 'node:assert/strict';

const m = await import(new URL('../src/dsh-port.js', import.meta.url).href);
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('接受本地回环地址（去掉路径与查询）', () => {
  assert.equal(m.dshUrlFromEnv({ DSH_WEB_URL: 'http://127.0.0.1:63262/dashboard?x=1' }), 'http://127.0.0.1:63262');
  assert.equal(m.dshUrlFromEnv({ DSH_WEB_URL: 'http://localhost:3080' }), 'http://localhost:3080');
});
check('拒绝非回环地址（不能把外部地址当本机 DSH）', () => {
  assert.equal(m.dshUrlFromEnv({ DSH_WEB_URL: 'http://evil.example.com:80' }), '');
  assert.equal(m.dshUrlFromEnv({ DSH_WEB_URL: 'http://10.0.0.5:3000' }), '');
});
check('拒绝非 http(s) 协议', () => {
  assert.equal(m.dshUrlFromEnv({ DSH_WEB_URL: 'file:///etc/passwd' }), '');
});
check('缺失或空值返回空串', () => {
  assert.equal(m.dshUrlFromEnv({}), '');
  assert.equal(m.dshUrlFromEnv({ DSH_WEB_URL: '   ' }), '');
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
