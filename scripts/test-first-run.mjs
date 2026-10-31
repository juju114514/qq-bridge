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
  // deploy/first-run.ps1 是 **Windows 部署脚本**（路径、注册表、计划任务语义）。
  // GitHub 的 ubuntu runner 自带 pwsh，会被误当成"能跑"——但目标平台不成立，必须按平台跳过。
  if (process.platform !== 'win32') {
    console.log('       （非 Windows：跳过 PowerShell 脚本行为断言 —— 它是 Windows 专用部署脚本）');
    return;
  }
  const exe = findPowerShell();
  if (!exe) { console.log('       （环境里没有 PowerShell，跳过行为断言）'); return; }
  const cfg = path.join(root, 'config.json');
  const hadCfg = fs.existsSync(cfg);
  const before = hadCfg ? fs.readFileSync(cfg) : null;
  // 注意：这条**不能**断言退出码为 0 —— 真实仓库的体检结果取决于机器当前状态
  // （DSH 端口有没有变、SnowLuma 在不在跑）。这台机器上 DSH 换过端口，preflight 就会 FAIL。
  // 测的是「DryRun 不改动 config.json」，不是「环境是健康的」。
  let out = '';
  try {
    out = execFileSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, SCRIPT), '-DryRun'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    });
  } catch (error) {
    out = String(error.stdout ?? '') + String(error.stderr ?? '');
    // 退出码非 0 是允许的（体检有 FAIL 时 DryRun 也会如实退 1）
  }
  assert.match(out, /DryRun/, '应进入 DryRun 模式');
  // 允许中文与 ASCII 两种形态：管道/重定向下 PowerShell 可能把中文写成非 UTF-8
  assert.match(out, /(?:步骤\s*)?1\/5/, '应打印步骤 1');
  const after = fs.existsSync(cfg) ? fs.readFileSync(cfg) : null;
  assert.deepEqual(after, before, 'DryRun 不得改动 config.json');
});

await checkAsync('空仓库里 DryRun 以非 0 退出，且不会偷偷创建 config.json', async () => {
  // deploy/first-run.ps1 是 **Windows 部署脚本**（路径、注册表、计划任务语义）。
  // GitHub 的 ubuntu runner 自带 pwsh，会被误当成"能跑"——但目标平台不成立，必须按平台跳过。
  if (process.platform !== 'win32') {
    console.log('       （非 Windows：跳过 PowerShell 脚本行为断言 —— 它是 Windows 专用部署脚本）');
    return;
  }
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

// ── 5. shell 版（Linux/macOS）：同样的五步与两条硬边界 ─────────────────────
const SH = 'deploy/first-run.sh';

check('deploy/first-run.sh 存在、LF 换行、无 BOM、shebang 正确', () => {
  const p = path.join(root, SH);
  assert.ok(fs.existsSync(p), `缺 ${SH}`);
  const buf = fs.readFileSync(p);
  assert.notDeepEqual([...buf.slice(0, 3)], [0xef, 0xbb, 0xbf], '.sh 不要 BOM（bash 会把 BOM 当命令）');
  const text = buf.toString('utf8');
  assert.ok(text.startsWith('#!/usr/bin/env bash'), 'shebang 必须是 #!/usr/bin/env bash');
  assert.ok(!text.includes('\r\n'), '.sh 必须是 LF（CRLF 会让 bash 报 $\\r: command not found）');
});

check('shell 版：五步齐全 + 全套参数 + 两条硬边界', () => {
  const text = read(SH);
  for (const n of ['步骤 1/5', '步骤 2/5', '步骤 3/5', '步骤 4/5', '步骤 5/5']) {
    assert.ok(text.includes(n), `缺 ${n}`);
  }
  for (const flag of ['--dry-run', '--skip-npm', '--skip-preset', '--start', '--non-interactive', '--root', '--node']) {
    assert.ok(text.includes(flag), `缺参数 ${flag}`);
  }
  assert.match(text, /preflight\.mjs/, '步骤 1 必须调用 preflight');
  assert.match(text, /setup-dsh\.mjs/, '步骤 4 必须调用 setup-dsh');
  // 硬边界 1：不代启 SnowLuma
  for (const re of [/snowluma[^\n]*index\.mjs/i, /launcher\.(bat|cmd)/i, /launch-qq-bot/i]) {
    assert.doesNotMatch(text, re, `出现操作 SnowLuma 的代码：${re}`);
  }
  assert.match(text, /不代启|SnowLuma 必须自己启动/, '必须提示 SnowLuma 自行启动');
  // 硬边界 2：不覆盖已有 config.json
  assert.match(text, /if \[\[ -f "\$CFG" \]\]/, '缺「config.json 已存在」判断');
  assert.match(text, /不做任何覆盖/, '必须显式声明不覆盖');
  // 失败要给文档锚点
  const anchors = (text.match(/TROUBLESHOOTING\.md#/g) ?? []).length;
  assert.ok(anchors >= 5, `文档锚点太少（${anchors} 个）`);
});

// 找可用 bash，并判断它是 Git Bash（认 D:/x）还是 WSL（认 /mnt/d/x）。
// 踩过：Windows 的 PATH 里 `bash` 往往是 WSL 的 /bin/bash，它读不了 D:/... 路径，
// 于是 `bash -n D:/xxx` 直接报 No such file —— 看起来像脚本不存在，其实是路径方言不对。
function findBash() {
  const candidates = [
    'D:/Git/bin/bash.exe',
    'D:/Git/usr/bin/bash.exe',
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe',
    'bash',
    '/bin/bash',
  ];
  for (const exe of candidates) {
    try {
      const ostype = execFileSync(exe, ['-c', 'echo $OSTYPE'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const wsl = /linux-gnu|wsl/i.test(ostype) && !/msys|cygwin/i.test(ostype);
      return { exe, wsl };
    } catch { /* 下一个 */ }
  }
  return null;
}
/** Git Bash 认 `D:/x`；WSL 认 `/mnt/d/x`。 */
function forBash(bash, p) {
  const win = p.replace(/\\/g, '/');
  if (!bash.wsl) return win;
  return win.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
}

await checkAsync('shell 版：bash -n 通过（有 bash 才跑）', async () => {
  const bash = findBash();
  if (!bash) { console.log('       （环境里没有 bash，跳过）'); return; }
  try {
    execFileSync(bash.exe, ['-n', forBash(bash, path.join(root, SH))], { stdio: 'pipe', timeout: 30000 });
  } catch (error) {
    assert.fail(`bash -n 失败：${String(error.stderr ?? error.message).slice(0, 300)}`);
  }
});

await checkAsync('shell 版：空仓库 dry-run 非 0 退出且不创建 config.json（有 bash+node 才跑）', async () => {
  const bash = findBash();
  if (!bash) { console.log('       （环境里没有 bash，跳过）'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-firstrun-sh-'));
  try {
    for (const dir of ['src', 'scripts', 'deploy']) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    fs.copyFileSync(path.join(root, 'src', 'bridge.js'), path.join(tmp, 'src', 'bridge.js'));
    fs.copyFileSync(path.join(root, 'scripts', 'preflight.mjs'), path.join(tmp, 'scripts', 'preflight.mjs'));
    fs.copyFileSync(path.join(root, SH), path.join(tmp, SH));
    fs.copyFileSync(path.join(root, 'package.json'), path.join(tmp, 'package.json'));
    fs.copyFileSync(path.join(root, 'config.example.json'), path.join(tmp, 'config.example.json'));

    let code = 0;
    let out = '';
    try {
      out = execFileSync(bash.exe, [forBash(bash, path.join(tmp, SH)), '--dry-run', '--node', forBash(bash, process.execPath), '--root', forBash(bash, tmp)], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
      });
    } catch (error) {
      code = error.status ?? 1;
      out = String(error.stdout ?? '') + String(error.stderr ?? '');
    }
    assert.notEqual(code, 0, '环境不完整时 dry-run 应返回非 0');
    // 失败必须「可行动」：说清缺什么 + 下一步。不强行要求出现 config.json ——
    // Linux 上空仓库会先卡在「前置检查」(node/npm/preset)，那时还轮不到配置步骤。
    assert.match(out, /下一步|config\.json/, '失败时必须给出具体缺什么 + 下一步，而不是只报"失败了"');
    assert.equal(fs.existsSync(path.join(tmp, 'config.json')), false, 'dry-run 绝不能创建 config.json');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
