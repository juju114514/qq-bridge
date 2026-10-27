#!/usr/bin/env node
// 「会话繁忙 / 唤醒被暂存」诊断：一条命令看清"是正常在跑回合，还是卡住了"。
//
// 背景（用户实际看到的日志）：
//   [reserved2] 会话繁忙，暂存唤醒原因 private:xxx（private@seq304，原因=pendingWakeKey）
// 这行本身**不是错误**——它表示「AI 这一回合还没结束，新唤醒先排队」。但如果是回合丢了
// （DSH 重启把 turn 丢了、turn/end 没回来），会话会一直忙到 30 分钟租约到期，期间的
// 现象就是「AI 一句不回」。
//
// 这个脚本读 /api/status 的 socialV2Busy（操作端才有），把判定依据摊开：
//   忙的原因 / 回合已跑多久 / pendingWakeKey 上锁多久 / 租约还剩多久 / 暂存了几条
//
// 用法：
//   node scripts/diag-session-busy.mjs                 # 看所有忙着的会话
//   node scripts/diag-session-busy.mjs --key private:123
//   node scripts/diag-session-busy.mjs --json
//   node scripts/diag-session-busy.mjs --base http://127.0.0.1:3100
//
// 退出码：0 = 没有卡住的会话（可能全都空闲）；1 = 有会话满足「看起来卡住」的判据
//         （回合/上锁超过 10 分钟，或暂存唤醒 ≥ 5 条）；2 = 连不上/读不到状态

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const BASE = val('--base', 'http://127.0.0.1:3100').replace(/\/+$/, '');
const ONLY_KEY = val('--key', '');
const JSON_OUT = has('--json');
// 判据：这些阈值不是"规范"，是用来区分"正常跑一轮"和"卡住了"的经验值
const STUCK_MS = 10 * 60 * 1000;
const STUCK_QUEUE = 5;

function readToken() {
  for (const p of [path.join(ROOT, 'state', 'console-token'), path.join(ROOT, '..', 'state', 'console-token')]) {
    try { return fs.readFileSync(p, 'utf8').trim(); } catch { /* next */ }
  }
  return '';
}

const fmt = (ms) => {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(Number(ms) / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`;
};

const token = readToken();
if (!token) {
  console.error('  [FAIL] 找不到 state/console-token：桥接没启动过？');
  process.exit(2);
}

let status;
try {
  const res = await fetch(`${BASE}/api/status`, { headers: { 'x-console-token': token } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  status = await res.json();
} catch (error) {
  console.error(`  [FAIL] 读不到 ${BASE}/api/status：${error?.message ?? error}`);
  console.error('         （桥接没启动 / 端口变了 / 令牌不对；见 TROUBLESHOOTING C1、I2）');
  process.exit(2);
}

const all = Array.isArray(status.socialV2Busy) ? status.socialV2Busy : [];
const rows = ONLY_KEY ? all.filter((r) => r.key === ONLY_KEY) : all;

const stuck = rows.filter((r) => (r.turnStartedAgoMs ?? 0) > STUCK_MS
  || (r.armedAgoMs ?? 0) > STUCK_MS
  || (r.pendingWakeReasons ?? 0) >= STUCK_QUEUE);

if (JSON_OUT) {
  console.log(JSON.stringify({ base: BASE, paused: status.socialV2Paused, total: all.length, rows, stuck: stuck.length }, null, 2));
} else {
  console.log('');
  console.log(`  会话繁忙诊断    ${BASE}    AI 暂停(paused)=${status.socialV2Paused === true}`);
  console.log('  ' + '─'.repeat(78));
  if (!all.length) {
    console.log('  当前没有任何会话处于「繁忙」状态。');
    console.log('  （如果你刚看到「会话繁忙」日志，说明那一回合已经结束了，属于正常排队）');
  } else {
    console.log('  key'.padEnd(30) + '原因'.padEnd(16) + '回合'.padEnd(8) + '上锁'.padEnd(8) + '租约剩'.padEnd(8) + '暂存');
    for (const r of rows) {
      const reason = String(r.reason ?? '—');
      console.log('  ' + String(r.key).padEnd(28)
        + reason.padEnd(14)
        + fmt(r.turnStartedAgoMs).padEnd(8)
        + fmt(r.armedAgoMs).padEnd(8)
        + fmt(r.leaseLeftMs).padEnd(8)
        + String(r.pendingWakeReasons ?? 0) + (r.queuedPrompts ? `  (队列 ${r.queuedPrompts})` : ''));
    }
    if (ONLY_KEY && !rows.length) console.log(`  （${ONLY_KEY} 不在忙列表里：它现在是空闲的）`);
  }
  console.log('  ' + '─'.repeat(78));
  if (!stuck.length) {
    console.log('  判定：没有看起来卡住的会话。');
  } else {
    console.log(`  判定：${stuck.length} 个会话看起来卡住了（回合/上锁 >10 分钟，或暂存唤醒 ≥${STUCK_QUEUE} 条）`);
    console.log('        处置顺序（详细步骤见 docs/guides/SESSION-BUSY.md）：');
    console.log('          1) 等 30 分钟租约自动解除（日志会打「已按 30 分钟租约强制解除」）');
    console.log('          2) 或控制台切一次模式（chat → reserved2）会清空全部 busy 标记');
    console.log('          3) 或重启桥接（最干脆；state 不会丢）');
  }
  console.log('');
}

process.exit(stuck.length ? 1 : 0);
