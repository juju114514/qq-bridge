// 把"重启"分成"计划内（部署/手动）"和"真崩溃"（0.4.102）
//
// 起因：今天的运行报告判 FAIL —— 「24h 重启 10 次」。但那 10 次全是我在发版：
// 每次部署都 schtasks /end + /run，退出码是 1（被强杀）。
// 报告把"部署"和"崩溃"算成一类，于是每次发版都让报告变红，反而淹没了真问题。
//
// 做法：部署/手动重启前写一条「计划内重启」标记（带时间），报告按时间窗口把重启归类：
//   · 重启时间 ±windowMs 内有一条计划标记 → 计划内
//   · 否则 → 未计划（真崩溃）
import fs from 'node:fs';
import path from 'node:path';

export const PLANNED_WINDOW_MS = 5 * 60 * 1000;   // 5 分钟窗口
export const PLANNED_KEEP = 200;

export function addPlannedMarker(file, info = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({ at: Number(info.at || Date.now()), reason: String(info.reason || 'deploy'), by: String(info.by || '') });
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    old.push(line);
    fs.writeFileSync(file, `${old.slice(-PLANNED_KEEP).join('\n')}\n`);
    return true;
  } catch {
    return false;
  }
}

export function listPlannedMarkers(file, { limit = PLANNED_KEEP } = {}) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .slice(-limit);
  } catch {
    return [];
  }
}

/**
 * 把重启事件按计划标记分类。
 * @param {Array<{at:number, code?:number}>} restarts 重启事件（时间戳 ms）
 * @param {Array<{at:number, reason?:string}>} markers 计划标记
 * @returns {{planned:Array, unplanned:Array, plannedCount:number, unplannedCount:number}}
 */
export function classifyRestarts(restarts = [], markers = [], { windowMs = PLANNED_WINDOW_MS } = {}) {
  const planned = [];
  const unplanned = [];
  const ms = (Array.isArray(markers) ? markers : []).map((m) => Number(m?.at || 0)).filter((n) => n > 0).sort((a, b) => a - b);

  for (const r of Array.isArray(restarts) ? restarts : []) {
    const at = Number(r?.at || r || 0);
    if (!at) continue;
    const hit = ms.some((m) => Math.abs(m - at) <= windowMs);
    if (hit) planned.push({ ...(typeof r === 'object' ? r : { at }), at });
    else unplanned.push({ ...(typeof r === 'object' ? r : { at }), at });
  }
  return { planned, unplanned, plannedCount: planned.length, unplannedCount: unplanned.length };
}

/** 报告里那一句话 */
export function describeRestarts({ total = 0, plannedCount = 0, unplannedCount = 0 } = {}) {
  if (!total) return '24h 内没有重启';
  if (!plannedCount) return `24h 重启 ${total} 次（全部不是计划内）`;
  if (!unplannedCount) return `24h 重启 ${total} 次（全部是计划内：部署/手动）`;
  return `24h 重启 ${total} 次（计划内 ${plannedCount} 次 · 未计划 ${unplannedCount} 次）`;
}

/**
 * 报告用的判定：把"总重启 / 计划标记 / 现在"变成一条检查结论。
 * 逻辑放这里（而不是 report-build），是为了让 report-build 不再膨胀。
 */
export function judgeRestarts(totalRestarts, plannedMarkers, now = Date.now(), { dayMs = 24 * 3600 * 1000 } = {}) {
  const total = Number(totalRestarts) || 0;
  const dayAgo = Number(now) - dayMs;
  const plannedIn24h = (Array.isArray(plannedMarkers) ? plannedMarkers : [])
    .filter((x) => Number(x?.at || 0) >= dayAgo).length;
  const attributed = Math.min(plannedIn24h, total);
  const unplanned = Math.max(0, total - attributed);
  if (total === 0) return { level: 'ok', title: '24h 无重启', detail: '最理想', attributed, unplanned };
  if (unplanned === 0) {
    return { level: 'ok', title: `24h 重启 ${total} 次（都是计划内）`, detail: '部署/手动重启，不算稳定性问题', attributed, unplanned };
  }
  if (unplanned <= 2) {
    return { level: 'warn', title: `24h 未计划重启 ${unplanned} 次`, detail: `总重启 ${total} 次，其中计划内 ${attributed} 次；看下面的退出码`, attributed, unplanned };
  }
  return { level: 'bad', title: `24h 未计划重启 ${unplanned} 次`, detail: `总重启 ${total} 次（计划内 ${attributed} 次）；先查退出码与内存`, attributed, unplanned };
}
