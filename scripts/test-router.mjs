#!/usr/bin/env node
/**
 * src/http/router.js 单元测试。
 * 只测匹配语义 —— 不碰 HTTP，不依赖 bridge.js。
 */
import assert from 'node:assert/strict';
import { createRouter } from '../src/http/router.js';

let pass = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

const noop = () => {};

t('精确匹配 GET', () => {
  const r = createRouter().get('/api/status', noop);
  assert.ok(r.match('GET', '/api/status'));
  assert.equal(r.match('POST', '/api/status'), null);
  assert.equal(r.match('GET', '/api/statusx'), null);
});

t('尾斜杠归一化', () => {
  const r = createRouter().get('/api/status', noop);
  assert.ok(r.match('GET', '/api/status/'));
});

t('根路径不归一化', () => {
  const r = createRouter().get('/', noop);
  assert.ok(r.match('GET', '/'));
  assert.equal(r.match('GET', ''), null);
});

t('前缀匹配（startsWith 语义）', () => {
  const r = createRouter().use('/api/socialV2/', noop);
  assert.ok(r.match('GET', '/api/socialV2/config'));
  assert.ok(r.match('POST', '/api/socialV2/send'));
  assert.equal(r.match('GET', '/api/socialV2'), null); // 必须带斜杠
  assert.equal(r.match('GET', '/api/socialV20/x'), null); // 不能被当成前缀
});

t('param 匹配与解码', () => {
  const r = createRouter().param('GET', '/api/send/:target', noop);
  const m = r.match('GET', '/api/send/private%3A123');
  assert.ok(m);
  assert.equal(m.params.target, 'private:123');
});

t('wildcard 匹配', () => {
  const r = createRouter().param('GET', '/api/images/*', noop);
  assert.ok(r.match('GET', '/api/images/a/b.png'));
});

t('精确优先于前缀', () => {
  const hit = [];
  const r = createRouter()
    .use('/api/', () => hit.push('prefix'))
    .get('/api/status', () => hit.push('exact'));
  const m = r.match('GET', '/api/status');
  m.handler();
  assert.deepEqual(hit, ['exact']);
});

t('注册顺序决定前缀优先级', () => {
  const a = () => 'a';
  const b = () => 'b';
  const r = createRouter().use('/api/a/', a).use('/api/', b);
  assert.equal(r.match('GET', '/api/a/x').handler, a);   // 先注册的先命中
  assert.equal(r.match('GET', '/api/b').handler, b);     // 不在 /api/a/ 下才落到 /api/
  assert.equal(r.routes()[0].pattern, '/api/a/');
});

t('非法路径抛错', () => {
  assert.throws(() => createRouter().get('api/status', noop), /必须以 \/ 开头/);
});

t('handler 非函数抛错', () => {
  assert.throws(() => createRouter().get('/x', 'nope'), /handler 必须是函数/);
});

t('未知 method 返回 null', () => {
  const r = createRouter().get('/x', noop);
  assert.equal(r.match('TRACE', '/x'), null);
});

console.log(`\n  ${pass} 项通过`);
if (process.exitCode) console.error('  有失败项');
