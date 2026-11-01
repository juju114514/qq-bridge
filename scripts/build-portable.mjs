// 打包「绿色整合包」（0.4.120）
//
// 目的：普通用户不需要装 Node、不需要开命令行 —— 解压 → 双击「启动.cmd」就能跑。
// 组成：
//   node.exe            ← 自带运行时（约 89 MB，单文件即可用）
//   app\                ← 源码（src/public/scripts + package.json 等）
//   config.json         ← 从 config.example.json 复制一份
//   state\              ← 空目录，首次启动自动写令牌
//   启动.cmd / 启动-静默.vbs / 说明.txt
//
// 用法：
//   node scripts/build-portable.mjs
//   node scripts/build-portable.mjs --node <node.exe 路径>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const distDir = path.join(ROOT, 'dist');
// 先在系统临时目录拼装，最后整体移动：避免构建中间态被仓库里的守卫（md-links / privacy）扫到
const stage = path.join(os.tmpdir(), `qqb-portable-${process.pid}`);

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function findNode() {
  const explicit = arg('node');
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [
    process.execPath,                                                   // 当前跑脚本的 node
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
    path.join(process.env.ProgramFiles || '', 'nodejs', 'node.exe')
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error('找不到 node.exe，用 --node <路径> 指定');
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const nodeExe = findNode();

console.log(`  版本 ${version}`);
console.log(`  Node ${nodeExe}`);

// ── 清空 stage ──
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'state'), { recursive: true });

// ── node.exe ──
fs.copyFileSync(nodeExe, path.join(stage, 'node.exe'));
const nodeLicense = path.join(path.dirname(nodeExe), 'LICENSE');
if (fs.existsSync(nodeLicense)) fs.copyFileSync(nodeLicense, path.join(stage, 'NODE-LICENSE.txt'));

// ── 应用文件 ──
const APP_FILES = ['src', 'public', 'scripts', 'package.json', 'compat.json', 'config.example.json', 'README.md', 'QUICKSTART.md', 'CHANGELOG.md', 'LICENSE'];
for (const rel of APP_FILES) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) continue;
  const dst = path.join(stage, rel);
  fs.cpSync(src, dst, { recursive: true });
}

// ── 依赖（node_modules）──
// pnpm 的 node_modules 全是符号链接 → 直接 copy 要么断链、要么 dereference 后 300MB。
// 这里做「扁平化」：把 .pnpm 里每个包的真实目录拷到顶层 node_modules/<name>，
// 得到的结构和 npm 装出来的一样，解压到任何机器都能直接跑。
function flattenNodeModules(srcNm, dstNm) {
  fs.mkdirSync(dstNm, { recursive: true });
  const store = path.join(srcNm, '.pnpm');
  const placed = new Set();
  let copied = 0;

  const copyPkg = (realDir, pkgName) => {
    if (!fs.existsSync(realDir)) return false;
    const dst = path.join(dstNm, ...pkgName.split('/'));
    if (fs.existsSync(dst)) return true;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(realDir, dst, { recursive: true, dereference: true });
    copied += 1;
    return true;
  };

  // 1) 先放直接依赖（从顶层符号链接解析真实位置）
  for (const entry of fs.readdirSync(srcNm, { withFileTypes: true })) {
    if (entry.name === '.pnpm' || entry.name === '.bin' || entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink() || entry.isDirectory()) {
      const p = path.join(srcNm, entry.name);
      const target = entry.isSymbolicLink() ? fs.realpathSync(p) : p;
      if (entry.name.startsWith('@')) {
        for (const sub of fs.readdirSync(p)) {
          const sp = path.join(p, sub);
          const st = fs.lstatSync(sp);
          copyPkg(st.isSymbolicLink() ? fs.realpathSync(sp) : sp, `${entry.name}/${sub}`);
          placed.add(`${entry.name}/${sub}`);
        }
      } else {
        copyPkg(target, entry.name);
        placed.add(entry.name);
      }
    }
  }

  // 2) 再把 .pnpm 里所有包平铺进来（补齐传递依赖）
  if (fs.existsSync(store)) {
    for (const dir of fs.readdirSync(store)) {
      const nm = path.join(store, dir, 'node_modules');
      if (!fs.existsSync(nm)) continue;
      for (const name of fs.readdirSync(nm)) {
        if (name.startsWith('.')) continue;
        if (name.startsWith('@')) {
          for (const sub of fs.readdirSync(path.join(nm, name))) {
            const key = `${name}/${sub}`;
            if (!placed.has(key)) { copyPkg(path.join(nm, name, sub), key); placed.add(key); }
          }
        } else if (!placed.has(name)) {
          copyPkg(path.join(nm, name), name);
          placed.add(name);
        }
      }
    }
  }
  return copied;
}

const nm = path.join(ROOT, 'node_modules');
if (fs.existsSync(nm)) {
  const n = flattenNodeModules(nm, path.join(stage, 'node_modules'));
  console.log(`  ✓ 依赖已扁平化（${n} 个包，实体文件，无符号链接）`);
} else {
  console.log('  ⚠ 仓库里没有 node_modules，包里会缺依赖（先 npm i / pnpm i）');
}

// ── 排错程序.exe（GUI 入口，比 cmd 友好）──
const guiExe = path.join(ROOT, '\u6392\u9519\u7a0b\u5e8f.exe');
if (fs.existsSync(guiExe)) {
  fs.copyFileSync(guiExe, path.join(stage, '\u6392\u9519\u7a0b\u5e8f.exe'));
  console.log('  \u2713 \u5df2\u5e26\u4e0a \u6392\u9519\u7a0b\u5e8f.exe\uff08GUI \u5165\u53e3\uff09');
}

// ── 配置 ──
const example = path.join(ROOT, 'config.example.json');
const cfg = JSON.parse(fs.readFileSync(example, 'utf8').replace(/^\uFEFF/, ''));
cfg.consoleHost = '0.0.0.0';            // 手机要连就必须监听所有网卡
fs.writeFileSync(path.join(stage, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

// ── 启动脚本（ASCII + CRLF：cmd 在 GBK 代码页下遇到 UTF-8 中文会乱码）──
const startCmd = [
  '@echo off',
  'setlocal',
  'cd /d "%~dp0"',
  'if not exist "state" mkdir "state"',
  'echo.',
  'echo  ============================================',
  'echo   QQ Bridge  portable bundle',
  'echo  ============================================',
  'echo.',
  'node.exe src\\\\bridge.js',
  'echo.',
  'echo  [bridge exited] press any key to close',
  'pause >nul',
  ''
].join('\r\n');
fs.writeFileSync(path.join(stage, '\u542f\u52a8.cmd'), startCmd, 'ascii');

// 静默启动（不弹黑窗）
const vbs = [
  'Set sh = CreateObject("WScript.Shell")',
  'sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)',
  'sh.Run "cmd /c """ & sh.CurrentDirectory & "\\\u542f\u52a8.cmd""", 0, False'
].join('\r\n');
fs.writeFileSync(path.join(stage, '\u542f\u52a8-\u9759\u9ed8.vbs'), vbs, 'utf8');

// ── 说明.txt（UTF-8 BOM，记事本能正确识别）──
const readme = `QQ \u6865\u63a5 \u00b7 \u7eff\u8272\u6574\u5408\u5305 v${version}

\u4e0d\u9700\u8981\u5b89\u88c5 Node\uff0c\u4e0d\u9700\u8981\u5f00\u547d\u4ee4\u884c\u3002

\u3010\u600e\u4e48\u8dd1\u3011
1. \u53cc\u51fb\u300c\u542f\u52a8.cmd\u300d\uff08\u4f1a\u5f39\u4e00\u4e2a\u9ed1\u7a97\uff0c\u5173\u6389\u5c31\u662f\u505c\u6b62\u670d\u52a1\uff09
   \u60f3\u4e0d\u5f39\u7a97\uff1a\u53cc\u51fb\u300c\u542f\u52a8-\u9759\u9ed8.vbs\u300d
2. \u7b49\u51e0\u79d2\uff0c\u770b\u5230\u300c\u672c\u5730\u63a7\u5236\u53f0\u5df2\u542f\u52a8\u300d\u5c31\u597d\u4e86
3. \u6d4f\u89c8\u5668\u6253\u5f00\uff1ahttp://127.0.0.1:3100
   \u4ee4\u724c\u5728 state\\console-token \u91cc\uff08\u7528\u8bb0\u4e8b\u672c\u6253\u5f00\u590d\u5236\uff09

\u3010\u624b\u673a\u600e\u4e48\u8fde\u3011
\u624b\u673a\u548c\u7535\u8111\u8fde\u540c\u4e00\u4e2a WiFi\uff0c\u6253\u5f00\u63a7\u5236\u53f0\uff1a
\u300c\u8c03\u8bd5\u4e0e\u8fd0\u7ef4 \u2192 \u624b\u673a\u8bbe\u5907 \u2192 \u663e\u793a\u8fde\u63a5\u4e8c\u7ef4\u7801\u300d
\u624b\u673a App \u5bf9\u7740\u5c4f\u5e55\u626b\u4e00\u4e0b\u5c31\u884c\u3002

\u3010\u5e38\u89c1\u95ee\u9898\u3011
\u00b7 \u53cc\u51fb\u95ea\u9000\uff1a\u770b\u9ed1\u7a97\u91cc\u7684\u62a5\u9519\uff0c\u5e76\u786e\u8ba4\u7aef\u53e3 3100 \u6ca1\u88ab\u5360
\u00b7 \u624b\u673a\u8fde\u4e0d\u4e0a\uff1aWindows \u9632\u706b\u5899\u53ef\u80fd\u62e6\u4e86 3100\uff0c\u5141\u8bb8\u4e00\u4e0b
\u00b7 \u60f3\u6362\u7aef\u53e3\uff1a\u6539 config.json \u7684 consolePort

\u6570\u636e\u548c\u8d26\u53f7\u90fd\u5728\u8fd9\u4e2a\u6587\u4ef6\u5939\u91cc\uff08state/ \u76ee\u5f55\uff09\uff1a
\u5220\u6389\u8fd9\u4e2a\u6587\u4ef6\u5939 = \u5b8c\u5168\u6e05\u7406\uff0c\u4e0d\u4f1a\u7559\u4e0b\u4efb\u4f55\u4e1c\u897f\u3002
`;
fs.writeFileSync(path.join(stage, '\u8bf4\u660e.txt'), '\uFEFF' + readme, 'utf8');

// ── 统计 ──
function dirSize(p) {
  let sum = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, e.name);
    sum += e.isDirectory() ? dirSize(fp) : fs.statSync(fp).size;
  }
  return sum;
}
const total = dirSize(stage);
console.log(`  ✓ 已生成 dist/qq-bridge-portable/  ${(total / 1024 / 1024).toFixed(1)} MB`);
console.log('     node.exe / src/ / public/ / node_modules/ / config.json / state/ / 启动.cmd / 说明.txt');

// ── 打 zip ──
// 把拼装结果搬到 dist/qq-bridge-portable
const finalDir = path.join(distDir, 'qq-bridge-portable');
fs.rmSync(finalDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
fs.cpSync(stage, finalDir, { recursive: true });
fs.rmSync(stage, { recursive: true, force: true });

const zip = path.join(distDir, `qq-bridge-portable-${version}.zip`);
try {
  fs.rmSync(zip, { force: true });
  execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${finalDir}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal`
  ], { stdio: 'ignore' });
  console.log(`  ✓ ${path.basename(zip)}  ${(fs.statSync(zip).size / 1024 / 1024).toFixed(1)} MB`);
} catch (error) {
  console.log(`  ⚠ 打 zip 失败（目录已可用）：${error?.message ?? error}`);
}
