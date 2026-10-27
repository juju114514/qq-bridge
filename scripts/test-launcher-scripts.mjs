// 启动器与守护脚本的结构契约测试。
//
// 为什么用"结构断言"而不是真跑：这两个脚本会**真的起进程、真的杀进程**，
// 放进审计套件里会互相打架（40 多个测试并行时端口/进程互相干扰），而且 CI 是 Linux。
// 所以这里只钉那些「改坏了会悄悄失效」的契约：
//   · 设计不变量 L6：不得启动/停止 SnowLuma（只允许探测端口）
//   · 退出码契约齐全（0/1/2/3/4/5 各有语义）
//   · 单实例锁 / 停止信号 / 退避重启 / ExitCode 归一化 都在
//   · 两个 .ps1 必须 UTF-8 带 BOM（PowerShell 5.1 读中文必需）
//   · 文档存在且被 README / AGENTS / COMPAT 引用（否则接手的人/AI 找不到）
//   · 环境里有 PowerShell 时，额外做一次真正的语法解析

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));

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

const LAUNCHER = 'start-bridge.ps1';
const SUPERVISOR = 'scripts/bridge-supervisor.ps1';

// ── 1. 存在性与编码 ───────────────────────────────────────────────────────
check('两个脚本都存在且是 UTF-8 带 BOM（PS 5.1 读中文必需）', () => {
  for (const rel of [LAUNCHER, SUPERVISOR]) {
    assert.ok(exists(rel), `缺 ${rel}`);
    const buf = fs.readFileSync(path.join(root, rel));
    assert.deepEqual([...buf.slice(0, 3)], [0xef, 0xbb, 0xbf], `${rel} 缺 UTF-8 BOM`);
  }
});

// ── 2. 设计不变量 L6：绝不代启/代停 SnowLuma ──────────────────────────────
check('SnowLuma 等待策略：快探后转慢速轮询，不放弃（2026-10-27 修）', () => {
  const text = read('scripts/bridge-supervisor.ps1');
  // 踩过的坑：开机自启时 SnowLuma 还没登录，旧实现等 600 秒就 exit 4，
  // 之后没有任何东西会再拉起守护 → 表现是「开机后机器人一直不回」。
  assert.match(text, /\$SnowlumaPollSeconds\s*=\s*60/, '应有慢速轮询间隔参数（默认 60 秒）');
  assert.match(text, /转入慢速轮询/, '超时后必须转慢速轮询，而不是直接退出');
  assert.match(text, /while \(\$true\)[\s\S]{0,400}Test-TcpPort 3000/, '慢速轮询里要探测端口，就绪后继续');
  // 显式要求旧行为时才允许 exit 4
  assert.match(text, /if \(\$SnowlumaPollSeconds -le 0\)[\s\S]{0,300}return \$false/, 'SnowlumaPollSeconds=0 时才退回"超时即放弃"');
  // L6 仍然成立：轮询里只能探测，不能启动
  assert.doesNotMatch(text, /Start-Process[^\n]*snowluma/i, '慢速轮询也不能启动 SnowLuma');
});

check('依赖自动启动是 opt-in（-StartDeps / launcher.autoStartDeps），且默认关闭', () => {
  const text = read(LAUNCHER);
  // 背景：双击桌面快捷方式最常见的失败是「SnowLuma 没起来 → 机器人不回」，
  // 用户看到的是"启动不起来"。所以 launcher 可以在启动前拉起依赖 —— 但必须显式开。
  assert.match(text, /\[switch\]\$StartDeps/, '启动器要有 -StartDeps');
  assert.match(text, /if \(\$autoDeps\) \{ Start-Deps \}/, '依赖启动必须挂在 $autoDeps 门禁下');
  assert.match(text, /launcher\.autoStartDeps/, '要支持从 config.json 读 autoStartDeps');
  assert.match(text, /已在运行，跳过/, '已在跑的依赖必须跳过（不能起第二份）');
  assert.match(text, /不安装、不停止|只启动，不安装不停止/, '必须写明只启动、不安装不停止（L6\'）');
  // 默认关闭：配置缺省时不应开启
  assert.match(text, /\$autoDeps = \$StartDeps\.IsPresent/, '默认值必须来自开关（缺省 false）');
  // 依赖启动只能出现在 launcher，守护里依然一行都不许有
  const sup = read(SUPERVISOR);
  assert.doesNotMatch(sup, /Start-Deps|autoStartDeps/, '守护脚本不能自己拉依赖（L6）');
});

check('守护脚本不启动、不停止 SnowLuma（只允许探测端口）', () => {
  const text = read(SUPERVISOR);
  // 允许出现"snowluma"这个词（注释/探测/提示），但不允许把它当可执行目标
  const forbidden = [
    /spawn|Start-Process[^\n]*snowluma/i,
    /launcher\.(bat|cmd)/i,
    /snowluma[^\n]*index\.mjs/i,
    /Stop-Process[^\n]*snowluma/i,
  ];
  for (const re of forbidden) {
    assert.doesNotMatch(text, re, `守护脚本里出现了"操作 SnowLuma"的代码：${re}`);
  }
  // 必须有"只探测"的痕迹，且提示用户自己启动
  assert.match(text, /Test-TcpPort 3000/, '应探测 :3000');
  assert.match(text, /Test-TcpPort 3001/, '应探测 :3001');
  assert.match(text, /不会代你启动|不代启|绝不代启/, '应明确写出"不代启 SnowLuma"');

  const launcher = read(LAUNCHER);
  assert.doesNotMatch(launcher, /Start-Process[^\n]*snowluma/i, '一键启动里不应启动 SnowLuma');
});

// ── 3. 退出码契约 ─────────────────────────────────────────────────────────
check('退出码契约齐全（0/1/2/3/4/5 各有语义且脚本里真的用）', () => {
  const text = read(SUPERVISOR);
  for (const code of ['exit 0', 'exit 1', 'exit 3', 'exit 4', 'exit 5']) {
    assert.ok(text.includes(code), `守护脚本没用到 ${code}`);
  }
  assert.match(text, /code -eq 2/, '必须区分"端口被占"的退出码 2');
  // 文档里也要有这张表
  const doc = read('docs/guides/LAUNCHER.md');
  for (const needle of ['退出码契约', '`0`', '`1`', '`2`', '`3`', '`4`', '`5`']) {
    assert.ok(doc.includes(needle), `LAUNCHER.md 缺「${needle}」`);
  }
});

// ── 4. 守护的关键机制 ─────────────────────────────────────────────────────
check('单实例锁 / 停止信号 / 退避重启 / ExitCode 归一化 都在', () => {
  const text = read(SUPERVISOR);
  assert.match(text, /supervisor\.lock/, '缺单实例锁');
  assert.match(text, /supervisor\.stop/, '缺停止信号文件');
  assert.match(text, /bridge\.pid/, '缺子进程 pid 文件');
  assert.match(text, /MaxFastCrashes/, '缺快速崩溃上限');
  assert.match(text, /Math\]::Pow\(2/, '缺指数退避');
  assert.match(text, /Min\(60/, '退避应封顶 60 秒');
  // ExitCode 在 PS 5.1 被强杀时会是 null：必须归一化成 -1 并按崩溃处理
  assert.match(text, /\$null -eq \$code/, '缺 ExitCode 的 null 归一化');
  assert.match(text, /code = -1/, '应把取不到的退出码记为 -1');
});

check('一键启动支持 start/stop/status/开机自启 四个动作', () => {
  const text = read(LAUNCHER);
  for (const sw of ['-Stop', '-Status', '-InstallStartup', '-RemoveStartup', '-Hidden']) {
    assert.ok(text.includes(sw), `缺 ${sw}`);
  }
  assert.match(text, /bridge-supervisor\.ps1/, '一键启动必须调用守护脚本');
  // 停止要"先礼后兵"：写停止信号 → 等待 → 兜底强杀
  assert.match(text, /stopping|停止信号|Set-Content -Path \$StopFile/, '停止应先写信号');
  assert.match(text, /15 秒|AddSeconds\(15\)/, '停止应带等待超时');
});

check('登录自启：注册后必须回读验证，且兜底不用 .bat（中文路径会被 cmd 代码页吃掉）', () => {
  const text = read(LAUNCHER);
  // 1) 注册后回读：Register-ScheduledTask 是非终止错误，不加 Stop + 回读就会"失败还报 OK"
  assert.match(text, /Register-ScheduledTask[\s\S]{0,400}-ErrorAction Stop/, '注册计划任务必须 -ErrorAction Stop');
  assert.match(text, /Get-ScheduledTask -TaskName \$TaskName -ErrorAction Stop/, '注册后必须回读任务');
  // 2) 兜底用 .vbs（UTF-16LE），不用 .bat
  assert.match(text, /qq-bridge-supervisor\.vbs/, '启动文件夹兜底应写 .vbs');
  assert.match(text, /-Encoding Unicode/, '.vbs 必须写成 UTF-16LE（中文路径要靠它）');
  assert.doesNotMatch(text, /qq-bridge-supervisor\.bat['"]\s*-Value/, '不应再把 .bat 作为兜底（编码坑）');
  // 3) 引号用 Chr(34) 拼，不在 VBS 里做 "" 转义（少一个引号就"未结束的字符串常量"）
  assert.match(text, /Chr\(34\)/, 'vbs 引号应用 Chr(34) 拼');
  assert.doesNotMatch(text, /Replace\('"', '""'\)/, '不应再用 "" 转义拼 vbs');
});

check('文档说明了两种登录自启实现，以及不能和旧 bridge watchdog 共存', () => {
  const doc = read('docs/guides/LAUNCHER.md');
  assert.match(doc, /启动文件夹/, '应说明启动文件夹兜底');
  assert.match(doc, /Chr\(34\)/, '应记录 vbs 引号写法');
  assert.match(doc, /watchdog-bridge/, '应提醒旧 bridge watchdog 要删掉（否则抢 3100）');
});

// ── 5. PowerShell 语法（有 PowerShell 才跑）────────────────────────────────
check('PowerShell 能解析这两个脚本（无 PowerShell 环境时跳过）', () => {
  const candidates = ['pwsh', 'powershell'];
  let exe = null;
  for (const c of candidates) {
    try {
      execFileSync(c, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { stdio: 'ignore' });
      exe = c;
      break;
    } catch { /* 试下一个 */ }
  }
  if (!exe) {
    console.log('       （环境里没有 PowerShell，跳过语法解析）');
    return;
  }
  for (const rel of [LAUNCHER, SUPERVISOR]) {
    const script = [
      `$files = @(${JSON.stringify(path.join(root, rel))})`,
      'foreach ($f in $files) {',
      '  $err = $null',
      '  [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$err)',
      '  if ($err -and $err.Count -gt 0) { $err | ForEach-Object { Write-Output ("L" + $_.Extent.StartLineNumber + ": " + $_.Message) }; exit 1 }',
      '}',
      'exit 0',
    ].join('\n');
    try {
      execFileSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'pipe' });
    } catch (error) {
      const out = String(error.stdout ?? '') + String(error.stderr ?? '');
      assert.fail(`${rel} PowerShell 解析失败：${out.trim().slice(0, 300)}`);
    }
  }
});

// ── 6. 文档与索引 ─────────────────────────────────────────────────────────
check('LAUNCHER.md 覆盖关键章节', () => {
  const doc = read('docs/guides/LAUNCHER.md');
  for (const needle of [
    '三层链条', 'SnowLuma 不在这条链上', '退出码契约', '运行态文件',
    '启动顺序', '排障速查', '给接手的 AI',
  ]) {
    assert.ok(doc.includes(needle), `LAUNCHER.md 缺「${needle}」`);
  }
});

check('README / AGENTS / COMPAT 都能找到启动入口', () => {
  assert.match(read('README.md'), /start-bridge\.ps1/, 'README 没提一键启动');
  assert.match(read('AGENTS.md'), /start-bridge\.ps1/, 'AGENTS 没提一键启动（AI 找不到入口）');
  const compat = read('COMPAT.md');
  assert.match(compat, /start-bridge\.ps1/, 'COMPAT 没提一键启动');
  assert.match(compat, /LAUNCHER\.md/, 'COMPAT 应指向 LAUNCHER.md');
});

check('MIGRATION.md 提到新机器用哪个入口启动', () => {
  assert.match(read('docs/guides/MIGRATION.md'), /start-bridge\.ps1|deploy\/install-server\.sh/,
    '迁移清单应说明新机器怎么启动');
});

// ── 回归：.ps1 必须**恰好一个** BOM ───────────────────────────────────────
// 踩过的坑（2026-10-28）：用脚本给已有 BOM 的 .ps1 再补一次 BOM，变成 EF BB BF EF BB BF，
// PowerShell 5.1 于是把首行 `#Requires` 解析坏掉，连 param() 块都报「赋值表达式无效」。
check('所有 .ps1 都恰好一个 UTF-8 BOM（不能是双 BOM）', () => {
  const dirs = ['scripts', '.'];
  const found = [];
  for (const dir of dirs) {
    const abs = dir === '.' ? root : path.join(root, dir);
    for (const name of fs.readdirSync(abs)) {
      if (!/\.ps1$/i.test(name)) continue;
      found.push(path.join(abs, name));
    }
  }
  assert.ok(found.length >= 3, `应扫到多个 .ps1，实际 ${found.length}`);
  for (const file of found) {
    const head = fs.readFileSync(file).subarray(0, 6);
    const isBom = head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF;
    const isDouble = isBom && head[3] === 0xEF && head[4] === 0xBB && head[5] === 0xBF;
    assert.ok(isBom, `${path.relative(root, file)} 缺 BOM（PowerShell 5.1 会把中文读成乱码）`);
    assert.ok(!isDouble, `${path.relative(root, file)} 是**双 BOM**，会让首行 #Requires 解析失败`);
  }
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
