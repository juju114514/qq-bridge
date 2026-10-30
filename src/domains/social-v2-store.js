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


/**
 * 读状态并写回内存（loadSocialV2State 的主体）。
 *
 * 为什么参数这么多：这一段夹着**副作用**（ensureWakeable 会改配置、scheduleProactiveCheck 会挂定时器、
 * 末尾还会统一落盘一次）。要让它可测，就不得不把这些副作用显式列在签名里 ——
 * 这本身也是"闭包里什么都拿得到"的代价。
 *
 * 关键保护（别删）：加载末尾的回写只在**文件指纹没变**时执行。
 * 历史上出现过两个桥接实例同时启动，第二个实例加载后立刻回写，
 * 把第一个实例刚更新的读水位/唤醒时间全部退回旧值。
 */
export function loadSocialV2StateInto({
  file, fs, crypto, log = () => {}, readJsonSafe,
  state, seenForwardIds,
  canonicalKeyOf, save, hooks
}) {
  try {
    // 记下读取时刻的文件指纹。加载末尾会统一落盘一次（为了让 ensureWakeableV2
    // 中途的改动不丢），但如果这期间**别的进程**已经写过这个文件，我们手上的
    // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
    // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
    // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
    const fileStamp = (() => {
      try {
        const s = fs.statSync(file);
        return `${s.size}:${s.mtimeMs}`;
      } catch {
        return null;
      }
    })();
    const raw = readJsonSafe(file, null);
    state.paused = raw?.paused === true;
    if (raw && typeof raw.conversations === 'object') {
      const seenTokens = new Set();
      for (const [key, val] of Object.entries(raw.conversations)) {
        if (!val || typeof val !== 'object') continue;
        const canon = canonicalKeyOf(key);
        if (!canon) continue;   // 与 getSocialV2State 同一口径：group:0 / 乱格式一律丢弃
        const defaultWc = hooks.defaultWakeConfig();
        let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
        if (!agentToken || seenTokens.has(agentToken)) {
          agentToken = crypto.randomBytes(16).toString('hex');
        }
        seenTokens.add(agentToken);
        const st = {
          wakeConfig: {
            ...defaultWc,
            ...(val.wakeConfig ?? {}),
            // 加载时也按已知字段过滤：旧状态文件里可能残留任意键（见 WAKE_TRIGGER_KEYS）。
            triggers: hooks.pickTriggers((val.wakeConfig?.triggers) ?? {}, defaultWc.triggers)
          },
          recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
          unread: Array.isArray(val.unread) ? val.unread : [],
          lastWakeReason: String(val.lastWakeReason ?? ''),
          lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
          lastActionAt: Number(val.lastActionAt) || 0,
          agentToken,
          bootstrapSent: !!val.bootstrapSent,
          wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
          sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
          stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
          pendingWakeTimer: null,
          sleepTimer: null,
          replyCheckTimer: null,
          proactiveTimer: null,
          lastIncomingAt: Number(val.lastIncomingAt) || 0,
          preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
          preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
          preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
          lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
          lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
            ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
          modelSeenSeqs: new Set(),
          activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
          pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
          memberImpressions: (() => {
            const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
            const clean = {};
            for (const [k, v] of Object.entries(rawImp)) {
              if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
              clean[k] = v;
            }
            return clean;
          })()
        };
        // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
        if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
          st.wakeConfig.triggers.speakerIds = hooks.normalizeSpeakerIds(st.wakeConfig.triggers.speakerIds);
          if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
        }
        // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
        hooks.refreshDefault(st);
        hooks.rememberAgentToken(key, st.agentToken);
        state.conversations.set(canon, st);
        // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
        {
          const rebuilt = new Set();
          if (Array.isArray(val.seenForwardIds)) {
            for (const fid of val.seenForwardIds) {
              const safe = hooks.sanitizeForwardId(fid);
              if (safe) rebuilt.add(safe);
            }
          }
          for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
            if (Array.isArray(m?.forwardIds)) {
              for (const fid of m.forwardIds) {
                const safe = hooks.sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
          }
          if (rebuilt.size) seenForwardIds.set(key, rebuilt);
        }
        hooks.ensureWakeable(st, { skipSave: true, key });
        hooks.scheduleProactiveCheck(key);
      }
      // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
      // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
      // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
      const nowStamp = (() => {
        try {
          const s = fs.statSync(file);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
        log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
      } else {
        save();
      }
    }
  } catch (error) {
    log('读取 socialV2 状态失败:', error?.message ?? error);
  }
}
