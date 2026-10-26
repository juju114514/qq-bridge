/**
 * 一代仿真社交引擎：POST /api/social/state、GET /api/social、POST /api/social、POST /api/social/flush
 *
 * 「按域拆 handler」第 8 组（social v1，4 条）。行为逐行等价。
 *
 * 注意：
 *   · GET /api/social 只读三个来源：pendingSummaries / states / recentMessages（后两者取并集）
 *   · POST /api/social 会**清理旧字段**并做 clamp —— 顺序不能乱（先删旧键，再夹取）
 *   · POST /api/social/flush 是异步的（await flushSummaries）
 */

export function createSocialHandler(deps) {
  const {
    sendJson,
    readBody,
    log,
    path,
    ROOT,
    readConfigObject,
    atomicWriteJson,
    getCfg,
    setSocialConfig,
    social,
    enterActive,
    leaveActive,
    flushSummaries,
  } = deps;

  return async function handleSocial(req, url) {
    const { pathname } = url;
    const method = req.method;

    // ── POST /api/social/state —— 手动切换 活跃/观望 ─────────────────────────
    if (method === 'POST' && pathname === '/api/social/state') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      const phase = body.phase;
      if (phase === 'active') {
        // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
        enterActive(key);
        log(`控制台：手动将 ${key} 设为活跃`);
        sendJson({ ok: true, key, phase: 'active' });
      } else if (phase === 'idle') {
        leaveActive(key);
        log(`控制台：手动将 ${key} 设为观望`);
        sendJson({ ok: true, key, phase: 'idle' });
      } else {
        sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
      }
      return true;
    }

    // ── GET /api/social —— 配置 + 汇总队列 + 会话阶段 ────────────────────────
    if (method === 'GET' && pathname === '/api/social') {
      const stats = {};
      for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
      const states = {};
      const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
      for (const k of keys) {
        const st = social.states.get(k);
        states[k] = { phase: st?.phase ?? 'idle' };
      }
      sendJson({ config: getCfg().social, pendingSummaries: stats, states });
      return true;
    }

    // ── POST /api/social —— 更新社交配置（删旧字段 + clamp）──────────────────
    if (method === 'POST' && pathname === '/api/social') {
      const body = await readBody();
      const configFile = path.join(ROOT, 'config.json');
      // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
      const file = readConfigObject(configFile);
      const merged = { ...(file.social ?? {}), ...body };
      // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
      for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
        delete merged[k];
      }
      for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
        if (merged[k] !== undefined) {
          const n = Number(merged[k]);
          if (Number.isFinite(n) && n >= 0) merged[k] = n;
        }
      }
      // 分条间隔 clamp 到非负
      for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
        if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
      }
      // 概率字段 clamp 到 0~1
      for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
        if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
      }
      // contextWindow 限制 1~100
      if (merged.contextWindow !== undefined) {
        merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
      }
      // 布尔字段
      for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
        if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
      }
      // 范围字段保证 min <= max
      for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
        if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
          [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
        }
      }
      if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
      file.social = merged;
      atomicWriteJson(configFile, file);
      setSocialConfig(merged);
      log('控制台：社交配置已更新');
      sendJson({ ok: true, config: getCfg().social });
      return true;
    }

    // ── POST /api/social/flush —— 立即结算汇总 ──────────────────────────────
    if (method === 'POST' && pathname === '/api/social/flush') {
      const body = await readBody();
      await flushSummaries(body.key || null);
      sendJson({ ok: true });
      return true;
    }

    return false;
  };
}

export default createSocialHandler;
