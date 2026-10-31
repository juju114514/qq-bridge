#!/usr/bin/env node
// 启动器（最小版）—— 给第一次用的人一个入口，不用记脚本名
//
// 设计原则：
//   · 只做「编排」，不重复实现逻辑：拉起交给 scripts/start-all.ps1，自检交给 verify-qq-bridge.ps1
//   · 用 Node 写（仓库本来就依赖 Node），避免 PowerShell 5.1 的 BOM 编码坑
//   · 每一步都打印「看到了什么 / 该做什么」，而不是只显示一串命令
//
// 用法：
//   双击根目录的「启动器.cmd」，或：
//   node scripts/launcher.mjs
//   node scripts/launcher.mjs --check     # 只体检，不进菜单（适合排障/CI）
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const CHECK_ONLY = process.argv.includes('--check');

// ── 输出 ────────────────────────────────────────────────────────────────
const c = (code, s) => (process.stdout.isTTY ? `\u001b[${code}m${s}\u001b[0m` : s);
const ok = (s) => console.log(`  ${c('32', '[OK]')}   ${s}`);
const warn = (s) => console.log(`  ${c('33', '[!]')}    ${s}`);
const bad = (s) => console.log(`  ${c('31', '[X]')}    ${s}`);
const info = (s) => console.log(`         ${s}`);
const head = (s) => { console.log(''); console.log(c('36', s)); };

// ── 小工具 ──────────────────────────────────────────────────────────────
function portOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, '127.0.0.1');
  });
}

async function getJson(url, timeoutMs = 4000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function readConfig() {
  const p = path.join(root, 'config.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { __broken: true };
  }
}

function runPS(args, opts = {}) {
  if (!isWin) {
    bad('这个启动器目前只面向 Windows（桥接的点歌/语音依赖 PowerShell）');
    return 1;
  }
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: false,
    ...opts
  });
  return r.status === null ? 1 : r.status;
}

function openUrl(url) {
  if (!isWin) return;
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function tailLog(name, lines = 12) {
  const p = path.join(root, 'state', name);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).slice(-lines);
}

// ── 体检 ────────────────────────────────────────────────────────────────
async function healthCheck({ quiet = false } = {}) {
  const problems = [];

  if (!quiet) head('一、体检');

  // 1) Node
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) ok(`Node ${process.version}`);
  else { bad(`Node ${process.version}（需要 >= 22）`); problems.push('node'); }

  // 2) config.json
  const cfg = readConfig();
  if (!cfg) { bad('没有 config.json —— 先跑一次 setup.ps1 或复制 config.example.json'); problems.push('config'); }
  else if (cfg.__broken) { bad('config.json 解析失败（JSON 写坏了）—— 用备份恢复'); problems.push('config-broken'); }
  else ok('config.json 可读');

  // 3) 配置是否还是"空壳"
  if (cfg && !cfg.__broken) {
    const ownerQQ = String(cfg.ownerQQ || '').trim();
    const groups = Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : [];
    const privates = Array.isArray(cfg.allow?.private) ? cfg.allow.private : [];
    if (ownerQQ) ok(`管理员 QQ：${ownerQQ}`);
    else { warn('没配 ownerQQ —— 审批/管理命令都用不了（控制台「访问与安全」里填）'); problems.push('ownerQQ'); }
    if (groups.length || privates.length) ok(`白名单：群 ${groups.length} 个 / 私聊 ${privates.length} 个`);
    else { warn('白名单是空的 —— 它不会回任何 QQ 消息（控制台「访问与安全」里填）'); problems.push('allow'); }
  }

  // 4) 网关（OneBot）
  const gw3000 = await portOpen(3000);
  const gw3001 = await portOpen(3001);
  if (gw3000 || gw3001) ok(`网关在跑（${gw3000 ? '3000' : ''}${gw3000 && gw3001 ? ' + ' : ''}${gw3001 ? '3001' : ''}）`);
  else {
    const ui = await portOpen(5099);
    if (ui) { warn('网关界面在（5099），但 OneBot 没起来 —— 去 http://127.0.0.1:5099 扫码登录'); problems.push('gateway-login'); }
    else { warn('网关没起（3000/3001 都没监听）—— 需要先启动 SnowLuma 或 NapCat'); problems.push('gateway'); }
  }

  // 5) 桥接 + 控制台
  const health = await getJson('http://127.0.0.1:3100/health/detail');
  if (health) {
    ok(`桥接在跑：v${health.version} ready=${health.ready}`);
    if (health.services) info(`DSH=${health.services.dsh} 网关=${health.services.snowluma} 官方=${health.services.official}`);
    if (health.ready !== true) { warn('ready=false —— 桥接起来了但网关/DSH 没连上'); problems.push('not-ready'); }
  } else {
    warn('桥接没在跑（3100 无响应）—— 选 2 一键拉起'); problems.push('bridge');
  }

  if (!quiet) {
    console.log('');
    if (!problems.length) ok('体检通过：可以用了');
    else warn(`有 ${problems.length} 项要注意（见上面 [!] / [X]）`);
  }
  return { problems, cfg, health };
}

// ── 动作 ────────────────────────────────────────────────────────────────
async function startAll() {
  head('二、拉起');
  info('交给 scripts/start-all.ps1（它会自动判断用 SnowLuma 还是 NapCat）…');
  const code = runPS([path.join(root, 'scripts', 'start-all.ps1')]);
  console.log('');
  if (code === 0) ok('拉起流程结束');
  else bad(`拉起脚本退出码 ${code}，看上面的输出`);
  const health = await getJson('http://127.0.0.1:3100/health/detail');
  if (health) ok(`现在：v${health.version} ready=${health.ready}`);
}

async function stopAll() {
  head('停止');
  if (!isWin) return;
  const r = spawnSync('schtasks', ['/end', '/tn', 'qq-bridge'], { stdio: 'ignore' });
  if (r.status === 0) ok('已停止计划任务 qq-bridge（看门狗 5 分钟内不会立刻拉起）');
  else warn('停不下来（可能不是计划任务模式，或需要管理员权限）');
}

function openConsole() {
  head('打开控制台');
  const cfg = readConfig() || {};
  const port = Number(cfg.consolePort) || 3100;
  const url = `http://127.0.0.1:${port}/`;
  info(url);
  openUrl(url);
  ok('已在浏览器打开（首次会要控制台令牌，见 state/console-token）');
}

function showLog() {
  head('最近日志（state/bridge.log）');
  const lines = tailLog('bridge.log', 15);
  if (!lines) { warn('还没有日志'); return; }
  for (const line of lines) console.log('  ' + line.slice(0, 140));
}

async function selfTest() {
  head('自检（18 项）');
  const code = runPS([path.join(root, 'scripts', 'verify-qq-bridge.ps1')]);
  console.log('');
  if (code === 0) ok('自检通过');
  else bad('自检有失败项，看上面对应的行');
}

// ── 菜单 ────────────────────────────────────────────────────────────────
function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
}

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      console.log('');
      console.log(c('36', '──────────────── 启动器 ────────────────'));
      console.log('  1) 体检（不启动任何东西）');
      console.log('  2) 一键拉起（网关 + 桥接）');
      console.log('  3) 打开控制台');
      console.log('  4) 看最近日志');
      console.log('  5) 跑 18 项自检');
      console.log('  6) 停止');
      console.log('  0) 退出');
      const choice = await ask(rl, '选一个：');
      if (choice === '0' || choice === 'q') break;
      if (choice === '1') await healthCheck();
      else if (choice === '2') await startAll();
      else if (choice === '3') openConsole();
      else if (choice === '4') showLog();
      else if (choice === '5') await selfTest();
      else if (choice === '6') await stopAll();
      else if (choice !== '') console.log('  （没有这个选项）');
    }
  } finally {
    rl.close();
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────
console.log('');
console.log(c('36', '  QQ ↔ DeepSeek Harness 启动器'));
console.log(`  目录：${root}`);

const { problems } = await healthCheck();

if (CHECK_ONLY) {
  process.exitCode = problems.length ? 1 : 0;
} else {
  await menu();
  console.log('');
  console.log('  下次想跳过菜单，直接跑：node scripts\\launcher.mjs --check');
}
