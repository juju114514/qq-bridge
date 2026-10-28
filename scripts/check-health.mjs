#!/usr/bin/env node
// 一键体检：进程/端口、控制台、双通道、数据文件、记忆、配额、审计。
//
// 用法：node scripts/check-health.mjs [--base http://127.0.0.1:3100] [--skip-audit]
// 退出码：0 = 全绿；1 = 有失败项（告警项不算失败）

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const argOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : ''; };
// 部署目录（D:\deepseek工作区\qq-bridge）和仓库目录是两个地方：
// 默认用当前工作目录，找不到 state/console-token 再退回脚本所在仓库。
const cwdRoot = process.cwd();
const ROOT = argOf('--root')
  || (fs.existsSync(path.join(cwdRoot, 'state', 'console-token')) ? cwdRoot : SCRIPT_ROOT);
const BASE = argOf('--base') || 'http://127.0.0.1:3100';
const SKIP_AUDIT = args.includes('--skip-audit');

let fail = 0;
const ok = (label, detail = '') => console.log(`  ✓ ${label}${detail ? `：${detail}` : ''}`);
const warn = (label, detail = '') => console.log(`  ⚠ ${label}${detail ? `：${detail}` : ''}`);
const bad = (label, detail = '') => { fail++; console.log(`  ✗ ${label}${detail ? `：${detail}` : ''}`); };

function readToken() {
  try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); }
  catch { return ''; }
}

async function getJson(url, token) {
  const res = await fetch(url, {
    headers: token ? { 'X-Console-Token': token } : {},
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

console.log('\n══ qq-bridge 体检 ══\n');

// 1) 控制台
const token = readToken();
let status = null;
try {
  status = await getJson(`${BASE}/api/status`, token);
  ok('控制台可达', `${BASE}`);
  status.dshReady ? ok('DSH 已就绪') : bad('DSH 未就绪');
  ok('当前模式', String(status.mode ?? '?'));
  if (status.snowluma?.connected) ok('SnowLuma 已连接');
  else warn('SnowLuma 未连接', '个人号通道不可用（不影响官方通道）');
  if (status.snowluma?.accountOnline === true) ok('QQ 账号在线');
  else if (status.snowluma?.accountOnline === false) warn('QQ 账号离线');
} catch (error) {
  bad('控制台不可达', `${BASE}（${error.message}）`);
}

// 2) 官方通道
try {
  const pro = await getJson(`${BASE}/api/socialV2/official-proactive`, token);
  if (pro.enabled) {
    ok('官方通道已启用', `ready=${pro.ready}`);
    ok('主动消息配额', `${pro.quota?.limits?.group?.perMinute ?? '?'}/分 ${pro.quota?.limits?.group?.perDay ?? '?'}/天`);
    pro.recall?.enabled ? ok('互动召回已启用') : warn('互动召回未启用');
    ok('定时播报', `${(pro.schedules ?? []).length} 条`);
  } else {
    warn('官方通道未启用', 'config.official.enabled=false');
  }
} catch (error) {
  warn('官方通道状态查询失败', error.message);
}

// 3) 数据文件
const files = ['social-v2.json', 'pending-queue.json', 'official-proactive.json', 'official-recall.json'];
for (const f of files) {
  const p = path.join(ROOT, 'state', f);
  if (!fs.existsSync(p)) { warn(`数据文件缺失：${f}`, '首次运行可忽略'); continue; }
  const size = fs.statSync(p).size;
  try {
    JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    ok(`数据文件：${f}`, `${(size / 1024).toFixed(1)}KB`);
  } catch (e) {
    bad(`数据文件损坏：${f}`, e.message);
  }
}

// 4) 会话与记忆
try {
  const sv = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
  const convs = Object.values(sv.conversations ?? {});
  const atoms = convs.reduce((n, c) => n + (Array.isArray(c?.longTermMemories) ? c.longTermMemories.length : 0), 0);
  ok('会话数', String(convs.length));
  ok('长期记忆条目', String(atoms));
} catch { /* 上面已报 */ }

// 5) 队列
try {
  const q = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'pending-queue.json'), 'utf8').replace(/^\uFEFF/, ''));
  const n = Object.values(q.queues ?? q ?? {}).reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0);
  n === 0 ? ok('待投递队列为空') : warn('待投递队列非空', `${n} 条（重启后会补投）`);
} catch { /* ignore */ }

// 6) 审计
if (!SKIP_AUDIT) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'test-audit.mjs')], {
      cwd: ROOT, encoding: 'utf8', timeout: 900000
    });
    const m = out.match(/Audit suite:\s*(\d+)\/(\d+)/);
    if (m && m[1] === m[2]) ok('审计套件', `${m[1]}/${m[2]}`);
    else bad('审计套件', m ? `${m[1]}/${m[2]}` : '无结果');
  } catch (error) {
    bad('审计套件失败', String(error?.message ?? error).split('\n')[0]);
  }
}

console.log(`\n${fail === 0 ? '结果：全绿 ✓' : `结果：${fail} 项失败`}\n`);
process.exitCode = fail === 0 ? 0 : 1;
