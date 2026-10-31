// AI 写空间（0.4.77）：纯逻辑测试（不启动桥接、不调模型）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import(new URL('../src/qzone-draft.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const tmpFile = () => path.join(os.tmpdir(), `qzone-draft-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

check('buildDraftPrompt 委托给风格模块（单风格仍只有一种语气）', () => {
  const p = m.buildDraftPrompt({ style: 'funny', hint: '今天跑通了插件', recent: '群里聊了部署' });
  assert.match(p, /空间草稿请求/);
  assert.match(p, /风格：带点自嘲和梗/);
  assert.match(p, /每条都要遵守/);
  assert.match(p, /今天跑通了插件/);
  assert.match(p, /群里聊了部署/);
});

check('未知风格回落到 auto，不会抛错', () => {
  const p = m.buildDraftPrompt({ style: '不存在的风格' });
  assert.match(p, /你自己挑最合适的语气/);
});

check('cleanDraft 去掉前缀/引号/代码块，并截断到 300', () => {
  assert.equal(m.cleanDraft('这是说说：今天写完一个小功能。'), '今天写完一个小功能。');
  assert.equal(m.cleanDraft('“明天再说”'), '明天再说');
  assert.equal(m.cleanDraft('```\n明天再说\n```'), '明天再说');
  assert.ok(m.cleanDraft('啊'.repeat(400)).length <= 300);
});

check('pending 才能被捕获；非 pending 直接忽略', () => {
  const f = tmpFile();
  m.writeDraft(f, { status: 'idle', text: '', style: 'auto', at: Date.now(), error: '' });
  assert.equal(m.captureReply(f, '随便一句').captured, false);

  m.writeDraft(f, { status: 'pending', text: '', style: 'daily', styles: ['daily'], at: Date.now(), error: '' });
  const r = m.captureReply(f, '这是说说：今天有点累，但还行。');
  assert.equal(r.captured, true);
  assert.equal(r.keepSending, true, '默认仍要正常发给用户');
  const after = m.readDraft(f);
  assert.equal(after.status, 'ready');
  assert.equal(after.text, '今天有点累，但还行。');
  assert.equal(after.candidates.length, 1, '单条也要放进 candidates');
  fs.rmSync(f, { force: true });
});

check('超过 10 分钟的 pending 自动过期（不会几天后冒出旧草稿）', () => {
  const f = tmpFile();
  m.writeDraft(f, { status: 'pending', text: '', style: 'auto', at: Date.now() - m.DRAFT_TTL_MS - 1000, error: '' });
  const d = m.readDraft(f);
  assert.equal(d.status, 'expired');
  assert.match(d.error, /超时/);
  fs.rmSync(f, { force: true });
});

check('文件不存在 / JSON 坏掉 → 返回 idle，不抛', () => {
  assert.equal(m.readDraft(tmpFile()).status, 'idle');
  const bad = tmpFile();
  fs.writeFileSync(bad, '{oops');
  assert.equal(m.readDraft(bad).status, 'idle');
  fs.rmSync(bad, { force: true });
});

check('空回复不吞草稿状态', () => {
  const f = tmpFile();
  m.writeDraft(f, { status: 'pending', text: '', style: 'auto', at: Date.now(), error: '' });
  assert.equal(m.captureReply(f, '   ').captured, false);
  assert.equal(m.readDraft(f).status, 'pending');
  fs.rmSync(f, { force: true });
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
