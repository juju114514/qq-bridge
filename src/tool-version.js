// 外部工具版本探测（目前只看 yt-dlp）。
//
// 为什么要它：视频链接功能**全靠 yt-dlp**，而它是个独立二进制 —— 装机时可能没装、
// 可能被安全软件拦掉、也可能版本太旧导致某站解析失败。这些都不是桥接能自己修的，
// 但至少要在 `/自检` 里**一眼看见**，而不是等用户贴链接才发现。
//
// 设计要点：
//   · 探测要 spawn 子进程（~100–300ms），不能每次 /自检 都跑 → 带缓存（默认 10 分钟）
//   · exec 可注入，便于离线测试（不依赖真装 yt-dlp）
//   · 永远不抛错：拿不到就是「未知」，不能因为探测失败让 /自检 挂掉

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * @param {{
 *   ytdlpPath?: string,
 *   now?: () => number,
 *   ttlMs?: number,
 *   resolve?: (opts:object)=>string,
 *   runVersion?: (exe:string)=>string
 * }} [opts]
 */
export function createToolProbe(opts = {}) {
  const {
    ytdlpPath = '',
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    resolve = null,
    runVersion = null
  } = opts;

  let cache = null;       // { at, value }
  let lastPath = ytdlpPath;

  function compute(pathNow) {
    let version = '';
    let available = false;
    try {
      if (typeof runVersion === 'function') {
        version = String(runVersion(pathNow ?? '') ?? '').trim();
        available = Boolean(version);
      }
    } catch {
      available = false;
      version = '';
    }
    return {
      path: String(pathNow ?? ''),
      available,
      version,
      checkedAt: now()
    };
  }

  /** @param {{ force?: boolean }} [o] */
  function getYtdlp(o = {}) {
    const pathNow = ytdlpPath;
    const fresh = cache && cache.value && lastPath === pathNow && now() - cache.at < ttlMs;
    if (fresh && !o.force) return cache.value;
    const value = compute(pathNow);
    cache = { at: now(), value };
    lastPath = pathNow;
    return value;
  }

  function reset() { cache = null; }

  return { getYtdlp, reset };
}

/** 从 yt-dlp 的 `--version` 输出里取版本号；拿不到就返回空串。 */
export function parseYtDlpVersion(stdout) {
  const m = /(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)/.exec(String(stdout ?? ''));
  return m ? m[1] : '';
}