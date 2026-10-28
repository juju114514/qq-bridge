// 装机体检：把"装不起来"的四个卡点逐条诊断，并且**每条都给可复制的修法**。
//
// 四个卡点（按真实安装里最容易卡死的顺序）：
//   1. Node 版本   —— 低于 22 直接换不起来（fetch/内置模块差异）
//   2. DSH 位置    —— 装 preset 需要找到 .dsh 目录，路径各机器不同
//   3. SnowLuma    —— 没起/没扫码，个人号通道就永远连不上
//   4. 官方通道    —— AppID/Secret 没配、或配错了（token 接口直接报错）
//
// 设计：纯函数 + 依赖注入，全部可离线测试（不碰真网络/真文件系统）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MIN_NODE_MAJOR = 22;

/** '22.23.2' → { major: 22, minor: 23, patch: 2, ok: true } */
export function parseNodeVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!m) return { major: 0, minor: 0, patch: 0, ok: false, raw: String(version ?? '') };
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  return { major, minor, patch, ok: major >= MIN_NODE_MAJOR, raw: String(version) };
}

/** DSH 候选目录：环境变量 > 家目录 > 常见安装位置。 */
export function dshCandidates({ env = process.env, homedir = os.homedir() } = {}) {
  const list = [];
  if (env.DSH_HOME) list.push(env.DSH_HOME);
  list.push(path.join(homedir, '.dsh'));
  if (env.LOCALAPPDATA) {
    list.push(path.join(env.LOCALAPPDATA, 'DeepSeek Harness'));
    list.push(path.join(env.LOCALAPPDATA, 'Programs', 'deepseek-harness'));
    list.push(path.join(env.LOCALAPPDATA, 'deep seek', 'resources'));
  }
  if (env.APPDATA) list.push(path.join(env.APPDATA, 'DeepSeek Harness'));
  if (process.platform === 'darwin') list.push(path.join(homedir, 'Applications', 'DeepSeek Harness.app'));
  list.push('/opt/deepseek-harness', '/usr/local/lib/deepseek-harness');
  return list;
}

/** 找到 DSH（可注入 exists，便于测试）。 */
export function findDsh({ env = process.env, homedir = os.homedir(), exists = fs.existsSync } = {}) {
  const candidates = dshCandidates({ env, homedir });
  for (const c of candidates) {
    try {
      if (c && exists(c)) return { ok: true, home: c, candidates };
    } catch { /* ignore */ }
  }
  return { ok: false, home: '', candidates };
}

/** SnowLuma 探活（注入 probe，默认真连一次）。 */
export async function checkSnowLuma({ host = '127.0.0.1', ports = [3000, 5099, 3001], probe } = {}) {
  const tryProbe = probe ?? (async (h, p) => {
    const net = await import('node:net');
    return await new Promise((resolve) => {
      const sock = net.connect({ host: h, port: p });
      const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
      sock.setTimeout(700);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    });
  });
  const open = [];
  for (const p of ports) {
    if (await tryProbe(host, p)) open.push(p);
  }
  // 5099 是 SnowLuma 控制台（扫码页），3000 是 OneBot HTTP
  return { ok: open.length > 0, open, qrUrl: open.includes(5099) ? 'http://127.0.0.1:5099' : '' };
}

/** 官方通道是否配置齐全（只看配置，不发网络请求）。 */
export function checkOfficial({ config } = {}) {
  const o = config?.official ?? {};
  const appid = String(o.appid ?? '').trim();
  const secret = String(o.secret ?? '').trim();
  const enabled = o.enabled === true;
  const allow = Array.isArray(o.allow) ? o.allow.filter(Boolean) : [];
  const problems = [];
  if (!enabled) problems.push('未启用（config.official.enabled=false）');
  if (!appid || !secret) problems.push('缺 AppID / AppSecret');
  if (enabled && allow.length === 0) problems.push('白名单为空（official.allow 里要填群 openid 或用户 openid）');
  return { ok: problems.length === 0, enabled, hasCreds: Boolean(appid && secret), allowCount: allow.length, problems };
}

/**
 * 生成报告：每条一行，带修法。
 * @returns {{lines:string[], failed:number, warned:number}}
 */
export function renderReport(items) {
  const lines = [];
  let failed = 0;
  let warned = 0;
  for (const it of items) {
    const mark = it.level === 'ok' ? '✓' : it.level === 'warn' ? '⚠' : '✗';
    if (it.level === 'fail') failed += 1;
    if (it.level === 'warn') warned += 1;
    lines.push(`${mark} ${it.title}${it.detail ? ` —— ${it.detail}` : ''}`);
    if (it.fix && it.level !== 'ok') lines.push(`   → ${it.fix}`);
  }
  return { lines, failed, warned };
}

/** 汇总四项检查（Node 用真实版本，其余可注入）。 */
export async function diagnose({ nodeVersion = process.versions.node, env = process.env, homedir = os.homedir(), exists = fs.existsSync, config = {}, probe } = {}) {
  const items = [];

  const nv = parseNodeVersion(nodeVersion);
  items.push(nv.ok
    ? { key: 'node', level: 'ok', title: `Node ${nv.raw}`, detail: `≥ ${MIN_NODE_MAJOR} 满足要求` }
    : { key: 'node', level: 'fail', title: `Node ${nv.raw || '未安装'}`, detail: `需要 ≥ ${MIN_NODE_MAJOR}`,
        fix: 'Windows: winget install OpenJS.NodeJS.LTS ｜ 或跑 scripts/setup.ps1（会下载便携版到 tools\\node）' });

  const dsh = findDsh({ env, homedir, exists });
  items.push(dsh.ok
    ? { key: 'dsh', level: 'ok', title: `DSH 目录：${dsh.home}` }
    : { key: 'dsh', level: 'warn', title: 'DSH 目录没找到', detail: '桥接仍能跑，但装 preset / 自动探测端口会退化成手动',
        fix: '设置环境变量 DSH_HOME 指向你的 .dsh 目录（DSH 启动后一般在家目录下），或先启动一次 DSH' });

  const sl = await checkSnowLuma({ probe });
  items.push(sl.ok
    ? { key: 'snowluma', level: 'ok', title: `SnowLuma 在线（端口 ${sl.open.join('/')}）`,
        detail: sl.qrUrl ? `扫码页：${sl.qrUrl}` : 'OneBot HTTP 端口在线' }
    : { key: 'snowluma', level: 'fail', title: 'SnowLuma 没起', detail: '个人号通道不可用；官方通道不受影响',
        fix: '启动 SnowLuma 后打开 http://127.0.0.1:5099 扫码登录；它不随本仓库安装' });

  const off = checkOfficial({ config });
  items.push(off.ok
    ? { key: 'official', level: 'ok', title: '官方通道已配置', detail: `白名单 ${off.allowCount} 个` }
    : { key: 'official', level: off.enabled ? 'fail' : 'warn', title: '官方通道未就绪', detail: off.problems.join('；'),
        fix: '跑 scripts/setup.ps1 按提示粘贴 AppID/AppSecret（会当场验证），或手动填 config.official' });

  return items;
}

// ── CLI ────────────────────────────────────────────────────────────────────
async function main() {
  let config = {};
  // 先看当前工作目录（用户在自己部署目录里跑），再看仓库目录（开发者自测）
  const cfgCandidates = [
    path.resolve(process.cwd(), 'config.json'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'config.json')
  ];
  for (const p of cfgCandidates) {
    try {
      if (fs.existsSync(p)) { config = JSON.parse(fs.readFileSync(p, 'utf8')); break; }
    } catch { /* 配置坏了也要能跑体检 */ }
  }

  const items = await diagnose({ config });
  const { lines, failed, warned } = renderReport(items);
  console.log('\n  装机体检（4 个最常见卡点）\n');
  for (const l of lines) console.log(l.startsWith('   ') ? l : `  ${l}`);
  console.log('');
  console.log(failed === 0
    ? `  结论：${warned === 0 ? '全部就绪，可以启动了' : `可用（${warned} 项警告，不影响核心）`}`
    : `  结论：${failed} 项必须先修（上面带 ✗ 的）`);
  console.log('');
  process.exitCode = failed === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main();
