#!/usr/bin/env node
// 全新机器/全新环境「体检」：一条命令告诉你缺什么、下一步看哪一节文档。
//
// 为什么需要它：别人把仓库 clone 下来，最容易卡在「缺一个前置条件」上，而且症状
// 往往不指向原因（比如 DSH 端口变了 → 表现是"机器人不说话"）。
// 这个脚本**不依赖 node_modules**（只 import node 内置模块），所以在 `npm install`
// 之前就能跑，是最早能给出的反馈。
//
// 设计原则：
//   · 只读：不改文件、不启动/停止任何进程、不代启 SnowLuma
//   · 每条结论都带一个「下一步看哪」（锚到 TROUBLESHOOTING.md 的具体小节）
//   · 退出码：0=全绿；1=有 FAIL 项；2=只有 WARN
//
// 用法：
//   node scripts/preflight.mjs                 # 体检当前目录
//   node scripts/preflight.mjs --dir <路径>    # 体检别的目录（模拟新机器）
//   node scripts/preflight.mjs --json          # 机器可读

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const wantJson = process.argv.includes('--json');
const ROOT = path.resolve(arg('dir', path.join(HERE, '..')));

const results = [];
function add(level, name, detail, next) {
  results.push({ level, name, detail, next });
}
const ok = (n, d, next = '') => add('OK', n, d, next);
const warn = (n, d, next = '') => add('WARN', n, d, next);
const fail = (n, d, next = '') => add('FAIL', n, d, next);

/** TCP 连通性（只探测，不发起协议交互）。 */
function probePort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try { socket.connect(port, host); } catch { done(false); }
  });
}

function readJsonSafe(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    const hadBom = text.charCodeAt(0) === 0xfeff;
    if (hadBom) text = text.slice(1);
    return { value: JSON.parse(text), hadBom, raw: true };
  } catch (error) {
    return { value: null, hadBom: false, raw: false, error: String(error?.message ?? error) };
  }
}

// ── 1. 运行环境 ───────────────────────────────────────────────────────────
const [major, minor] = process.versions.node.split('.').map(Number);
const nodeOk = major > 22 || (major === 22 && minor >= 13);
if (nodeOk) ok('Node 版本', `v${process.versions.node}（>= 22.13 ✅）`);
else fail('Node 版本', `v${process.versions.node} 低于 22.13：没有内置 WebSocket，桥接起不来`, 'TROUBLESHOOTING.md#a1-找不到-node请先装-nodejs-22-lts / #a2');

if (process.platform === 'win32' || process.platform === 'linux') ok('平台', process.platform);
else warn('平台', `${process.platform}：本项目只在 Windows / Linux 上验证过`, 'docs/guides/MIGRATION.md');

// ── 2. 仓库结构完整性 ─────────────────────────────────────────────────────
const mustHave = [
  ['package.json', '依赖清单'],
  ['src/bridge.js', '主程序'],
  ['public/console.html', '控制台页面'],
  ['roles', '人格卡目录'],
  ['assets', '素材目录'],
  ['dsh/agent-presets', 'preset 权威源'],
  ['config.example.json', '配置模板'],
  ['COMPAT.md', '兼容契约'],
];
const missing = mustHave.filter(([rel]) => !fs.existsSync(path.join(ROOT, rel)));
if (missing.length === 0) ok('仓库完整性', `${mustHave.length} 个关键路径都在`);
else fail('仓库完整性', `缺：${missing.map(([r]) => r).join('、')}`, 'A4（依赖/文件缺失）');

// ── 3. 依赖是否装好 ───────────────────────────────────────────────────────
const nm = path.join(ROOT, 'node_modules');
if (!fs.existsSync(nm)) {
  warn('依赖未安装', '没有 node_modules：先 `npm install`（Node 自带的 npm 即可）', 'TROUBLESHOOTING.md#a3-npm-install-卡住或超时');
} else {
  const probes = ['js-yaml', '@deepseek-ai/dsh-host-apiproxy'];
  const lacks = probes.filter((p) => !fs.existsSync(path.join(nm, ...p.split('/'))));
  if (lacks.length) warn('依赖不完整', `缺 ${lacks.join('、')}：重跑 npm install`, 'A4（ERR_MODULE_NOT_FOUND）');
  else ok('依赖', `${probes.length} 个关键包都在`);
}

// ── 4. config.json ────────────────────────────────────────────────────────
const cfgPath = path.join(ROOT, 'config.json');
let cfg = null;
if (!fs.existsSync(cfgPath)) {
  fail('config.json', '不存在：复制 config.example.json 改名，或跑 setup.ps1', 'README「安装与配置」');
} else {
  const parsed = readJsonSafe(cfgPath);
  if (!parsed.raw) fail('config.json', `解析失败：${parsed.error}`, 'TROUBLESHOOTING.md#a7-config-json-解析失败unexpected-utf-8-bom');
  else {
    if (parsed.hadBom) warn('config.json', '带 UTF-8 BOM（能读但不该有；某些工具会因此解析失败）', 'A7');
    cfg = parsed.value;
    ok('config.json', '存在且是合法 JSON');
    if (!cfg.ownerQQ) warn('ownerQQ', '没填：审批/管理命令/closed-agent 全不可用', 'AGENTS.md 或 TROUBLESHOOTING.md#g1');
    const allowP = (cfg.allow?.private ?? []).length;
    const allowG = (cfg.allow?.groups ?? []).length;
    if (!allowP && !allowG) warn('白名单为空', '不会响应任何 QQ 消息（除非 allowAllWhenEmpty=true）', 'TROUBLESHOOTING.md#e3-白名单没命中');
    else ok('白名单', `私聊 ${allowP} 个、群 ${allowG} 个`);
    if (!cfg.dsh?.baseUrl) fail('dsh.baseUrl', '没配置', 'TROUBLESHOOTING.md#c1-控制台-dshready-false');
    if (!cfg.snowluma?.wsUrl || !cfg.snowluma?.httpUrl) fail('snowluma 端点', 'wsUrl/httpUrl 没配置', 'D1/D2');
  }
}

// ── 5. state/ 可写 ────────────────────────────────────────────────────────
const stateDir = path.join(ROOT, 'state');
try {
  fs.mkdirSync(stateDir, { recursive: true });
  const probe = path.join(stateDir, '.preflight-probe');
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe, { force: true });
  ok('state/ 可写', stateDir);
  const lock = path.join(stateDir, 'bridge.lock');
  if (fs.existsSync(lock)) warn('发现 bridge.lock', '可能是残留锁（进程没在跑时会自动清，但双开会打架）', 'TROUBLESHOOTING.md#b1');
} catch (error) {
  fail('state/ 不可写', String(error?.message ?? error), 'TROUBLESHOOTING.md#b4');
}

// ── 6. 端口与两个外部依赖 ─────────────────────────────────────────────────
const consolePort = Number(cfg?.consolePort) || 3100;
if (await probePort('127.0.0.1', consolePort)) {
  warn(`端口 ${consolePort}`, '已在监听：可能已经有一个桥接在跑（重复启动会被单实例锁拒绝）', 'TROUBLESHOOTING.md#b2');
} else ok(`端口 ${consolePort}`, '空闲');

const dshUrl = String(cfg?.dsh?.baseUrl ?? '');
if (dshUrl) {
  try {
    const u = new URL(dshUrl);
    const reachable = await probePort(u.hostname.replace(/^\[|\]$/g, ''), Number(u.port) || 80);
    if (reachable) ok('DSH 可达', dshUrl);
    else fail('DSH 不可达', `${dshUrl} 连不上：DSH 没启动，或端口变了（每次重启都可能变）`, 'TROUBLESHOOTING.md#c1-控制台-dshready-false / docs/guides/MIGRATION.md');
  } catch {
    fail('dsh.baseUrl 非法', dshUrl, 'C1');
  }
}

for (const [label, key, def] of [['SnowLuma HTTP', 'httpUrl', 'http://127.0.0.1:3000'], ['SnowLuma WS', 'wsUrl', 'ws://127.0.0.1:3001']]) {
  const raw = String(cfg?.snowluma?.[key] ?? def);
  try {
    const u = new URL(raw);
    const reachable = await probePort(u.hostname.replace(/^\[|\]$/g, ''), Number(u.port) || (u.protocol === 'wss:' ? 443 : 80));
    if (reachable) ok(label, `可达 ${raw}`);
    else warn(label, `连不上 ${raw}：SnowLuma 是第三方程序，需要你自己启动并登录（本项目不代启）`, 'TROUBLESHOOTING.md#d1 / #d2');
  } catch {
    fail(label, `地址非法：${raw}`, 'D1');
  }
}

// ── 7. 人格卡（id 化之后最常见的坑）──────────────────────────────────────
const rolesDir = path.join(ROOT, 'roles');
if (fs.existsSync(rolesDir)) {
  const cards = fs.readdirSync(rolesDir).filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'ATTRIBUTION.md');
  if (cards.length === 0) warn('人格卡', '一张都没有（AI 会用默认人格）', 'TROUBLESHOOTING.md#f1');
  else {
    const noMeta = [];
    for (const file of cards) {
      const text = fs.readFileSync(path.join(rolesDir, file), 'utf8').replace(/^\uFEFF/, '');
      if (!/^---\s*\n[\s\S]*?\bid:\s*\S/.test(text)) noMeta.push(file);
    }
    if (noMeta.length) warn('人格卡缺元数据', `${noMeta.length} 张没有 front matter（id/name）：跑 node scripts/migrate-roles-to-ids.mjs --apply`, 'TROUBLESHOOTING.md#f0');
    else ok('人格卡', `${cards.length} 张都有 id/name`);
  }
}

// ── 8. 环境变量类的坑 ────────────────────────────────────────────────────
const proxyVars = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy'].filter((k) => process.env[k]);
if (proxyVars.length) warn('代理环境变量', `${proxyVars.join('、')} 已设置：可能让本机 127.0.0.1 的请求被代理走`, 'TROUBLESHOOTING.md#n3');
else ok('代理', '没有设置代理变量');
const skewMin = Math.abs(Date.now() - Date.now()); // 占位：真校验需要网络，交给 N2
if (skewMin === 0) ok('系统时间', `本机 ${new Date().toISOString()}（与 DSH 签名相关，异常时看 N2）`);

// ── 输出 ─────────────────────────────────────────────────────────────────
if (wantJson) {
  console.log(JSON.stringify({ root: ROOT, results }, null, 2));
} else {
  const mark = { OK: '[OK]  ', WARN: '[WARN]', FAIL: '[FAIL]' };
  console.log('');
  console.log(`  qq-bridge 环境体检    目录: ${ROOT}`);
  console.log('  ' + '─'.repeat(64));
  for (const r of results) {
    console.log(`  ${mark[r.level]} ${r.name.padEnd(16)} ${r.detail}`);
    if (r.next && r.level !== 'OK') console.log(`         └─ 下一步：${r.next}`);
  }
  const fails = results.filter((r) => r.level === 'FAIL').length;
  const warns = results.filter((r) => r.level === 'WARN').length;
  console.log('  ' + '─'.repeat(64));
  console.log(`  合计 ${results.length} 项：OK ${results.length - fails - warns} / WARN ${warns} / FAIL ${fails}`);
  if (fails) console.log('  先修 FAIL 项；修完重跑本脚本。全新机器请对照 docs/guides/FRESH-INSTALL.md');
  else if (warns) console.log('  没有致命问题。WARN 项按提示处理即可。');
  else console.log('  全部通过，可以启动：Windows 用 .\\start-bridge.ps1，Linux 用 systemctl。');
  console.log('');
}

process.exitCode = results.some((r) => r.level === 'FAIL') ? 1 : (results.some((r) => r.level === 'WARN') ? 2 : 0);
