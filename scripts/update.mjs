#!/usr/bin/env node
// 自更新（0.4.72）—— 学 SnowLuma 的更新流程，但补上它缺的三件事：备份、健康检查、自动回滚
//
// 为什么要自己做一个：
//   别人的更新器出过事：下载/应用都成功，但**关掉进程后没有拉起来**，网关离线 5 分钟。
//   根因是「更新器自己负责重启」，一旦它退出就没人接。我们的做法相反：
//   更新器只负责换文件然后退出，**重启交给计划任务/runner**（那份守护是经过验证的）。
//
// 三步，每步都能单独跑：
//   node scripts/update.mjs --check       # 只对比版本，不做任何改动
//   node scripts/update.mjs --download    # 下到 _update/，不碰线上
//   node scripts/update.mjs --apply       # 备份 → 覆盖 → 重启 → 健康检查 → 失败自动回滚
//
// 可选：--proxy http://127.0.0.1:7897   （国内访问 GitHub 常需要）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.QQB_UPDATE_REPO || 'juju114514/qq-bridge';
const isWin = process.platform === 'win32';
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const opt = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const UPDATE_DIR = path.join(root, '_update');
const ROLLBACK_DIR = path.join(root, '_rollback');
const CONSOLE_PORT = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    return Number(cfg.consolePort) || 3100;
  } catch {
    return 3100;
  }
})();

// 绝不覆盖：运行态与凭证
const PROTECTED = new Set([
  'config.json', 'config.json.bak', 'state', 'node_modules', '.git', '.github',
  'data', 'logs', 'audio', 'cookies.txt', 'cookies.json', '_update', '_rollback', '_official-staging'
]);

const c = (code, s) => (process.stdout.isTTY ? `\u001b[${code}m${s}\u001b[0m` : s);
const ok = (s) => console.log(`  ${c('32', '[OK]')}   ${s}`);
const warn = (s) => console.log(`  ${c('33', '[!]')}    ${s}`);
const bad = (s) => console.log(`  ${c('31', '[X]')}    ${s}`);
const info = (s) => console.log(`         ${s}`);
const head = (s) => { console.log(''); console.log(c('36', s)); };

/** 读 JSON，**剥掉 BOM**（PowerShell 写的文件常带 BOM，JSON.parse 会直接失败） */
function readJsonFile(p) {
  const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

const localVersion = () => {
  try {
    return String(readJsonFile(path.join(root, 'package.json')).version || '');
  } catch {
    return '';
  }
};

/** 版本比较：只认 x.y.z（-rc 这类后缀按数字段比，够用了） */
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.\-+]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.\-+]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 优先用 curl（自带代理支持），没有再退回 fetch */
function httpGet(url, { proxy = '', json = false, outFile = '' } = {}) {
  const curl = isWin ? 'curl.exe' : 'curl';
  const hasCurl = spawnSync(curl, ['--version'], { stdio: 'ignore' }).status === 0;
  if (hasCurl) {
    const args = ['-sSL', '--max-time', '120', '-H', 'User-Agent: qq-bridge-updater'];
    if (proxy) args.push('--proxy', proxy);
    if (outFile) args.push('-o', outFile);
    args.push(url);
    const r = spawnSync(curl, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`curl 失败（${r.status}）：${(r.stderr || '').slice(0, 200)}`);
    return outFile ? '' : String(r.stdout || '');
  }
  return null; // 调用方退回 fetch（异步）
}

async function getJson(url, proxy) {
  const viaCurl = httpGet(url, { proxy, json: true });
  if (viaCurl !== null) return JSON.parse(viaCurl);
  const res = await fetch(url, { headers: { 'user-agent': 'qq-bridge-updater' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// ── check ───────────────────────────────────────────────────────────────
async function check({ quiet = false } = {}) {
  const proxy = opt('--proxy', process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '');
  const cur = localVersion();
  if (!quiet) head('检查更新');
  if (!quiet) info(`本地版本：${cur}`);
  let rel;
  try {
    rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`, proxy);
  } catch (e) {
    bad(`查不到最新版本（网络/代理？）：${e.message}`);
    if (proxy) info(`当前代理：${proxy}`);
    else info('可以加 --proxy http://127.0.0.1:7897 再试');
    return { ok: false, current: cur, latest: '' };
  }
  const latest = String(rel.tag_name || '').replace(/^v/i, '');
  const newer = cmpVersion(latest, cur) > 0;
  if (!quiet) {
    info(`最新版本：${latest}${rel.published_at ? `（${String(rel.published_at).slice(0, 10)}）` : ''}`);
    if (!newer) ok('已经是最新的');
    else {
      warn(`有新版本可用：${cur} → ${latest}`);
      info(`下一步：node scripts/update.mjs --download --proxy <代理>`);
    }
  }
  return { ok: true, current: cur, latest, newer, tarball: rel.tarball_url, notes: rel.body || '' };
}

// ── download ────────────────────────────────────────────────────────────
async function download() {
  const proxy = opt('--proxy', process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '');
  head('下载更新');
  const r = await check({ quiet: true });
  if (!r.ok) { bad('检查失败，下载中止'); return 1; }
  if (!r.newer) { ok('已是最新，不需要下载'); return 0; }
  const target = path.join(UPDATE_DIR, `qq-bridge-${r.latest}.tar.gz`);
  fs.mkdirSync(UPDATE_DIR, { recursive: true });
  info(`下载 ${r.tarball} → ${path.relative(root, target)}`);
  httpGet(r.tarball, { proxy, outFile: target });
  const size = fs.statSync(target).size;
  if (size < 1024) { bad(`下载的文件太小（${size} 字节），可能不是压缩包`); return 1; }
  ok(`下载完成：${(size / 1024 / 1024).toFixed(1)} MB`);
  info('下一步：node scripts/update.mjs --apply');
  return 0;
}

// ── apply ───────────────────────────────────────────────────────────────
function extract(tarPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // Windows 10+ 自带 tar.exe（bsdtar），Linux/macOS 也有
  const r = spawnSync('tar', ['-xzf', tarPath, '-C', destDir, '--strip-components=1'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`解压失败：${(r.stderr || '').slice(0, 200)}`);
}

function copyTree(from, to, { skip = new Set(), added = null } = {}) {
  let copied = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copied += copyTree(src, dst, { skip, added });
    } else {
      // 记录「原本不存在的文件」：回滚时要把它们删掉，否则残留新版本文件
      if (added && !fs.existsSync(dst)) added.push(dst);
      fs.copyFileSync(src, dst);
      copied += 1;
    }
  }
  return copied;
}

function healthReady(timeoutMs = 60000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${CONSOLE_PORT}/health/detail`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const j = await res.json();
          if (j && j.version) return resolve(j);
        }
      } catch { /* 还没起来 */ }
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(tick, 2000);
    };
    tick();
  });
}

function serviceExists() {
  if (!isWin) return false;
  return spawnSync('schtasks', ['/query', '/tn', 'qq-bridge'], { stdio: 'ignore' }).status === 0;
}

function restartService() {
  if (!isWin) return { ok: false, reason: '非 Windows' };
  if (has('--no-restart')) return { ok: false, reason: '--no-restart' };
  if (!serviceExists()) {
    // 常见情况：对方服务器是"手动 start.bat / pm2 / systemd"在跑，不是计划任务。
    // 这时候硬等健康检查只会误判成失败并回滚 —— 明确告诉他手动重启。
    return { ok: false, reason: 'no-task' };
  }
  const end = spawnSync('schtasks', ['/end', '/tn', 'qq-bridge'], { stdio: 'ignore' });
  spawnSync('timeout', ['/t', '3', '/nobreak'], { stdio: 'ignore' });
  const run = spawnSync('schtasks', ['/run', '/tn', 'qq-bridge'], { stdio: 'ignore' });
  return { ok: run.status === 0 || end.status === 0, reason: '' };
}

// --dry-run：只做解压与差异统计，不写根目录、不重启
async function apply({ dryRun = false } = {}) {
  head(dryRun ? '应用更新（预演，不写文件）' : '应用更新');
  const files = fs.existsSync(UPDATE_DIR) ? fs.readdirSync(UPDATE_DIR).filter((f) => f.endsWith('.tar.gz')).sort() : [];
  const tarball = path.join(UPDATE_DIR, files[files.length - 1] || '');
  if (!files.length) { bad('_update/ 里没有更新包，先跑 --download'); return 1; }

  const cur = localVersion();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const stage = path.join(UPDATE_DIR, 'stage');
  const backup = path.join(ROLLBACK_DIR, `${cur}-${stamp}`);

  info(`更新包：${path.basename(tarball)}`);
  info(`备份到：${path.relative(root, backup)}`);

  // 1) 解压到暂存区
  fs.rmSync(stage, { recursive: true, force: true });
  extract(tarball, stage);
  const newVersion = (() => {
    try { return String(readJsonFile(path.join(stage, 'package.json')).version || ''); }
    catch { return ''; }
  })();
  if (!newVersion) { bad('更新包里没有 package.json，可能解压错了'); return 1; }
  ok(`包内版本：${newVersion}`);

  if (dryRun) {
    const willCopy = [];
    for (const entry of fs.readdirSync(stage, { withFileTypes: true })) {
      if (PROTECTED.has(entry.name)) continue;
      willCopy.push(entry.name + (entry.isDirectory() ? '\\' : ''));
    }
    info(`将覆盖 ${willCopy.length} 个顶层条目：${willCopy.slice(0, 12).join(' ')}${willCopy.length > 12 ? ' …' : ''}`);
    info('受保护（不动）：config.json / state / node_modules / .git / data / logs / audio');
    ok('预演结束：没有写任何文件');
    fs.rmSync(stage, { recursive: true, force: true });
    return 0;
  }

  // 2) 备份当前程序文件（不含运行态）
  fs.mkdirSync(backup, { recursive: true });
  const copiedBackup = copyTree(root, backup, { skip: PROTECTED });
  ok(`已备份 ${copiedBackup} 个文件`);

  // 3) 覆盖（保护 config/state/node_modules/.git…）
  const added = [];
  const copied = copyTree(stage, root, { skip: PROTECTED, added });
  ok(`已覆盖 ${copied} 个文件（其中新增 ${added.length} 个）`);

  // 4) 重启（交给计划任务，不由本进程负责 —— 这是与"别人家更新器"最大的区别）
  const restart = process.env.QQB_UPDATE_SKIP_RESTART === '1'
    ? { ok: false, reason: 'QQB_UPDATE_SKIP_RESTART=1' }
    : (() => { info('重启交给计划任务 qq-bridge（更新器只换文件）'); return restartService(); })();
  if (!restart.ok) {
    warn(`没有自动重启（原因：${restart.reason || '未知'}）`);
    info('文件已覆盖完成。请手动重启你的服务进程，然后看控制台「运行报告」确认版本号。');
    info('  · 计划任务：schtasks /run /tn qq-bridge');
    info('  · 手动启动：launcher.bat / 启动器.cmd / 你自己的进程管理器');
    fs.rmSync(stage, { recursive: true, force: true });
    ok('本次更新：文件已就位，等待你手动重启（未做健康检查，也就不会误回滚）');
    return 0;
  }

  // 5) 健康检查
  info('等健康检查（最多 60 秒）…');
  const health = await healthReady(60000);
  if (health && String(health.version) === newVersion) {
    ok(`更新成功：${health.version}（ready=${health.ready}）`);
    fs.rmSync(stage, { recursive: true, force: true });
    return 0;
  }

  // 6) 失败回滚
  bad(`健康检查没过（期望 ${newVersion}，实际 ${health ? health.version : '无响应'}）—— 开始回滚`);
  for (const p of added) { try { fs.rmSync(p, { force: true }); } catch { /* 删不掉就算了 */ } }
  copyTree(backup, root, { skip: PROTECTED });
  ok(`已回滚文件（并清掉新增的 ${added.length} 个）`);
  restartService();
  const back = await healthReady(45000);
  if (back) warn(`已回滚到 ${back.version}（ready=${back.ready}）—— 请看日志排查`);
  else bad('回滚后仍未起来，需要人工处理：看 state/bridge.log 与 _rollback 里的备份');
  return 1;
}

// ── 入口 ────────────────────────────────────────────────────────────────
console.log('');
console.log(c('36', '  qq-bridge 自更新'));
console.log(`  仓库：${REPO}   本地：${localVersion()}`);

let code = 0;
if (has('--check')) code = (await check()).ok ? 0 : 1;
else if (has('--download')) code = await download();
else if (has('--apply')) {
  const dryRun = has('--dry-run');
  warn(dryRun
    ? '--dry-run：只解压+统计，不覆盖、不重启'
    : '--apply 会覆盖程序文件（config/state 不动），失败会自动回滚');
  if (dryRun) code = await apply({ dryRun: true });
  else if (has('--yes') || process.env.QQB_UPDATE_YES === '1') code = await apply({});
  else { info('确认后加 --yes 执行：node scripts/update.mjs --apply --yes'); code = 0; }
} else {
  head('用法');
  info('--check     只检查版本');
  info('--download  下载到 _update/');
  info('--apply --yes  备份 → 覆盖 → 重启 → 健康检查（失败自动回滚）');
  info('--no-restart  只换文件，不重启（对方不是计划任务时用这个）');
  info('--proxy <url>  访问 GitHub 用代理');
}
process.exitCode = code;
