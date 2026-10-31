// GET /api/report —— 运行报告（0.4.74）
//
// 单独成文件的原因：这堆聚合逻辑（runner 事件、看门狗、磁盘、内存、配置摘要）会一直长，
// 塞进 console-extra-routes 会撑爆行数棘轮。
//
// 只读：不发消息、不改配置、不重启。判定与脱敏都在 src/report-build.js（纯函数，有单测）。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { buildReport } from '../report-build.js';

function diskOf(dir) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(dir);
      const totalGb = Number((st.blocks * st.bsize) / 1024 ** 3);
      const freeGb = Number((st.bavail * st.bsize) / 1024 ** 3);
      return { freeGb: Number(freeGb.toFixed(1)), totalGb: Number(totalGb.toFixed(1)), path: dir };
    }
  } catch { /* 老 Node 或没权限 */ }
  return null;
}

export function handleReportRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!req || !url || url.pathname !== '/api/report') return false;
  if (req.method !== 'GET') return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const read = typeof d.readFile === 'function' ? d.readFile : () => '';
  const parseRunner = d.parseRunnerEvents || (() => []);
  const parseWatch = d.parseWatchdogEvents || (() => []);

  let runnerEvents = [];
  let watchdogEvents = [];
  try { runnerEvents = parseRunner(String(read(d.files?.runner) || '').split('\n')) || []; } catch { runnerEvents = []; }
  try { watchdogEvents = parseWatch(String(read(d.files?.watchdog) || '').split('\n')) || []; } catch { watchdogEvents = []; }

  const now = Date.now();
  const since = now - 24 * 3600 * 1000;
  const restarts = runnerEvents.filter((e) => e.kind === 'restart' && e.at >= since).length;
  const exits = runnerEvents.filter((e) => e.kind === 'exit' && e.at >= since);
  const lastExit = runnerEvents.filter((e) => e.kind === 'exit').slice(-1)[0] || null;
  const watch24 = watchdogEvents.filter((e) => e.at >= since);
  const lastWatch = watchdogEvents.slice(-1)[0] || null;

  // 网关断开次数：从 bridge.log 里数（"[gateway] WS 已恢复（累计断开 N 次）"）
  let disconnects = 0;
  let lastRecoverAt = 0;
  try {
    const logText = String(read(d.files?.bridgeLog) || '');
    const matches = [...logText.matchAll(/WS 已恢复（累计断开 (\d+) 次）/g)];
    if (matches.length) {
      disconnects = Number(matches[matches.length - 1][1]) || 0;
      lastRecoverAt = now; // 日志无时间戳时退化为"现在"；下面的行内时间戳优先
      const tail = logText.split('\n').slice(-200).filter((l) => l.includes('WS 已恢复'));
      if (tail.length) {
        const m = tail[tail.length - 1].match(/^(\d{2}:\d{2}:\d{2})/);
        if (m) {
          const [hh, mm, ss] = m[1].split(':').map(Number);
          const dt = new Date(now);
          dt.setHours(hh, mm, ss, 0);
          lastRecoverAt = dt.getTime();
        }
      }
    }
  } catch { /* 日志读不到就不显示 */ }

  // 消息错误数：bridge.log 里的 ⚠️/发送失败 行（粗略，但足以判断"最近是否异常"）
  let errorLines = 0;
  let lastError = '';
  try {
    const lines = String(read(d.files?.bridgeLog) || '').split('\n');
    const tail = lines.slice(-2000).filter((l) => /发送失败|处理失败|转交失败|✗/.test(l));
    errorLines = tail.length;
    lastError = tail.slice(-1)[0] || '';
  } catch { /* ignore */ }

  // 断电/异常关机（0.4.84）：本进程启动时检测到的 + 最近 7 天的历史
  let bootIncidents = [];
  let boot7d = 0;
  let bootNow = null;
  try {
    bootIncidents = typeof d.listBootIncidents === 'function' ? (d.listBootIncidents(5) || []) : [];
    boot7d = typeof d.countBootIncidents === 'function' ? (d.countBootIncidents(7) || 0) : 0;
    bootNow = typeof d.getBootIncident === 'function' ? d.getBootIncident() : null;
  } catch { /* 读不到就算了 */ }

  const runtime = typeof d.getOfficialRuntime === 'function' ? (d.getOfficialRuntime() || {}) : {};
  const cfg = (typeof d.getCfg === 'function' ? d.getCfg() : {}) || {};
  const mem = process.memoryUsage();

  const report = buildReport({
    version: (typeof d.getVersion === 'function' ? d.getVersion() : '') || '',
    buildId: process.env.DSH_BUILD_ID || '',
    processInfo: {
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapMb: Math.round(mem.heapUsed / 1024 / 1024),
      startedAt: now - Math.round(process.uptime() * 1000)
    },
    services: {
      dsh: runtime.dshReady === true ? 'connected' : (typeof d.getDshState === 'function' ? d.getDshState() : 'unknown'),
      gateway: typeof d.getGatewayState === 'function' ? d.getGatewayState() : 'unknown',
      official: runtime.enabled ? (runtime.ready ? 'connected' : 'starting') : 'disabled'
    },
    supervisor: {
      restarts24h: restarts,
      exits24h: exits.length,
      lastExit: lastExit ? { code: lastExit.code, at: lastExit.at } : null,
      watchdog24h: watch24.length,
      watchdogLatest: lastWatch ? { at: lastWatch.at, text: lastWatch.text } : null
    },
    gatewayStats: { disconnects, lastRecoverAt },
    messages: { runs: 0, errors: errorLines, lastError },
    disk: diskOf(path.resolve(process.cwd())),
    bootWatch: {
      uncleanThisBoot: Boolean(bootNow),
      thisBoot: bootNow,
      incidents7d: boot7d,
      recent: bootIncidents,
      describe: typeof d.describeBootIncident === 'function' ? (x) => d.describeBootIncident(x) : null
    },
    configSummary: {
      mode: (typeof d.getMode === 'function' ? d.getMode() : '') || '',
      ownerQQ: String(cfg.ownerQQ || ''),
      groups: Array.isArray(cfg.allow?.groups) ? cfg.allow.groups.length : 0,
      privates: Array.isArray(cfg.allow?.private) ? cfg.allow.private.length : 0,
      officialEnabled: cfg.official?.enabled === true,
      officialProbe: false
    },
    repoPath: process.cwd(),
    now
  });

  // 两种输出：默认 JSON（控制台渲染），?format=md 直接拿文本（方便 curl 下来贴给别人）
  if (String(url.searchParams?.get('format') || '') === 'md') {
    sendJson({ ok: true, overall: report.overall, markdown: report.markdown, host: os.hostname() });
  } else {
    sendJson({ ok: true, overall: report.overall, checks: report.checks, markdown: report.markdown, host: os.hostname(), at: now });
  }
  return true;
}
