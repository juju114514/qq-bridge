// 守护进程视图（0.4.62）：把「进程存活」与「日志里发生过什么」拼成一张图。
//
// 为什么单独一个模块：
//   · 存活判断必须用**真实进程信息**（/health/detail 的 process），不能用"日志文件存在"代替
//   · 日志只能说明"过去发生过重启"，不能说明"现在在跑"
//   · 两者矛盾时必须**显式提示**，而不是各显示各的让用户自己猜
//
// 纯函数：输入都是普通数据，便于单测。

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** 把 runner / watchdog 两类事件合并成一条时间线（倒序），最多保留 limit 条 */
export function mergeEvents({ runnerEvents = [], watchdogEvents = [], limit = 20 } = {}) {
  const rows = [];
  for (const e of Array.isArray(runnerEvents) ? runnerEvents : []) {
    if (!e || !e.at) continue;
    if (e.kind === 'exit') rows.push({ at: e.at, source: 'runner', kind: 'exit', text: `子进程退出（code=${e.code}${e.attempt ? `，第 ${e.attempt} 次` : ''}）` });
    else if (e.kind === 'restart') rows.push({ at: e.at, source: 'runner', kind: 'restart', text: `自动重启（${e.reason || '未知原因'}，延迟 ${Math.round((e.delayMs || 0) / 1000)}s）` });
    else if (e.kind === 'start') rows.push({ at: e.at, source: 'runner', kind: 'start', text: '启动桥接' });
  }
  for (const e of Array.isArray(watchdogEvents) ? watchdogEvents : []) {
    if (!e || !e.at) continue;
    rows.push({ at: e.at, source: 'watchdog', kind: 'watch', text: String(e.text || '').slice(0, 120) });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows.slice(0, Math.max(1, Math.min(200, limit)));
}

/**
 * 组装守护视图。
 * @param {object} p
 * @param {{pid:number, uptimeMs:number, ready:boolean, version:string}} p.processInfo 权威存活信息
 * @param {Array} p.runnerEvents
 * @param {Array} p.watchdogEvents
 * @param {number} p.now
 */
export function buildSupervisorView({ processInfo = null, runnerEvents = [], watchdogEvents = [], now = Date.now() } = {}) {
  const alive = Boolean(processInfo && Number(processInfo.pid) > 0 && Number(processInfo.uptimeMs) >= 0);
  const since = now - WINDOW_MS;
  const restarts = (runnerEvents || []).filter((e) => e && e.kind === 'restart' && e.at >= since);
  const exits = (runnerEvents || []).filter((e) => e && e.kind === 'exit' && e.at >= since);
  const watchRecent = (watchdogEvents || []).filter((e) => e && e.at >= since);
  const lastExit = (runnerEvents || []).filter((e) => e && e.kind === 'exit').slice(-1)[0] || null;

  // 冲突检测：现在的进程只活了 uptimeMs，如果日志里在"它启动之后"还有重启事件，
  // 说明日志和当前进程对不上（旧日志 / 另一个实例 / 时间被改过）。
  const startedAt = processInfo && Number(processInfo.uptimeMs) >= 0 ? now - Number(processInfo.uptimeMs) : 0;
  const conflicts = [];
  if (alive && startedAt > 0) {
    const afterStart = (runnerEvents || []).filter((e) => e && (e.kind === 'restart' || e.kind === 'exit') && e.at > startedAt + 5000);
    if (afterStart.length) {
      conflicts.push(`日志里有 ${afterStart.length} 条重启/退出事件发生在当前进程启动之后，与当前进程不一致（可能是旧日志或另一个实例）`);
    }
  }
  if (!alive && watchRecent.some((e) => /健康|不可用/.test(String(e.text || '')))) {
    conflicts.push('进程未存活，但看门狗在 24 小时内有健康告警记录 —— 需要人工确认守护链是否还在工作');
  }

  return {
    ok: true,
    generatedAt: now,
    alive,
    authority: 'process',   // 存活判定以进程信息为准，日志只补充历史
    process: processInfo || null,
    restarts24h: restarts.length,
    exits24h: exits.length,
    watchdog24h: watchRecent.length,
    lastExit: lastExit ? { code: lastExit.code, at: lastExit.at } : null,
    events: mergeEvents({ runnerEvents, watchdogEvents, limit: 20 }),
    conflicts
  };
}

export function createSupervisorHandler(deps = {}) {
  const { sendJson, log = () => {}, readFile, files = {}, getProcessInfo } = deps;
  return {
    async handle() {
      try {
        const read = typeof readFile === 'function' ? readFile : () => '';
        const runnerLines = String(read(files.runner) || '').split('\n');
        const watchLines = String(read(files.watchdog) || '').split('\n');
        // 延迟 import 会破坏 VM 注入环境，这里用传入的解析器（bridge 侧已 import）
        const parseRunner = deps.parseRunnerEvents || (() => []);
        const parseWatch = deps.parseWatchdogEvents || (() => []);
        sendJson(buildSupervisorView({
          processInfo: typeof getProcessInfo === 'function' ? getProcessInfo() : null,
          runnerEvents: parseRunner(runnerLines),
          watchdogEvents: parseWatch(watchLines)
        }));
      } catch (error) {
        log(`[supervisor] 组装失败：${error?.message ?? error}`);
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return true;
    }
  };
}
