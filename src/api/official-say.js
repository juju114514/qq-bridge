// 官方通道的主动消息端点（控制台 / 智能体都能用）。
//
//   POST /api/socialV2/official-say        { key, text }        手动发一条（主动消息，不带 msg_id）
//   GET  /api/socialV2/official-proactive                        看配额与定时任务状态
//
// 为什么挂在 /api/socialV2/ 下：这样 prelude 的控制台令牌校验、agent 令牌校验、
// 暂停/关停、只读降级全都自动生效，不用再造一套鉴权。

export function createOfficialSayHandler(deps) {
  const {
    sendJson,
    readBody,
    log,
    getCfg,
    officialTransport,
    proactiveQuota,
    proactiveScheduler,
    recallWindow,
    appendActivity,
    CONV_KEY_RE,
    convId,
  } = deps;

  return async function handleOfficialSay(req, url) {
    if (url.pathname === '/api/socialV2/official-proactive') {
      sendJson({
        ok: true,
        enabled: Boolean(officialTransport),
        ready: Boolean(officialTransport?.ready),
        quota: proactiveQuota ? proactiveQuota.snapshot() : null,
        recall: recallWindow ? { enabled: true, users: Object.keys(recallWindow.snapshot().users).length } : { enabled: false },
        schedules: proactiveScheduler
          ? proactiveScheduler.schedules.map((s) => ({
            key: s.key, cron: s.cron, enabled: s.enabled !== false, lastRunAt: s.lastRunAt ?? null
          }))
          : [],
        hint: '主动消息受三道闸：群主需开「主动推送消息」、用户可关闭「允许主动发送」、频控 30/分 & 1000/天'
      });
      return true;
    }

    // ── 互动召回消息（is_wakeup）：只有单聊支持，30 天 4 个周期各 1 条 ──
    if (url.pathname === '/api/socialV2/official-recall') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const text = String(body.text ?? '').trim();
      if (!key || !text) { sendJson({ ok: false, error: 'key/text 不能为空' }, 400); return true; }
      if (!officialTransport) { sendJson({ ok: false, error: '官方通道未启用' }, 400); return true; }
      if (!key.startsWith('private:')) {
        sendJson({ ok: false, error: '互动召回只支持单聊（key 必须是 private:official-<openid>）' }, 400);
        return true;
      }
      const openid = key.slice('private:official-'.length);
      if (!openid) { sendJson({ ok: false, error: 'key 里没有 openid' }, 400); return true; }
      const id = `official-${openid}`;
      if (!officialTransport.allowed('private', id)) {
        sendJson({ ok: false, error: '目标不在 config.official.allow 白名单里' }, 403);
        return true;
      }
      if (!recallWindow) { sendJson({ ok: false, error: '召回未启用（config.official.proactive.recall.enabled=true）' }, 400); return true; }
      const claim = recallWindow.claim(key);
      if (!claim.ok) { sendJson({ ok: false, error: claim.reason, recall: recallWindow.snapshot() }, 429); return true; }
      try {
        await officialTransport.sendText('private', id, text, { proactive: true, wakeup: true });
        log(`[official] 互动召回已发送（${key}，第 ${claim.period + 1} 个周期）`);
        appendActivity?.(`${key} [official] 互动召回：${text.slice(0, 60)}`);
        sendJson({ ok: true, key, period: claim.period + 1, sent: true });
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
      }
      return true;
    }

    if (url.pathname === '/api/socialV2/official-say') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const text = String(body.text ?? '').trim();
      if (!key || !text) { sendJson({ ok: false, error: 'key/text 不能为空' }, 400); return true; }
      if (!officialTransport) { sendJson({ ok: false, error: '官方通道未启用（config.official.enabled=false）' }, 400); return true; }

      const m = (CONV_KEY_RE ?? /^(group|private):(\d+|official-[A-Za-z0-9_-]+)$/).exec(key);
      if (!m) { sendJson({ ok: false, error: 'key 格式应为 group:official-<openid> 或 private:official-<openid>' }, 400); return true; }
      const kind = m[1];
      const id = convId ? convId(m[2]) : m[2];
      if (typeof id !== 'string' || !id.startsWith('official-')) {
        sendJson({ ok: false, error: '主动消息只支持官方会话（key 必须是 official-<openid>）' }, 400);
        return true;
      }
      if (!officialTransport.allowed(kind, id)) {
        sendJson({ ok: false, error: '目标不在 config.official.allow 白名单里' }, 403);
        return true;
      }
      if (proactiveQuota) {
        const q = proactiveQuota.take(kind, key);
        if (!q.ok) { sendJson({ ok: false, error: q.reason, quota: proactiveQuota.snapshot() }, 429); return true; }
      }
      try {
        // proactive:true → 强制不带 msg_id，走主动消息（不是蹭 5 分钟被动窗口）
        await officialTransport.sendText(kind, id, text, { proactive: true });
        log(`[official] 主动消息已发送（${kind}）：${text.slice(0, 40)}`);
        appendActivity?.(`${key} [official] 主动消息：${text.slice(0, 60)}`);
        sendJson({ ok: true, key, sent: true, quota: proactiveQuota ? proactiveQuota.snapshot() : null });
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
      }
      return true;
    }

    return false;
  };
}
