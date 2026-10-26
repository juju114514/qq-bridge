/**
 * /api/status —— 运行状态。
 *
 * 「按域拆 handler」的样板（阶段 3 第 1 组）。
 * 迁出原则：**行为完全不变**，只把 if 分支变成导出函数；依赖通过 deps 显式传入，
 * 不再靠 bridge.js 的闭包隐式共享。
 *
 * 审计 harness 会通过 scripts/lib/api-module-loader.mjs 把这个文件注入 VM，
 * 所以这里只能写「纯声明 + 无顶层 await」的代码（loader 的限制）。
 *
 * 安全语义（迁移时逐条保留，别改）：
 *   · 带 x-agent-token 或 x-agent-call 的调用（QQ 群里的 AI）只能拿到最小对象
 *     —— activity 是全局收发摘要，ownerQQ / 白名单属管理信息，不能给会话级主体，
 *     否则 A 群的 AI 能读到 B 群的内容。
 *   · 上游健康（snowluma）只给操作者看：含网关诊断信息（good/hint），属管理侧观测。
 */

export function createStatusHandler(deps) {
  const {
    sendJson,
    readRoleState,
    getMode,
    isDshReady,
    getClosedAgentPreset,
    getSocialV2,
    getCfg,
    snowlumaHealthSnapshot,
    readActivityTail,
  } = deps;

  /**
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean} 是否已处理（精确路由，恒为 true）
   */
  return function handleStatus(req) {
    const rs = readRoleState();
    const socialV2 = getSocialV2();

    // 智能体调用：只给最小对象
    if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
      sendJson({
        mode: getMode(),
        role: rs.role ?? null,
        roleMode: rs.mode ?? 'active',
        dshReady: isDshReady(),
        socialV2Paused: socialV2.paused,
      });
      return true;
    }

    // 操作端：完整对象
    const cfg = getCfg();
    sendJson({
      mode: getMode(),
      closedAgentPreset: getClosedAgentPreset(),
      role: rs.role ?? null,
      roleMode: rs.mode ?? 'active',
      dshReady: isDshReady(),
      ownerQQ: cfg.ownerQQ ?? null,
      allowGroups: cfg.allow?.groups ?? [],
      allowPrivate: cfg.allow?.private ?? [],
      socialV2Paused: socialV2.paused,
      snowluma: snowlumaHealthSnapshot(),
      activity: readActivityTail(100),
    });
    return true;
  };
}

export default createStatusHandler;
