#!/usr/bin/env node
// 「模型说没有 qq_open_video / qq_get_message_video」一条命令查到底。
//
// 背景（2026-10-28 真实误判）：别人的 AI 排障后断言
//   「确认了 == 没有 open_video == … 只是作者还没把这个工具放进模型能调用的清单里」
// 但 qq_open_video 从 8d18fc6 起就在 src/mcp-snowluma-safe.js 里，本地一直在用。
// 真实原因只有三种，而旧实现里**一条日志都没有**（disabledTools 收完就丢），只能靠猜：
//   ① socialV2.tools.getImages=false —— 一次关掉图片/视频/链接三件套
//   ② 改完代码/开关后没重启 DSH（MCP 工具清单是 DSH 启动时的快照，只重启桥接不够）
//   ③ 版本旧于 8d18fc6
//
// 这个脚本把三条线索一次摊开：
//   · 桥接侧：GET /api/socialV2/tools（这三个工具会不会注册）
//   · 代码侧：src/mcp-snowluma-safe.js 里有没有 qq_open_video（版本）
//   · 运行侧：真跑一次 MCP，读它的 stderr 汇总行（工具注册完成：N 个｜视频/图片：…✓）
//
// 用法：
//   node scripts/diag-tools.mjs
//   node scripts/diag-tools.mjs --skip-mcp          # 不真跑 MCP（更快，但少了运行侧证据）
//   node scripts/diag-tools.mjs --base http://127.0.0.1:3100
//   node scripts/diag-tools.mjs --json
//
// 退出码：0 = 三件套都注册；1 = 有缺失（会指出该改什么）；2 = 连不上桥接/环境问题

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const skipMcp = args.includes('--skip-mcp');
const baseArg = (() => {
  const i = args.indexOf('--base');
  return i >= 0 && args[i + 1] ? args[i + 1] : 'http://127.0.0.1:3100';
})();

const VIDEO_TOOLS = ['qq_get_message_images', 'qq_get_message_video', 'qq_open_video'];

function readToken() {
  // 与桥接的校验口径一致：config.json 里的 consoleToken 合法就用它，否则读 state/console-token
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const configured = String(cfg.consoleToken ?? '').trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  } catch { /* 忽略：可能没配置文件 */ }
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch { return ''; }
}

async function probeBridge() {
  const token = readToken();
  if (!token) return { ok: false, error: '读不到控制台令牌（config.json 的 consoleToken 或 state/console-token）' };
  try {
    const res = await fetch(`${baseArg}/api/socialV2/tools`, {
      headers: { 'x-console-token': token },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}（桥接在跑但端点不可用？版本是否旧于 2bb9665）` };
    return { ok: true, data: await res.json() };
  } catch (error) {
    return { ok: false, error: `连不上桥接 ${baseArg}：${error?.message ?? error}` };
  }
}

function probeSource() {
  const file = path.join(ROOT, 'src', 'mcp-snowluma-safe.js');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, error: `读不到 ${file}` }; }
  const missing = VIDEO_TOOLS.filter((name) => !text.includes(`'${name}'`));
  const flagMapped = /qq_open_video:\s*'getImages'/.test(text);
  const summaryLogged = text.includes('工具注册完成：');
  return { ok: missing.length === 0, missing, flagMapped, summaryLogged };
}

function probeMcpRuntime({ timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-snowluma-safe.js')], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env
    });
    let err = '';
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已退出 */ }
      resolve(payload);
    };
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
    child.on('error', (error) => done({ ok: false, error: String(error?.message ?? error) }));
    setTimeout(() => {
      const line = err.split(/\r?\n/).find((l) => l.includes('工具注册完成')) ?? '';
      const disabled = err.split(/\r?\n/).find((l) => l.includes('按配置关闭')) ?? '';
      done({ ok: Boolean(line), line: line.trim(), disabled: disabled.trim(), raw: err.trim() });
    }, timeoutMs);
  });
}

const bridge = await probeBridge();
const source = probeSource();
const runtime = skipMcp ? { skipped: true } : await probeMcpRuntime();

const result = { bridge, source, runtime };
if (wantJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('');
  console.log('  ── ① 桥接侧（这三件套会不会注册）');
  if (bridge.ok) {
    const d = bridge.data ?? {};
    console.log(`     getImages = ${d.getImages}`);
    for (const [k, v] of Object.entries(d.tools ?? {})) {
      console.log(`     ${String(k).padEnd(5)} ${String(v.name).padEnd(26)} registered=${v.registered}`);
    }
    if (Array.isArray(d.otherDisabled) && d.otherDisabled.length) {
      console.log(`     其它被关掉的开关：${d.otherDisabled.join(', ')}`);
    }
    if (d.hint) console.log(`     提示：${d.hint}`);
  } else {
    console.log(`     ✗ ${bridge.error}`);
  }

  console.log('');
  console.log('  ── ② 代码侧（版本里有没有这些工具）');
  if (source.ok) {
    console.log(`     ✓ ${VIDEO_TOOLS.join(' / ')} 都在 src/mcp-snowluma-safe.js`);
    console.log(`     开关映射 getImages：${source.flagMapped ? '✓' : '✗'}   启动汇总日志：${source.summaryLogged ? '✓' : '✗（版本旧）'}`);
  } else {
    console.log(`     ✗ 缺少：${(source.missing ?? []).join(', ')}${source.error ? `（${source.error}）` : ''}`);
  }

  console.log('');
  console.log('  ── ③ 运行侧（MCP 自己说注册了什么）');
  if (runtime.skipped) {
    console.log('     （--skip-mcp：跳过）');
  } else if (runtime.ok) {
    console.log(`     ${runtime.line}`);
    if (runtime.disabled) console.log(`     ${runtime.disabled}`);
  } else {
    console.log(`     ✗ 没读到汇总行：${runtime.error ?? '（老版本没有这行日志）'}`);
  }
}

// ── 判定 ────────────────────────────────────────────────────────────────────
let verdict = '';
let exitCode = 0;
if (!bridge.ok) {
  verdict = '先确认桥接在跑（GET /api/status），并确认版本 ≥ 2bb9665（端点才有）';
  exitCode = 2;
} else if (bridge.data?.getImages === false) {
  verdict = '原因①：socialV2.tools.getImages=false ⇒ 把 config.json 里它改成 true，然后**重启 DSH**（不是重启桥接）';
  exitCode = 1;
} else if (!source.ok) {
  verdict = `原因③：代码里没有这些工具 ⇒ 版本太旧（qq_open_video 从 8d18fc6 起才有），先 git pull`;
  exitCode = 1;
} else if (!runtime.skipped && !runtime.ok) {
  verdict = '原因②：MCP 没打印注册汇总 ⇒ 跑的是旧进程/旧版本，重启 DSH 后再看一次';
  exitCode = 1;
} else {
  verdict = '三件套都注册了。如果模型仍看不到：重启 DSH（工具清单是启动快照），再不行就新建会话';
}

console.log('');
console.log(`  ── 结论：${verdict}`);
console.log('');
process.exit(exitCode);
