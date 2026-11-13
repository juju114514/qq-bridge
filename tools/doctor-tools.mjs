#!/usr/bin/env node
/**
 * tools/doctor-tools.mjs —— 运行所需工具的一键体检
 *
 * 为什么单独一个脚本：`verify.ps1` 面向「装没装好」，`preflight.mjs` 面向「新机器第一次」；
 * 这个脚本面向「**功能跑不动的现场**」—— 抖音链接解析、视频下载、看板联动这些新能力
 * 各自依赖不同的外部工具（yt-dlp / ffmpeg / SnowLuma 登录态 / cookies），
 * 缺哪个、过期了、路径不对，这里一次性说清楚，并给出可执行的修复命令。
 *
 * 用法：
 *   node tools/doctor-tools.mjs
 *   node tools/doctor-tools.mjs --url https://v.douyin.com/xxxx/   # 顺带实测一条链接
 *   node tools/doctor-tools.mjs --json
 *
 * 退出码：0 = 没有 FAIL（WARN 也算通过）；1 = 有 FAIL
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const argOf = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d; };
const AS_JSON = argv.includes('--json');
const TEST_URL = argOf('--url');

const rows = [];
const add = (level, name, detail, fix = '') => rows.push({ level, name, detail, fix });

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function which(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split(/\r?\n/)[0];
    return out || '';
  } catch { return ''; }
}

function run(cmd, args, timeout = 8000) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { timeout, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() };
  } catch (e) {
    return { ok: false, out: String(e?.stdout ?? ''), err: String(e?.message ?? e) };
  }
}

function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch { /* ignore */ } resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

const cfg = readJson(path.join(ROOT, 'config.json'), {}) || {};

// ── 1. Node ──────────────────────────────────────────────────────────
const nodeVer = process.versions.node;
const [major, minor] = nodeVer.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 13)) add('OK', 'Node.js', `v${nodeVer}`);
else add('FAIL', 'Node.js', `v${nodeVer} 太旧`, '装 Node >= 22.13（https://nodejs.org）');

// ── 2. 依赖 ──────────────────────────────────────────────────────────
const hasYaml = fs.existsSync(path.join(ROOT, 'node_modules', 'js-yaml'));
if (hasYaml) add('OK', '依赖', 'node_modules 已安装');
else add('FAIL', '依赖', '缺 node_modules（或 js-yaml）', '在仓库根目录跑 `npm install`');

// ── 3. config ────────────────────────────────────────────────────────
if (fs.existsSync(path.join(ROOT, 'config.json'))) {
  if (cfg && typeof cfg === 'object' && Object.keys(cfg).length) add('OK', 'config.json', '可解析');
  else add('FAIL', 'config.json', '存在但解析为空/损坏', '删掉后跑 `node scripts/first-run.ps1` 重新生成');
} else {
  add('FAIL', 'config.json', '不存在', '复制 config.example.json → config.json，或跑 `node scripts/first-run.ps1`');
}

// ── 4. SnowLuma（QQ 侧）──────────────────────────────────────────────
const slDir = String(process.env.QQB_SNOWLUMA_DIR || cfg?.snowluma?.homeDir || '').trim()
  || (() => { for (let i = 2; i < 26; i += 1) { const c = path.join(String.fromCharCode(65 + i) + ':', 'QQBot', 'snowluma'); if (fs.existsSync(path.join(c, 'index.mjs'))) return c; } return ''; })();
if (slDir && fs.existsSync(path.join(slDir, 'index.mjs'))) add('OK', 'SnowLuma 目录', slDir);
else add('FAIL', 'SnowLuma 目录', '找不到 index.mjs', '装 SnowLuma，或设 QQB_SNOWLUMA_DIR 指向它的目录');

const [p3000, p3001] = [await portOpen(3000), await portOpen(3001)];
if (p3000 && p3001) add('OK', 'SnowLuma 端口', ':3000 / :3001 都在听');
else add('FAIL', 'SnowLuma 端口', `${p3000 ? '' : ':3000 不通'}${p3001 ? '' : ' :3001 不通'}`.trim(), '启动 SnowLuma 并扫码登录 QQ 小号（本项目不代启）');

// ── 5. DSH ───────────────────────────────────────────────────────────
const dshBase = String(cfg?.dsh?.baseUrl || '').trim();
if (!dshBase) add('WARN', 'DSH baseUrl', 'config 里没填', '控制台「设置」里点自动探测，或手填 DSH 的 http 地址');
else {
  const port = Number(new URL(dshBase).port || 80);
  if (await portOpen(port)) add('OK', 'DSH', dshBase);
  else add('FAIL', 'DSH', `${dshBase} 连不上`, 'DSH 每次重启端口会变：跑 `node scripts/probe-dsh.mjs`（或控制台自动探测）');
}

// ── 6. yt-dlp（视频下载）─────────────────────────────────────────────
const ytFromCfg = String(cfg?.socialV2?.media?.video?.links?.ytdlpPath || '').trim();
const yt = (ytFromCfg && fs.existsSync(ytFromCfg)) ? ytFromCfg : (which('yt-dlp') || which('yt-dlp.exe') || which('ytdlp'));
if (yt) {
  const v = run(yt, ['--version']);
  if (v.ok) add('OK', 'yt-dlp', `${v.out.split('\n')[0]}  (${yt})`);
  else add('WARN', 'yt-dlp', `找到但跑不起来：${yt}`, '换一个官方 release 的 yt-dlp.exe');
} else {
  add('WARN', 'yt-dlp', '没找到（只有「要视频」功能需要）', 'winget install yt-dlp 或到 https://github.com/yt-dlp/yt-dlp/releases 下载后填 socialV2.media.video.links.ytdlpPath');
}

// ── 7. ffmpeg（合并音视频/转码）──────────────────────────────────────
const ff = which('ffmpeg');
if (ff) { const v = run(ff, ['-version']); add('OK', 'ffmpeg', v.ok ? v.out.split('\n')[0].slice(0, 60) : ff); }
else add('WARN', 'ffmpeg', '没找到（高清合并/转码需要）', 'winget install Gyan.FFmpeg 或把 ffmpeg.exe 放进 PATH');

// ── 8. 抖音 cookies（下载/接口要登录态）──────────────────────────────
const ck = String(cfg?.socialV2?.media?.video?.links?.cookiesPath || '').trim();
if (!ck) add('WARN', '抖音 cookies', '没有配 cookiesPath', '控制台「抖音登录」→ 同步 cookies 到桥接，会自动写入这个路径');
else if (!fs.existsSync(ck)) add('FAIL', '抖音 cookies', `文件不存在：${ck}`, '控制台「抖音登录」→ 显示二维码 → 扫码 → 同步 cookies');
else {
  const st = fs.statSync(ck);
  const ageH = Math.round((Date.now() - st.mtimeMs) / 3600000);
  const douyinLines = fs.readFileSync(ck, 'utf8').split('\n').filter((l) => l.includes('douyin')).length;
  if (douyinLines === 0) add('FAIL', '抖音 cookies', '文件里没有 douyin 域', '重新导出：python tools/export-cookies.py --out "' + ck + '"');
  else if (ageH > 24 * 7) add('WARN', '抖音 cookies', `${ageH} 小时前导出（抖音一般几天就过期）`,
    '控制台「抖音登录」→ 同步 cookies；或 python tools/export-cookies.py --out "' + ck + '"');
  else add('OK', '抖音 cookies', `${douyinLines} 条 douyin cookie，${ageH} 小时前导出`);
}

// ── 9. 桥接控制台 ────────────────────────────────────────────────────
const consolePort = Number(cfg?.consolePort || 3100);
if (await portOpen(consolePort)) add('OK', '桥接控制台', `:${consolePort} 在听`);
else add('WARN', '桥接控制台', `:${consolePort} 没在听`, '`powershell -File start-bridge.ps1 -Hidden`（或检查 state/logs/supervisor.log）');

// ── 10. 实测一条抖音链接（可选）──────────────────────────────────────
if (TEST_URL) {
  try {
    const mod = await import(new URL('../src/douyin-link.js', import.meta.url).href);
    const links = mod.extractDouyinLinks(TEST_URL);
    if (!links.length) add('FAIL', '链接识别', '这条链接没被认出来', '把链接发出来，可能是新形态');
    else add('OK', '链接识别', `${links.length} 条，id=${mod.awemeIdFromLink(links[0]) || '(短链需解析)'}`);
  } catch (e) {
    add('WARN', '链接识别', `模块加载失败：${String(e?.message ?? e).slice(0, 80)}`, '确认在仓库根目录跑本脚本');
  }
}

// ── 输出 ─────────────────────────────────────────────────────────────
const mark = { OK: '✓', WARN: '!', FAIL: '✗' };
const fails = rows.filter((r) => r.level === 'FAIL').length;
const warns = rows.filter((r) => r.level === 'WARN').length;

if (AS_JSON) {
  console.log(JSON.stringify({ ok: fails === 0, rows }, null, 2));
} else {
  const pad = rows.reduce((m, r) => Math.max(m, [...r.name].length), 0);
  for (const r of rows) {
    console.log(`${mark[r.level] || '?'} ${r.name.padEnd(pad)}  ${r.detail}`);
    if (r.fix) console.log(`  ${' '.repeat(pad)}  → ${r.fix}`);
  }
  console.log('');
  console.log(`共 ${rows.length} 项：OK ${rows.length - fails - warns} / WARN ${warns} / FAIL ${fails}`);
  if (fails) console.log('先修 FAIL；WARN 只影响对应功能，不影响基本收发。');
}
process.exit(fails ? 1 : 0);
