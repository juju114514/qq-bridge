// P1-1（v0.4.49）：插件工具白名单必须 fail-closed。
//
// 旧行为（v0.4.48）：`agentCtx?.tools?.restrict?.(...)` 用可选链 + 无条件成功日志，
// 失败只记警告 → 陌生人 QQ 会话可能拿到 bash/read/write/edit。
import assert from 'node:assert/strict';

const m = await import(new URL('../plugin/index.js', import.meta.url).href);
const ALLOW = ['qqb_send_message', 'qqb_reply'];

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('正常：restrict 被调用一次，且参数就是白名单', () => {
  const calls = [];
  const logs = [];
  const ok = m.applyToolAllowlist({ tools: { restrict: (arg) => calls.push(arg) } }, ALLOW, (l) => logs.push(l));
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { allow: ALLOW });
  assert.ok(logs.some((l) => l.includes('已对 agent 应用工具白名单')), '成功时才允许打成功日志');
});

check('宿主没有 tools.restrict → 抛错（不静默跳过）', () => {
  assert.throws(() => m.applyToolAllowlist({ tools: {} }, ALLOW, () => {}), /缺少 tools\.restrict/);
});

check('agentCtx 为 undefined → 抛错（可选链不再吞掉）', () => {
  assert.throws(() => m.applyToolAllowlist(undefined, ALLOW, () => {}), /缺少 tools\.restrict/);
});

check('restrict 抛错 → 异常向外传，且**不**打成功日志', () => {
  const logs = [];
  assert.throws(
    () => m.applyToolAllowlist({ tools: { restrict: () => { throw new Error('宿主拒绝'); } } }, ALLOW, (l) => logs.push(l)),
    /宿主拒绝/,
  );
  assert.equal(logs.filter((l) => l.includes('已对 agent 应用工具白名单')).length, 0, '失败时不得出现成功日志');
});

check('空白名单 → 抛错（空名单可能被宿主理解为不过滤）', () => {
  assert.throws(() => m.applyToolAllowlist({ tools: { restrict: () => {} } }, [], () => {}), /白名单为空/);
});

check('源码层：不再出现「可选链 + 无条件成功日志」的旧写法', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../plugin/index.js', import.meta.url), 'utf8');
  assert.ok(!/agentCtx\?\.tools\?\.restrict\?\.\(/.test(src), '旧的 fail-open 写法还在');
  assert.ok(src.includes('toolsUnsafe'), '缺少入站侧的双保险标记');
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
