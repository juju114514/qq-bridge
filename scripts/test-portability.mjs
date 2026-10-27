// 「换台机器还能不能跑」的静态审计。
//
// 为什么单独一套：迁移失败从来不是语法错，而是**某台机器上恰好成立的前提**——
// 硬编码盘符、只有 Windows 有的可执行、示例配置里混进本机值、备份格式绑机器。
// 这些都不会让任何功能测试变红，只会在用户换机那天一次性爆出来。
//
// 检查项：
//   1. src/ 与 scripts/*.mjs 里不得出现硬编码盘符路径（D:\ / C:/Users/…）
//   2. config.example.json 不得含机器相关值（真实 QQ 号、盘符、随机端口、本机工具路径）
//   3. spawn 系统可执行的地方必须有平台闸门（powershell.exe 在 Linux 上不存在）
//   4. DPAPI 备份的跨机限制必须在文档里写明（否则用户以为备份能带走）
//   5. state/ 里机器相关的产物必须被 .gitignore 排除（sessionId / 令牌层面）

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

// 只扫**运行时会跑的 Node 代码**：src/ 与 scripts/*.mjs。
//   · 不扫 .ps1 —— 它们是 Windows 专属运维工具，里面出现 D:\DEEPSEEK、卡巴斯基安装路径
//     是合理的（那些脚本本来只在 Windows 上有意义）；
//   · 不扫 test-*.mjs / *-fixture.mjs / privacy-scan.mjs —— 里面的盘符是"样例路径"，
//     其用途恰恰是验证"外部绝对路径会被拒"。
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'state', 'logs', 'audio'].includes(entry.name)) continue;
      walk(full, out);
    } else if (/\.(m?js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const SKIP = (rel) => /(^|\/)test-[^/]*\.mjs$/.test(rel)
  || /-fixture\.mjs$/.test(rel)
  || rel === 'scripts/privacy-scan.mjs'
  || rel === 'scripts/test-portability.mjs';

// ── 1. 硬编码盘符路径 ─────────────────────────────────────────────────────
// 白名单：测试 fixture / 断言里的"样例路径"（它们本来就在验证"外部绝对路径被拒"）
const ALLOWED = new Set([
  'scripts/console-ui-fixture.mjs',
  'scripts/test-audit-bridge.mjs',
  'scripts/test-voice.mjs',
  'scripts/test-voice-gui.mjs',
]);
check('src/ 与 scripts/ 没有硬编码盘符路径（换机器立刻失效）', () => {
  const hits = [];
  for (const file of walk(root)) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (ALLOWED.has(rel) || SKIP(rel)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      // 只找**代码里**的盘符（注释里举例、文档字符串不算，但这类很容易混进来，先一律报）
      const m = /['"`][A-Za-z]:[\\/]{1,2}/.exec(line);
      if (m) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
    }
  }
  assert.deepEqual(hits, [], `发现硬编码盘符（共 ${hits.length} 处）:\n       ${hits.join('\n       ')}`);
});

// ── 2. 示例配置不得含本机值 ────────────────────────────────────────────────
check('config.example.json 不含机器相关值', () => {
  const cfg = JSON.parse(read('config.example.json'));
  const json = JSON.stringify(cfg);
  assert.doesNotMatch(json, /[A-Za-z]:\\\\/, '示例配置里出现盘符路径');
  assert.equal(cfg.ownerQQ, null, 'ownerQQ 应为 null（使用者自己填）');
  assert.equal(cfg.sessionCwd ?? '', '', 'sessionCwd 不应预设本机目录');
  assert.equal(cfg.dsh?.baseUrl, 'http://127.0.0.1:3080', `dsh.baseUrl 应为稳定的回环默认值，实际 ${cfg.dsh?.baseUrl}`);
  assert.equal(cfg.socialV2?.voice?.ffmpegPath ?? '', '', 'ffmpegPath 不应预设本机路径');
  assert.equal(cfg.paths?.tools ?? '', '', 'paths.tools 不应预设本机目录');
  // 默认人设必须是能解析到的稳定名（不能带「（已测试）」这种文件状态后缀）
  assert.equal(cfg.role?.defaultName, '小鲸鱼', `role.defaultName 应为稳定名，实际 ${cfg.role?.defaultName}`);
});

// ── 3. 系统可执行必须有平台闸门 ────────────────────────────────────────────
check('spawn powershell.exe 的地方都有平台闸门', () => {
  const files = ['src/bridge.js', 'src/api/socialV2-send.js'];
  for (const rel of files) {
    const text = read(rel);
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
      if (!line.includes("spawn('powershell.exe'")) continue;
      // 往前 25 行内必须出现 platform 判定（闸门写在 spawn 之前）
      const window = lines.slice(Math.max(0, i - 25), i).join('\n');
      assert.match(window, /process\.platform !== 'win32'/,
        `${rel}:${i + 1} 的 powershell.exe 调用前没有平台闸门（换到 Linux 会 ENOENT）`);
    }
  }
});

// ── 4. 停机/迁移相关的文档必须存在 ─────────────────────────────────────────
check('文档写明了 DPAPI 备份不能跨机解密', () => {
  const ops = read('docs/OPERATIONS.md');
  assert.match(ops, /DPAPI/, 'OPERATIONS.md 提到 DPAPI');
  assert.match(ops, /跨机|另一台|换机/, 'OPERATIONS.md 必须说明 DPAPI 绑定用户+机器、跨机不可解密');
});

check('存在「换机器迁移清单」', () => {
  const p = path.join(root, 'docs', 'guides', 'MIGRATION.md');
  assert.ok(fs.existsSync(p), '缺 docs/guides/MIGRATION.md');
  const text = fs.readFileSync(p, 'utf8');
  for (const needle of [
    '不要复制',        // 哪些东西不能带走（sessions / 令牌）
    'DPAPI',           // 备份格式限制
    'DSH',             // 端口/凭据要重配
    'paths.tools',     // 外部工具路径要重配
    '按这个顺序检错',
  ]) {
    assert.ok(text.includes(needle), `MIGRATION.md 缺「${needle}」`);
  }
});

// ── 5. 机器相关运行态不得进仓库 ────────────────────────────────────────────
check('.gitignore 排除了机器相关的运行态', () => {
  const gi = read('.gitignore');
  for (const needle of ['state/', 'logs/', 'audio/', 'node_modules/']) {
    assert.ok(gi.includes(needle), `.gitignore 缺 ${needle}`);
  }
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
