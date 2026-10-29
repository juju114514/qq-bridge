// 会话级状态的集合：把"按 sessionId 归属"的 Map/Set 集中到一处。
//
// 第 1 步（本文件）：只搬集合，**不动 epoch 语义**。
//   上次想连 epoch 一起改，触发了注入顺序问题、连锁 8 个测试红，已回滚。
//   这次分开做：epoch 仍留在 bridge 里（let sessionEpoch = 0）。
//
// 为什么值得做：
//   这些集合被 /reset、唤醒调度、回合管理同时改。只要它们是散落的自由变量，
//   任何搬迁都要在 deps 里传七八个 Map，还容易漏删（漏删 = 内存泄漏 + 串话）。

export function createSessionRegistry() {
  const collections = {
    modelAppliedSessions: new Map(),      // sessionId → 已应用的模型选择
    reverse: new Map(),                   // sessionId → 会话 key
    collectors: new Map(),                // sessionId → turn collector
    sendToolSucceededSessions: new Set(), // sessionId：本 turn 内已有发送成功
    pendingSendToolCalls: new Map(),      // sessionId → Set<callId>
    v2TurnStartAt: new Map(),             // sessionId → 时间戳
    turnLeaseNoted: new Set(),            // sessionId：租约过期日志去重
    toolCallNames: new Map()              // sessionId → Map<callId, toolName>
  };

  // 重置代号：凡是"创建期间可能被重置"的异步流程都要比对它，
  // 否则会用旧 epoch 的结果覆盖新会话（真实 bug，别删）。
  let epoch = 0;

  return {
    ...collections,
    get epoch() { return epoch; },
    bumpEpoch() { epoch += 1; return epoch; },
    /**
     * 清掉一个会话在这些集合里的全部痕迹。
     * 只动本注册表拥有的东西；epoch 递增与其它清理（pending 队列、social.* …）
     * 仍由调用方负责，语义与拆分前一致。
     */
    clearSession(sessionId) {
      if (!sessionId) return false;
      for (const c of Object.values(collections)) c.delete(sessionId);
      return true;
    },
    /** 排障用：一眼看出这些集合有没有泄漏 */
    stats() {
      const sizes = {};
      for (const [k, c] of Object.entries(collections)) sizes[k] = c.size;
      return { epoch, sizes };
    }
  };
}