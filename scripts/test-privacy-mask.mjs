// QQ 号脱敏（0.4.122）：默认不把真实 QQ 号喂给模型
import assert from 'node:assert/strict';

const m = await import(new URL('../src/privacy-mask.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('脱敏：真 QQ 号只留后 4 位', () => {
  assert.equal(m.maskQqId('10002'), '群友0002');
});

check('脱敏：数字串（非 QQ 长度）也照常打码', () => {
  assert.equal(m.maskQqId(38450714413391874), '群友1870');   // 末 4 位：…1874 的末四位是 1874？实际取字符串末 4 = 1870（JS 数字精度）
});

check('昵称不打码（否则会把真昵称毁掉）', () => {
  assert.equal(m.maskQqId('小鲸鱼'), '小鲸鱼');
  assert.equal(m.maskQqId('群友1234'), '群友1234');
});

check('空值 → 群友', () => {
  assert.equal(m.maskQqId(''), '群友');
  assert.equal(m.maskQqId(null), '群友');
});

check('有昵称：直接用昵称，不看开关', () => {
  assert.equal(m.senderNameForModel('阿明', '10002', { exposeUserId: false }), '阿明');
  assert.equal(m.senderNameForModel('阿明', '10002', { exposeUserId: true }), '阿明');
});

check('没昵称 + 默认（不暴露）→ 打码', () => {
  assert.equal(m.senderNameForModel('', '10002'), '群友0002');
  assert.equal(m.senderNameForModel('', '10002', {}), '群友0002');
  assert.equal(m.senderNameForModel('', '10002', { exposeUserId: false }), '群友0002');
});

check('没昵称 + 显式打开 exposeUserId → 原样（给需要真号的运维场景）', () => {
  assert.equal(m.senderNameForModel('', '10002', { exposeUserId: true }), '10002');
});

check('没昵称也没兜底 → 群友', () => {
  assert.equal(m.senderNameForModel('', ''), '群友');
  assert.equal(m.senderNameForModel(null, null), '群友');
});

check('默认值就是「不暴露」', () => {
  assert.equal(m.DEFAULT_PRIVACY.exposeUserId, false);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
