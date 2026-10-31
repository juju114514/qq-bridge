// 官方通道接入闸门（0.4.65）：只判断"能不能接、还差什么"，不连接不发消息。
import assert from 'node:assert/strict';

const m = await import(new URL('../src/official/gate.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const full = { enabled: true, appid: '123456', secret: 's3cret', allow: ['openid-a'], allowAll: false };

check('条件齐全 → allowed，且 note 说"改开关即接入"', () => {
  const g = m.officialGate({ cfg: full, probePassed: true });
  assert.equal(g.allowed, true);
  assert.deepEqual(g.missing, []);
  assert.match(g.note, /official\.enabled/);
});

check('未启用但其余都齐 → readyToFlip=true（只差开关）', () => {
  const g = m.officialGate({ cfg: { ...full, enabled: false }, probePassed: true });
  assert.equal(g.allowed, false);
  assert.equal(g.readyToFlip, true, '应识别出"只差一个开关"');
  assert.equal(g.missing.length, 1);
  assert.equal(g.missing[0].key, 'enabled');
});

check('缺 appid / secret / 白名单 → 逐项列出并给 hint', () => {
  const g = m.officialGate({ cfg: { enabled: true }, probePassed: false });
  const keys = g.missing.map((x) => x.key);
  assert.deepEqual(keys, ['appid', 'secret', 'allow', 'probe']);
  for (const x of g.missing) assert.ok(x.hint && x.hint.length > 3, `${x.key} 应有 hint`);
});

check('allowAll=true 视为已配接收范围', () => {
  const g = m.officialGate({ cfg: { ...full, allow: [], allowAll: true }, probePassed: true });
  assert.equal(g.checks.allow, true);
  assert.equal(g.allowed, true);
});

check('探针：标记文件或运行时已连接，都算通过', () => {
  const withMarker = m.officialGate({ cfg: full, probePassed: true });
  const withRuntime = m.officialGate({ cfg: full, probePassed: false, transportReady: true });
  const neither = m.officialGate({ cfg: full, probePassed: false });
  assert.equal(withMarker.allowed, true);
  assert.equal(withMarker.probeSource, 'marker');
  assert.equal(withRuntime.allowed, true, '已经连上的实例不应被判"未就绪"');
  assert.equal(withRuntime.probeSource, 'runtime');
  assert.equal(neither.allowed, false, '既没跑探针也没连上 → 不算通过');
  assert.equal(neither.missing[0].key, 'probe');
});

check('状态文案：未启用 / 已配置未启用 / 连接中 / 已连接 / 连接失败', () => {
  assert.equal(m.officialGate({ cfg: {} }).state, '未启用');
  assert.equal(m.officialGate({ cfg: { appid: '1', secret: 's' } }).state, '已配置未启用');
  assert.equal(m.officialGate({ cfg: full }).state, '连接中');
  assert.equal(m.officialGate({ cfg: full, transportReady: true }).state, '已连接');
  assert.equal(m.officialGate({ cfg: full, lastError: 'boom' }).state, '连接失败');
});

check('脏数据不炸（cfg 为 null / 字段类型不对）', () => {
  for (const cfg of [null, undefined, {}, { allow: 'not-array' }, { appid: 123 }]) {
    const g = m.officialGate({ cfg });
    assert.equal(typeof g.allowed, 'boolean');
    assert.ok(Array.isArray(g.missing));
  }
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
