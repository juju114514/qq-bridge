// 总览仪表盘的纯函数部分：与 IO 无关，便于单测。
// 端点模块（src/api/overview.js）只负责把 deps 接上并 sendJson。

const OK = 'ok';
const UNAVAILABLE = 'unavailable';

function metric(value, extra = {}) {
  return { status: OK, at: Date.now(), value, ...extra };
}

function unavailable(reason) {
  return { status: UNAVAILABLE, at: Date.now(), error: String(reason?.message ?? reason ?? '未知错误') };
}

function safe(name, fn, onError = () => {}) {
  try {
    const v = fn();
    return v === undefined || v === null ? unavailable('数据源未提供') : v;
  } catch (error) {
    onError(name, error);
    return unavailable(error);
  }
}

/** 最近 N 小时里的事件计数（用于 runner/watchdog 日志这类"只有时间戳"的来源） */
export function countSince(events, sinceMs) {
  if (!Array.isArray(events)) return 0;
  return events.filter((e) => Number(e && e.at) >= sinceMs).length;
}

/** 从 runner.log 的 JSONL 里提取重启/退出事件（纯函数，便于单测） */
export function parseRunnerEvents(lines = [], now = Date.now()) {
  const events = [];
  for (const raw of (Array.isArray(lines) ? lines : [])) {
    const line = String(raw ?? '').trim();
    if (!line.startsWith('{')) continue;
    let j = null;
    try { j = JSON.parse(line); } catch { continue; }
    const at = Date.parse(j.time || '') || 0;
    if (j.event === 'runner.child_exit') events.push({ kind: 'exit', at, code: Number(j.exitCode), attempt: Number(j.attempt) || 0 });
    else if (j.event === 'runner.restart') events.push({ kind: 'restart', at, reason: String(j.reason || ''), delayMs: Number(j.delayMs) || 0 });
    else if (j.event === 'runner.start') events.push({ kind: 'start', at });
  }
  return events.filter((e) => e.at > 0 && e.at <= now + 60000);
}

/** 从 watchdog.log 的 `[ISO时间] 句子` 里提取事件（纯函数） */
export function parseWatchdogEvents(lines = []) {
  const events = [];
  for (const raw of (Array.isArray(lines) ? lines : [])) {
    const line = String(raw ?? '').trim();
    const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (!Number.isFinite(at)) continue;
    events.push({ at, text: m[2].slice(0, 120) });
  }
  return events;
}

/**
 * 组装总览。
 * @param {object} deps 全部是访问器/读取器，缺失时对应指标变 unavailable
 */
export function buildOverview(deps = {}) {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const metrics = {};

  // 1) 运行模式
  metrics.mode = safe('mode', () => metric(deps.getMode ? deps.getMode() : undefined));

  // 2) DSH 连接
  metrics.dsh = safe('dsh', () => {
    const ready = deps.isDshReady ? deps.isDshReady() : undefined;
    if (typeof ready !== 'boolean') return unavailable('DSH 状态不可读');
    return metric(ready ? 'connected' : 'disconnected');
  });

  // 3) 官方通道
  metrics.official = safe('official', () => {
    const v = deps.getOfficialStatus ? deps.getOfficialStatus() : undefined;
    if (!v) return unavailable('官方通道状态不可读');
    return metric(String(v));
  });

  // 4) 最近 24 小时花费
  metrics.cost24h = safe('cost', () => {
    const series = deps.getTokenSeries ? deps.getTokenSeries({ hours: 24 }) : undefined;
    if (!series || !series.totals) return unavailable('用量账本不可读');
    return metric(Number(series.totals.cost) || 0, {
      currency: series.symbol || '¥',
      window: '最近 24 小时',
      turns: Number(series.totals.turns) || 0
    });
  });

  // 5) 未读
  metrics.unread = safe('unread', () => {
    const list = deps.getConversations ? deps.getConversations() : undefined;
    if (!Array.isArray(list)) return unavailable('会话列表不可读');
    return metric(list.reduce((n, c) => n + (Number(c.unreadCount) || 0), 0), { conversations: list.length });
  });

  // 6) 记忆：原子数 + 有记忆的会话数 + 会话总数
  metrics.memory = safe('memory', () => {
    const list = deps.getConversations ? deps.getConversations() : undefined;
    if (!Array.isArray(list)) return unavailable('会话列表不可读');
    let atoms = 0;
    let withMemory = 0;
    for (const c of list) {
      const n = Number(c.longTermCount) || 0;
      atoms += n;
      if (n > 0) withMemory += 1;
    }
    return metric({ atoms, sessionsWithMemory: withMemory, sessionsTotal: list.length });
  });

  // 7) 静默时段
  metrics.quiet = safe('quiet', () => {
    const q = deps.getQuietHours ? deps.getQuietHours() : '__missing__';
    if (q === '__missing__') return unavailable('静默配置不可读');
    return metric(Array.isArray(q) ? q : null);
  });

  // 8) 守护进程（日志来源，非权威存活）
  metrics.supervisor = safe('supervisor', () => {
    const read = deps.readFile;
    const files = deps.files || {};
    if (typeof read !== 'function' || !files.runner || !files.watchdog) return unavailable('日志路径未配置');
    const runnerEvents = parseRunnerEvents(String(read(files.runner) || '').split('\n'), now);
    const watchdogEvents = parseWatchdogEvents(String(read(files.watchdog) || '').split('\n'));
    const restarts = runnerEvents.filter((e) => e.kind === 'restart');
    const exits = runnerEvents.filter((e) => e.kind === 'exit');
    const lastExit = exits.length ? exits[exits.length - 1] : null;
    return metric({
      restarts24h: countSince(restarts, dayAgo),
      watchdogEvents24h: countSince(watchdogEvents, dayAgo),
      lastExit: lastExit ? { code: lastExit.code, at: lastExit.at } : null,
      lastWatchdog: watchdogEvents.length ? watchdogEvents[watchdogEvents.length - 1].text : null,
      source: 'logs'
    });
  });

  // 9) 异常：用"最近 15 分钟"区分当前 / 历史（旧日志不能说明现在还坏）
  metrics.alert = safe('alert', () => {
    const read = deps.readFile;
    const files = deps.files || {};
    if (typeof read !== 'function' || !files.watchdog) return unavailable('日志路径未配置');
    const events = parseWatchdogEvents(String(read(files.watchdog) || '').split('\n'));
    const recent = events.filter((e) => e.at >= now - 15 * 60 * 1000);
    const bad = (list) => list.filter((e) => /不可用|重启|失败|异常|超时/.test(e.text));
    return metric({
      current: bad(recent).length,
      historical: bad(events).length,
      window: '15 分钟',
      lastText: bad(events).length ? bad(events)[bad(events).length - 1].text : null
    });
  });

  return { ok: true, generatedAt: now, metrics };
}
