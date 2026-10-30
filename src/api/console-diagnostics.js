// 控制台：诊断与健康（GET /api/diagnostics）。
//
// 为什么需要这个接口：`/自检` 和 `/诊断` 一直是**只能在 QQ 里用**的 ——
// 控制台看不到"为什么没回话"、也看不到队列/死信/cookies/yt-dlp 的状态。
// 这个接口把两者合成一份只读快照，供控制台「诊断」页渲染。
//
// 只读、无副作用：不改状态、不触发重试、不 spawn 除 yt-dlp --version 之外的任何东西
// （yt-dlp 那次也有 10 分钟缓存）。

export function createDiagnosticsHandler(baseDeps = {}) {
  const {
    log = () => {},
    getSelfCheck,
    getDecisionTrace,
    getToolProbe,
    buildSelfCheckReport,
    recentErrors = () => []
  } = baseDeps;

  function build() {
    let selfcheck = null;
    let report = '';
    try {
      selfcheck = typeof getSelfCheck === 'function' ? getSelfCheck() : null;
      if (selfcheck && typeof buildSelfCheckReport === 'function') report = buildSelfCheckReport(selfcheck);
    } catch (error) {
      log(`[diagnostics] 自检快照失败：${error?.message ?? error}`);
    }

    let decisions = [];
    try {
      const trace = typeof getDecisionTrace === 'function' ? getDecisionTrace() : null;
      if (trace) decisions = trace.recent({ limit: 30 });
    } catch { /* 只读接口，失败就当没有 */ }

    let ytdlp = null;
    try { ytdlp = getToolProbe?.()?.getYtdlp?.() ?? null; } catch { /* 同上 */ }

    let errors = [];
    try { errors = recentErrors(20) ?? []; } catch { /* 同上 */ }

    return {
      ok: true,
      now: Date.now(),
      selfcheck,
      report,
      ytdlp,
      decisions,
      errors
    };
  }

  async function handle(ctx = {}) {
    const { sendJson } = ctx;
    try {
      sendJson(build());
    } catch (error) {
      log(`[diagnostics] 组装失败：${error?.message ?? error}`);
      sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
    }
    return true;
  }

  return { handle, build };
}