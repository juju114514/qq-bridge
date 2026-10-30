// 社交模式状态的**落盘**部分（saveSocialV2State 的数据组装 + 原子写）。
//
// 波次 1 的第三块。先搬"写"，因为它是纯数据整形：
//   · 每个字段的裁剪上限（recentMessages 200 / unread 100 / sendTimes 500…）
//     —— 这些上限就是"状态文件不会无限变大"的唯一保证
//   · 写失败必须**只记日志不抛**：调用方遍布消息路径，抛了会把消息处理打断
//
// "读"那半边（loadSocialV2State，120 行、要注入 10 个钩子）留到下一轮，
// 因为它牵扯 ensureWakeable / scheduleProactiveCheck 这些有副作用的步骤。

/** 每个会话字段的裁剪上限。改这里等于改状态文件的大小上限，别随手调大。 */
export const SOCIAL_V2_TRIM = Object.freeze({
  recentMessages: 200,
  unread: 100,
  wakeTimes: 200,
  sendTimes: 500,
  stickerCollectTimes: 500,
  activeTopics: 50,
  pendingThoughts: 50,
  seenForwardIds: 1000
});

const sliceTail = (value, max) => (Array.isArray(value) ? value.slice(-max) : []);

/** 把内存里的会话状态整形成可落盘的对象（不写盘，便于测试）。 */
export function buildSocialV2Snapshot({ conversations, seenForwardIds, paused = false }) {
  const obj = { paused: Boolean(paused), conversations: Object.create(null) };
  for (const [key, st] of conversations ?? []) {
    obj.conversations[key] = {
      wakeConfig: st.wakeConfig,
      recentMessages: sliceTail(st.recentMessages, SOCIAL_V2_TRIM.recentMessages),
      unread: sliceTail(st.unread, SOCIAL_V2_TRIM.unread),
      lastWakeReason: st.lastWakeReason,
      lastAiReplyAt: st.lastAiReplyAt,
      lastActionAt: st.lastActionAt,
      agentToken: st.agentToken,
      bootstrapSent: st.bootstrapSent,
      wakeTimes: sliceTail(st.wakeTimes, SOCIAL_V2_TRIM.wakeTimes),
      sendTimes: sliceTail(st.sendTimes, SOCIAL_V2_TRIM.sendTimes),
      stickerCollectTimes: sliceTail(st.stickerCollectTimes, SOCIAL_V2_TRIM.stickerCollectTimes),
      lastIncomingAt: st.lastIncomingAt || 0,
      preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
      preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
      preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
      lastUnreadSeq: st.lastUnreadSeq || 0,
      lastReadThroughSeq: st.lastReadThroughSeq || 0,
      activeTopics: sliceTail(st.activeTopics, SOCIAL_V2_TRIM.activeTopics),
      pendingThoughts: sliceTail(st.pendingThoughts, SOCIAL_V2_TRIM.pendingThoughts),
      memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
      seenForwardIds: Array.from(seenForwardIds?.get(key) || []).slice(-SOCIAL_V2_TRIM.seenForwardIds)
    };
  }
  return obj;
}

/**
 * 落盘。**永不抛**：调用点在消息处理路径上，抛错会打断消息。
 * @returns {{ ok: boolean, error?: string }}
 */
export function saveSocialV2StateTo({ file, conversations, seenForwardIds, paused = false, atomicWriteJson, log = () => {} }) {
  try {
    atomicWriteJson(file, buildSocialV2Snapshot({ conversations, seenForwardIds, paused }));
    return { ok: true };
  } catch (error) {
    const message = error?.message ?? String(error);
    log('保存 socialV2 状态失败:', message);
    return { ok: false, error: message };
  }
}