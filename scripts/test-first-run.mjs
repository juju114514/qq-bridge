// first-run.ps1（首次运行引导）的契约测试。
//
// 为什么值得单独钉：这个脚本会 **装依赖、写 config.json、装 DSH preset、可能启动进程**。
// 一旦它「静默做错事」，用户不会发现——比如覆盖了他手写过的 config.json，
// 或者顺手把 SnowLuma 也启动了（那是设计不变量 L6 的边界）。
//
// 所以分两层：
//   · 结构断言（任何平台都跑）：BOM、参数齐全、禁止模式（不代启 SnowLuma / 不覆盖 config）、
//     每一步都指向权威工具与文档锚点
//   · 行为断言（有 PowerShell 才跑）：`-DryRun` 在真实仓库上成功、在「空仓库」上以 1 退出
//     且不会偷偷创建 config.json

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

const SCRIPT = 'scripts/first-run.ps1';

// ── 1. 存在性与编码 ───────────────────────────────────────────────────────
check('first-run.ps1 存在且是 UTF-8 带 BOM', () => {
  assert.ok(fs.existsSync(path.join(root, SCRIPT)), `缺 ${SCRIPT}`);
  const buf = fs.readFileSync(path.join(root, SCRIPT));
  assert.deepEqual([...buf.slice(0, 3)], [0xef, 0xbb, 0xbf], 'PS 5.1 读中文需要 BOM');
});

// ── 2. 参数与步骤 ─────────────────────────────────────────────────────────
check('支持 DryRun / SkipNpm / SkipPreset / Start / NonInteractive', () => {
  const text = read(SCRIPT);
  for (const sw of ['-DryRun', '-SkipNpm', '-SkipPreset', '-Start', '-NonInteractive']) {
    assert.ok(text.includes(sw), `缺参数 ${sw}`);
  }
  // 五个步骤都要有编号，且各自指向权威工具
  for (const n of ['步骤 1/5', '步骤 2/5', '步骤 3/5', '步骤 4/5', '步骤 5/5']) {
    assert.ok(text.includes(n), `缺 ${n}`);
  }
  assert.match(text, /preflight\.mjs/, '步骤 1 必须调用 preflight');
  assert.match(text, /npm install|npmCmd/, '步骤 2 必须走 npm install');
  assert.match(text, /setup-dsh\.mjs/, '步骤 4 必须调用 setup-dsh');
  assert.match(text, /start-bridge\.ps1/, '步骤 5 必须走 start-bridge.ps1');
});

// ── 3. 禁止行为（这两条是设计不变量）─────────────────────────────────────
check('不启动 / 不安装 SnowLuma（L6）', () => {
  const text = read(SCRIPT);
  const forbidden = [
    /Start-Process[^\n]*snowluma/i,
    /launcher\.(bat|cmd)/i,
    /snowluma[^\n]*index\.mjs/i,
    /Stop-Process[^\n]*snowluma/i,
  ];
  for (const re of forbidden) assert.doesNotMatch(text, re, `出现操作 SnowLuma 的代码：${re}`);
  // 但必须明确告诉用户「SnowLuma 要自己启」
  assert.match(text, /SnowLuma 必须自己启动|不代启/, '应提示 SnowLuma 需自行启动');
});

check('绝不覆盖已存在的 config.json', () => {
  const text = read(SCRIPT);
  // 必须存在「已存在 → 不动」的分支，且 Copy-Item 只出现在 else 分支里
  assert.match(text, /if \(Test-Path \$cfgPath\)/, '缺「config.json 已存在」的判断');
  assert.match(text, /已存在，\*\*不做任何覆盖\*\*/, '必须显式声明不覆盖');
  const copyLine = text.split('\n').find((l) => /Copy-Item \$examplePath \$cfgPath/.test(l));
  assert.ok(copyLine, '缺「从 example 复制」的那一步');
});

check('失败时必须给出文档锚点（不是只说"失败了"）', () => {
  const text = read(SCRIPT);
  const anchors = (text.match(/TROUBLESHOOTING\.md#/g) ?? []).length;
  assert.ok(anchors >= 6, `文档锚点太少（${anchors} 个）：失败时用户不知道看哪`);
  assert.match(text, /FRESH-INSTALL\.md/, '应指向全新机器清单');
  assert.match(text, /Next\(/, '应使用统一的「下一步」输出');
});

// ── 4. 行为（有 PowerShell 才跑）──────────────────────────────────────────
function findPowerShell() {
  for (const exe of ['pwsh', 'powershell']) {
    try {
      execFileSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { stdio: 'ignore' });
      return exe;
    } catch { /* 下一个 */ }
  }
  return null;
}

await checkAsync('DryRun 在真实仓库上成功且不改动 config.json', async () => {
  const exe = findPowerShell();
  if (!exe) { console.log('       （环境里没有 PowerShell，跳过行为断言）'); return; }
  const cfg = path.join(root, 'config.json');
  const hadCfg = fs.existsSync(cfg);
  const before = hadCfg ? fs.readFileSync(cfg) : null;
  const out = execFileSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, SCRIPT), '-DryRun'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
  });
  assert.match(out, /DryRun/, '应进入 DryRun 模式');
  assert.match(out, /步骤 1\/5/, '应打印步骤 1');
  const after = fs.existsSync(cfg) ? fs.readFileSync(cfg) : null;
  assert.deepEqual(after, before, 'DryRun 不得改动 config.json');
});

await checkAsync('空仓库里 DryRun 以非 0 退出，且不会偷偷创建 config.json', async () => {
  const exe = findPowerShell();
  if (!exe) { console.log('       （环境里没有 PowerShell，跳过行为断言）'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-firstrun-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(root, 'src', 'bridge.js'), path.join(tmp, 'src', 'bridge.js'));
    fs.copyFileSync(path.join(root, 'scripts', 'preflight.mjs'), path.join(tmp, 'scripts', 'preflight.mjs'));
    fs.copyFileSync(path.join(root, 'scripts', firstRunName()), path.join(tmp, 'scripts', firstRunName()));
    fs.copyFileSync(path.join(root, 'package.json'), path.join(tmp, 'package.json'));
    fs.copyFileSync(path.join(root, 'config.example.json'), path.join(tmp, 'config.example.json'));

    let code = 0;
    let out = '';
    try {
      out = execFileSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(tmp, 'scripts', firstRunName()), '-DryRun', '-Root', tmp], {
        cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
      });
    } catch (error) {
      code = error.status ?? 1;
      out = String(error.stdout ?? '') + String(error.stderr ?? '');
    }
    assert.notEqual(code, 0, '环境不完整时 DryRun 应返回非 0');
    assert.match(out, /config\.json/, '输出应提到 config.json 缺失');
    assert.equal(fs.existsSync(path.join(tmp, 'config.json')), false, 'DryRun 绝不能创建 config.json');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function firstRunName() { return 'first-run.ps1'; }

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
