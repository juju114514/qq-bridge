// 断电 / 崩溃检测（0.4.84）
//
// 为什么需要：运行报告的"连续运行 0 分钟 + 24h 重启 0 次"在断电后是**误导**——
// 机器断电时 runner 根本没机会记录 child_exit，看门狗也被一起干掉。
// 用户看到的是"刚启动、没重启过"，而真相是"它昨晚被拔了电"。
//
// 做法（三个小文件，纯增量，不依赖任何外部命令）：
//   1. state/heartbeat.json    每 30 秒写一次 {at, pid}          —— 用来判断"上次活到什么时候"
//   2. state/runtime-marker.json 启动时写 {pid, startedAt, clean:false}
//                               正常退出时改成 {clean:true, at}
//   3. state/incidents.jsonl   启动时若发现上次没正常退出，追加一条事件
//
// 判定规则（宁可少报，不要瞎报）：
//   · 有 marker 且 clean=true                → 正常关闭
//   · 有 marker、clean=false、心跳很新(<90s) → 可能是快速重启（脚本重启），不算断电
//   · 有 marker、clean=false、心跳断档 ≥90s → **非正常关闭**（断电/蓝屏/强杀）
//   · 没有 marker 但有心跳               → 同样按断档判断
//   · 什么都没有（首次运行）               → 不算异常
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './atomic-write.js';

export const HEARTBEAT_GAP_MS = 90 * 1000;      // 心跳超过这个没更新 = 断电/强杀
export const INCIDENT_KEEP = 50;                // 事件文件最多留 50 条

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function writeJsonSafe(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteJson(file, obj);
    return true;
  } catch {
    return false;
  }
}

export function writeHeartbeat(file, { pid = process.pid, now = Date.now() } = {}) {
  return writeJsonSafe(file, { at: now, pid });
}

export function markRunning(markerFile, { pid = process.pid, now = Date.now(), version = '' } = {}) {
  return writeJsonSafe(markerFile, { pid, startedAt: now, clean: false, version });
}

export function markCleanExit(markerFile, { pid = process.pid, now = Date.now(), reason = 'exit' } = {}) {
  return writeJsonSafe(markerFile, { pid, clean: true, at: now, reason });
}

/**
 * 判断上一次是不是"非正常关闭"。
 * @param {{marker:object|null, heartbeat:object|null, now:number, gapMs?:number}} p
 * @returns {{unclean:boolean, reason:string, lastSeenAt:number, gapMs:number, sinceStartMs:number}}
 */
export function detectUncleanShutdown({ marker = null, heartbeat = null, now = Date.now(), gapMs = HEARTBEAT_GAP_MS } = {}) {
  const lastSeenAt = Math.max(Number(marker?.at || 0), Number(heartbeat?.at || 0), Number(marker?.startedAt || 0));
  if (!lastSeenAt) {
    return { unclean: false, reason: 'first-run', lastSeenAt: 0, gapMs: 0, sinceStartMs: 0 };
  }
  const sinceStartMs = Math.max(0, now - lastSeenAt);
  if (marker && marker.clean === true) {
    return { unclean: false, reason: 'clean-exit', lastSeenAt, gapMs: 0, sinceStartMs };
  }
  if (sinceStartMs >= gapMs) {
    return {
      unclean: true,
      reason: 'unexpected',
      lastSeenAt,
      gapMs: sinceStartMs,
      sinceStartMs
    };
  }
  return { unclean: false, reason: 'fast-restart', lastSeenAt, gapMs: sinceStartMs, sinceStartMs };
}

/** 追加一条异常事件（JSONL，保留最近 INCIDENT_KEEP 条） */
export function appendIncident(file, incident) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify(incident) + '\n';
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    old.push(line.trimEnd());
    const kept = old.slice(-INCIDENT_KEEP);
    // 事件文件是 JSONL（不是 JSON），atomicWriteJson 不适用，这里显式标注重写原因
    // guard-allow: renameSync 写 JSONL 事件流，不是 JSON 状态文件
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, kept.join('\n') + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 读最近的事件（新的在前） */
export function listIncidents(file, { limit = 10 } = {}) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse()
      .slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}

/** 最近 N 天内的异常关机次数 */
export function countRecentIncidents(file, { days = 7, now = Date.now() } = {}) {
  const since = now - days * 24 * 3600 * 1000;
  return listIncidents(file, { limit: INCIDENT_KEEP }).filter((x) => Number(x.at || 0) >= since).length;
}

/** 给报告用的一句话 */
export function describeIncident(incident) {
  if (!incident) return '';
  const mins = Math.round(Number(incident.gapMs || 0) / 60000);
  return `上次心跳 ${new Date(Number(incident.lastSeenAt || 0)).toLocaleString('zh-CN')}，`
    + `之后断了约 ${mins >= 1 ? mins + ' 分钟' : Math.round(Number(incident.gapMs || 0) / 1000) + ' 秒'}`
    + (incident.note ? `（${incident.note}）` : '');
}
