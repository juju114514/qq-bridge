// 兼容契约的「文档 ↔ 代码」一致性检查。
//
// 由来：这份仓库要交给**别人的机器**跑（不同 Node / 不同 DSH 版本 / 不同 OneBot 实现）。
// 最坏的情况不是代码错，而是「COMPAT.md 写着支持 X，代码其实用的是 Y」——
// 别人照着文档适配，撞墙后开始怀疑一切。
//
// 所以把 COMPAT.md / compat.json 里的契约表当**可执行断言**：两边必须对得上。
//
// 检查项：
//   1. compat.json 里列的 OneBot 动作，代码里真的都在用；反之亦然（没人用的别写进契约）
//   2. compat.json 不应再出现已移除的依赖（@snowluma/sdk / mcp、postinstall 补丁）
//   3. COMPAT.md 必须存在且覆盖关键章节（硬契约 / 适配步骤 / 失败特征 / 不该做的事）
//   4. 平台能力表与实际闸门一致：非 Windows 上语音类接口必须被挡住（源码断言）
//   5. AGENTS.md 必须指向 COMPAT.md（否则接手的人/AI 看不到）

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

const compat = JSON.parse(read('compat.json'));

// ── 1. 动作清单：文档 ↔ 代码 ───────────────────────────────────────────────
check('compat.json 里的 OneBot 动作与代码一致', () => {
  const declared = new Set(compat.contracts?.onebotActions ?? []);
  assert.ok(declared.size >= 20, `契约里只有 ${declared.size} 个动作，疑似漏写`);

  // 扫源码里所有「发动作」的位置：.raw('x' / .call('x' / .request('x' / onebotHttpAction('x'
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) files.push(full);
    }
  })(path.join(root, 'src'));
  const used = new Set();
  const re = /(?:\.raw|\.call|\.request|onebotHttpAction|onebotSend)\(\s*['"]([a-z_0-9]+)['"]/g;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) used.add(m[1]);
  }
  // 三元写法（like_qzone / unlike_qzone）正则抓不到，但已在契约里显式声明，这里单独补
  const ternary = read('src/api/socialV2-qzone.js');
  if (/like_qzone/.test(ternary)) { used.add('like_qzone'); used.add('unlike_qzone'); }

  const missingInDoc = [...used].filter((a) => !declared.has(a)).sort();
  const missingInCode = [...declared].filter((a) => !used.has(a)).sort();
  assert.deepEqual(missingInDoc, [], `代码在用、但 compat.json 没声明：${missingInDoc.join(', ')}`);
  assert.deepEqual(missingInCode, [], `compat.json 声明了、但代码没用到：${missingInCode.join(', ')}`);
});

// ── 2. 已移除的依赖不得回到契约里 ──────────────────────────────────────────
check('compat.json 不再描述已移除的 @snowluma/* 依赖', () => {
  const raw = read('compat.json');
  assert.doesNotMatch(raw, /snowlumaSdk/, 'testedWith/requires 里还有 snowlumaSdk');
  assert.doesNotMatch(raw, /patch-snowluma-sdk/, 'notes 里还提 postinstall 补丁');
  for (const dep of compat.notDependsOn ?? []) {
    assert.ok(/@snowluma\//.test(dep), `notDependsOn 里出现意外条目：${dep}`);
  }
  const pkg = JSON.parse(read('package.json'));
  for (const dep of compat.notDependsOn ?? []) {
    assert.equal(pkg.dependencies?.[dep], undefined, `package.json 里又出现了 ${dep}`);
  }
});

// ── 3. COMPAT.md 结构 ──────────────────────────────────────────────────────
check('COMPAT.md 覆盖关键章节', () => {
  const md = read('COMPAT.md');
  for (const needle of ['硬契约', '适配步骤', '失败特征', '不该做的事', 'compat.json', '需要支持的动作']) {
    assert.ok(md.includes(needle), `COMPAT.md 缺「${needle}」`);
  }
  assert.match(md, /src\/onebot-ws\.js/, 'COMPAT.md 应指明唯一的传输适配层是 src/onebot-ws.js');
});

// ── 4. 平台能力表与实际闸门一致 ────────────────────────────────────────────
check('平台能力表写「非 Windows 不支持语音」，代码里确有此闸门', () => {
  const linux = compat.platforms?.linux;
  assert.ok(linux, 'compat.json 缺 platforms.linux');
  assert.ok((linux.notAvailable ?? []).some((x) => /语音/.test(x)), 'linux.notAvailable 应包含「语音」');
  const send = read('src/api/socialV2-send.js');
  const guards = (send.match(/process\.platform !== 'win32'/g) ?? []).length;
  assert.ok(guards >= 2, `socialV2-send.js 里只有 ${guards} 处平台闸门（say/sing 至少各一处）`);
  const bridge = read('src/bridge.js');
  assert.match(bridge, /process\.platform !== 'win32' && !process\.env\.QQBOT_SONG_SCRIPT/,
    '点歌缺少平台闸门（QQBOT_SONG_SCRIPT 特例）');
});

// ── 4b. provider 验证状态必须如实标注（不许把未测试写成已支持）───────────
check('provider 表：DeepSeek 标已测，其他 provider 必须标 tested:false', () => {
  const provs = compat.providers ?? {};
  assert.ok(provs['deepseek-official'], 'compat.json 缺 deepseek-official 条目');
  assert.equal(provs['deepseek-official'].tested, true, 'DeepSeek 官方应标 tested:true');
  const others = Object.entries(provs).filter(([k]) => !k.startsWith('$') && k !== 'deepseek-official');
  assert.ok(others.length >= 1, '至少应有 openai 这条「已接入未测试」的登记');
  for (const [id, v] of others) {
    assert.equal(v.tested, false, `${id} 目前未经本仓库测试，必须标 tested:false`);
    assert.ok(String(v.note ?? '').length > 20, `${id} 的 note 要写清未测试的具体含义`);
  }
});

check('MODELS.md 存在，且把 GPT 明确标成「未测试」', () => {
  const p = path.join(root, 'docs', 'guides', 'MODELS.md');
  assert.ok(fs.existsSync(p), '缺 docs/guides/MODELS.md');
  const doc = fs.readFileSync(p, 'utf8');
  assert.match(doc, /未测试/, 'MODELS.md 必须出现「未测试」字样');
  assert.match(doc, /openai|GPT/i, 'MODELS.md 必须写明 OpenAI / GPT');
  assert.match(doc, /apiKeyEnv|API Key/, 'MODELS.md 必须说明 key 走环境变量、不要入库');
  assert.match(doc, /estimated/, 'MODELS.md 必须说明计价是兜底估算');
});

check('文档与启动日志都如实提示「非 DeepSeek provider 未验证」', () => {
  const readme = read('README.md');
  assert.match(readme, /MODELS\.md/, 'README 应链接 MODELS.md');
  assert.match(readme, /未测试/, 'README 必须写明未测试');
  const en = read('README.en.md');
  assert.match(en, /NOT tested|untested/i, 'README.en 必须写明 untested');
  const bridge = read('src/bridge.js');
  assert.match(bridge, /configuredProvider !== 'deepseek-official'/, '桥接启动时应检测非 DeepSeek provider');
  assert.match(bridge, /未经本仓库验证/, '启动日志要如实标注未验证');
});

// ── 5. AI 入口必须能找到这份手册 ───────────────────────────────────────────
check('AGENTS.md 指向 COMPAT.md', () => {
  const agents = read('AGENTS.md');
  assert.match(agents, /COMPAT\.md/, 'AGENTS.md 没提 COMPAT.md —— 接手的人/AI 找不到契约表');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
