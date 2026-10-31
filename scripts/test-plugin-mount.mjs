// DSH 插件骨架的离线挂载测试（不需要 DSH 宿主）。
//
// 这个测试替代"装进 DSH 才知道能不能加载"的盲试：用假 ctx 调 apply()，
// 断言四件事 —— 插件身份、依赖声明、工具注册、卸载清理。
// 真正的宿主加载检查放在 P1 末尾（临时 profile 里 dsh plugin add 一次）。
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugin');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name + ' — ' + (e?.message ?? e)]); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name + ' — ' + (e?.message ?? e)]); }
}

const mod = await import(pathToFileURL(path.join(pluginDir, 'index.js')).href);

check('插件导出 name / inject / apply（DSH 插件四项约定里的三项）', () => {
  assert.equal(typeof mod.name, 'string');
  assert.ok(mod.name.length > 0);
  assert.deepEqual(mod.inject, ['tools']);
  assert.equal(typeof mod.apply, 'function');
});

check('清单文件与入口一致（id / main / tools 声明）', async () => {
  const fs = await import('node:fs');
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'dsh.plugin.json'), 'utf8'));
  assert.equal(manifest.id, mod.name);
  assert.equal(manifest.main, './index.js');
  assert.ok(Array.isArray(manifest.contributes?.tools));
  assert.ok(manifest.contributes.tools.includes('qq_ping'), '清单里要声明 qq_ping，否则宿主不暴露');
  assert.match(manifest.engines?.dsh ?? '', />=0\.2\.1/);
});

// 现在会注册多个工具（qq_ping + N1 三件套），所以要收集成数组再按名字找。
let registeredAll = [];
let disposed = 0;
const fakeCtx = {
  tools: {
    register(tool) {
      registeredAll.push(tool);
      return () => { disposed += 1; };
    },
  },
};
const toolByName = (n) => registeredAll.find((t) => t.name === n);
let registered = null; // 由 qq_ping 填充（下面测试用）

const dispose = mod.apply(fakeCtx, { sidecarUrl: 'http://127.0.0.1:9', requireMention: false });

check('注册了 qq_ping，且参数/输出/execute 齐全', () => {
  registered = toolByName('qq_ping');
  assert.ok(registered, '没有注册 qq_ping');
  assert.ok(registeredAll.length >= 4, `至少应有 4 个工具（ping + 发送/回复/已读），实际 ${registeredAll.length}`);
  assert.equal(registered.name, 'qq_ping');
  assert.equal(typeof registered.execute, 'function');
  assert.deepEqual(registered.parameters, {});
  assert.ok(registered.output?.schema);
  // 真机学到的两条（不锁住的话下次还会踩）：
  assert.equal(typeof registered.output.render, 'function', 'output 必须同时有 render');
  assert.ok(['object','array','string','number','integer','boolean','null'].includes(registered.output.schema.type),
    `schema.type 必须是 ${'object/array/string/number/integer/boolean/null'} 之一，实际 ${registered.output.schema.type}`);
});

await checkAsync('qq_ping 在 sidecar 不可达时返回 degraded=true（降级语义）', async () => {
  const out = await registered.execute({}, {});
  assert.equal(out.ok, true);
  assert.equal(out.degraded, true);
  assert.match(out.note, /sidecar 不在/);
});

check('apply 返回卸载函数，调用后释放全部工具', () => {
  assert.equal(typeof dispose, 'function');
  const before = disposed;
  dispose();
  assert.ok(disposed > before, 'dispose 应该释放所有已注册工具');
});

check('缺 ctx.tools.register 时必须 fail-loud（不静默挂载）', () => {
  assert.throws(() => mod.apply({}, {}), /ctx\.tools\.register/);
});

check('配置归一化：默认值 + allowGroups 过滤非法项', () => {
  const cfg = mod.normalizeConfigForTest({ allowGroups: ['123', 'abc', 456, null] });
  assert.deepEqual(cfg.allowGroups, [123, 456]);
  assert.equal(cfg.requireMention, true);
  assert.equal(cfg.sidecarUrl, 'http://127.0.0.1:3110');
});

// ── createUserMessage 的形状（对照 dsh-llm 0.0.1-rc.1 的 .d.ts 确认过）─────────
const um = await import(pathToFileURL(path.join(pluginDir, 'user-message.js')).href);

check('buildUserMessage 产出 NewUserMessage 形状：{ content:[{type:text}], source:{kind:user} }', () => {
  const msg = um.buildUserMessage('你好');
  assert.deepEqual(msg, { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } });
  assert.equal(msg.id, undefined, '不能带 id —— createUserMessage 会拒绝');
  assert.equal(msg.role, undefined, '不能带 role —— 由 createUserMessage 固定');
});

check('assertNewUserMessage 对合法消息返回 true', () => {
  assert.equal(um.assertNewUserMessage(um.buildUserMessage('x')), true);
});

for (const [name, bad] of [
  ['带 id', { id: 'x', content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }],
  ['带 role', { role: 'user', content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }],
  ['content 空', { content: [], source: { kind: 'user' } }],
  ['text 不是字符串', { content: [{ type: 'text', text: 1 }], source: { kind: 'user' } }],
  ['source.kind 不对', { content: [{ type: 'text', text: 'a' }], source: { kind: 'plugin' } }],
]) {
  check(`assertNewUserMessage 拒绝非法消息：${name}`, () => {
    assert.throws(() => um.assertNewUserMessage(bad));
  });
}

const failed = results.filter(([s]) => s !== 'ok');
for (const [s, n] of results) console.log(`  ${s === 'ok' ? 'ok  ' : 'FAIL'} ${n}`);
console.log(`\n结果：${results.length - failed.length} 通过，${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);