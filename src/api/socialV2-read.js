/**
 * socialV2 —— A 组：只读端点（第一批 8 条）
 *
 *   GET /api/socialV2/config      配置快照
 *   GET /api/socialV2/activity    暂停状态
 *   GET /api/socialV2/tool-log    工具调用日志（最近 N 条）
 *   GET /api/socialV2/feedback    反馈列表
 *   GET /api/socialV2/states      所有会话的唤醒快照
 *   GET /api/socialV2/my-recent   自己最近说过的话
 *   GET /api/socialV2/memory      轻量记忆
 *   GET /api/socialV2/slang/query 黑话查询
 *
 * 「按域拆 handler」第 9 组的 A 批。全部只读，不改任何状态。
 * 校验顺序与原实现一致：key 空 → agent token → 会话白名单 → 工具开关。
 */

import { formatLongTerm, migrateFromLegacy } from '../memory-store.js';

export function createSocialV2ReadHandler(deps) {
  const {
    sendJson,
    getCfg,
    getSocialV2,
    readToolLog,
    readFeedbackEntries,
    getSocialV2State,
    agentTokenOk,
    v2SessionAllowed,
    v2ToolEnabled,
    readThroughSeqV2,
    formatMemoryV2,
    confirmedSlangListV2,
    buildSlangContext,
    getSlangEntries,
    noteModelMessagesV2,
    stickerEnabled,
    syncStickerLibrary,
    formatStickerList,
    getStickerEntries,
    getStickerSyncedAt,
    voiceCfg,
    listAudioFiles,
    inspectAudio,
    describeAudio,
    fs,
    path,
    ROOT,
    mimeFromBuffer,
  } = deps;

  /** 三条 agent 校验，顺序与原实现一致；返回 true 表示已拒绝并回复 */
  function rejectAgent(req, key, toolFlag, toolName) {
    const agentToken = req.headers['x-agent-token'];
    if (agentToken && !agentTokenOk(key, agentToken)) {
      sendJson({ ok: false, error: 'agent token 无效' }, 403);
      return true;
    }
    if (agentToken && !v2SessionAllowed(key)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    if (agentToken && !v2ToolEnabled(toolFlag)) {
      sendJson({ ok: false, error: `工具未启用：${toolName}` }, 403);
      return true;
    }
    return false;
  }

  return async function handleSocialV2Read(req, url) {
    if (req.method !== 'GET') return false;
    const { pathname } = url;

    if (pathname === '/api/socialV2/config') {
      sendJson({ ok: true, config: getCfg().socialV2 ?? {} });
      return true;
    }

    if (pathname === '/api/socialV2/activity') {
      sendJson({ ok: true, paused: getSocialV2().paused });
      return true;
    }

    if (pathname === '/api/socialV2/tool-log') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      sendJson({ ok: true, entries: readToolLog(limit) });
      return true;
    }

    if (pathname === '/api/socialV2/feedback') {
      sendJson({ ok: true, entries: readFeedbackEntries() });
      return true;
    }

    if (pathname === '/api/socialV2/states') {
      const list = [];
      for (const [key, st] of getSocialV2().conversations) {
        list.push({
          key,
          wakeConfig: st.wakeConfig,
          unreadCount: st.unread.length,
          recentCount: st.recentMessages.length,
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          noActionCount: st.wakeConfig.noActionCount || 0,
        });
      }
      sendJson({ ok: true, conversations: list });
      return true;
    }

    if (pathname === '/api/socialV2/my-recent') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (rejectAgent(req, key, 'getMyRecent', 'qq_get_my_recent_messages')) return true;
      const st = getSocialV2State(key);
      const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
      sendJson({ ok: true, key, messages: mine, readThroughSeq: readThroughSeqV2(st) });
      return true;
    }

    if (pathname === '/api/socialV2/memory') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const category = String(url.searchParams.get('category') ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (rejectAgent(req, key, 'memory', 'qq_memory_query')) return true;
      const st = getSocialV2State(key);
      const raw = {
        activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
        pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt) : [],
        memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
      };
      if (category === 'activeTopic') {
        raw.pendingThoughts = [];
        raw.memberImpressions = {};
      } else if (category === 'pendingThought') {
        raw.activeTopics = [];
        raw.memberImpressions = {};
      } else if (category === 'memberImpression') {
        raw.activeTopics = [];
        raw.pendingThoughts = [];
      }
      // 长期层：老会话还没迁移过 → 现场用旧结构合成（只读、不写盘），保证"升级即可见"。
      const longTerm = Array.isArray(st.longTermMemories) && st.longTermMemories.length > 0
        ? st.longTermMemories
        : migrateFromLegacy(st);
      const query = String(url.searchParams.get('q') ?? '').trim();
      const longTermText = formatLongTerm(longTerm, { query, now: Date.now(), limit: 6, maxChars: 800 });
      const legacyText = formatMemoryV2({ ...st, ...raw });
      sendJson({
        ok: true,
        key,
        category,
        formatted: [legacyText, longTermText].filter(Boolean).join('\n\n'),
        longTerm: longTerm.slice(-50),
        raw
      });
      return true;
    }

    if (pathname === '/api/socialV2/slang/query') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (rejectAgent(req, key, 'slangQuery', 'qq_slang_query')) return true;
      const list = confirmedSlangListV2().filter((e) => {
        if (!q) return true;
        return e.content.toLowerCase().includes(q)
          || e.meaning.toLowerCase().includes(q)
          || e.usage.toLowerCase().includes(q)
          || e.example.toLowerCase().includes(q);
      });
      sendJson({
        ok: true,
        key,
        total: list.length,
        entries: list,
        block: buildSlangContext(getSlangEntries(), getCfg().slang?.injectMax ?? 8),
      });
      return true;
    }

    if (pathname === '/api/socialV2/unread') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (rejectAgent(req, key, 'getUnread', 'qq_get_unread_messages')) return true;
      const afterRaw = url.searchParams.get('afterSeq');
      const afterSeq = afterRaw === null ? null : Number(afterRaw);
      if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
        sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
        return true;
      }
      const st = getSocialV2State(key);
      // Preserve the old tail read by default; cursor paging lets a backlog
      // larger than one response be read completely, even outside recent.
      const messages = afterSeq === null ? st.unread.slice(-limit)
        : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
      const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
      sendJson({ ok: true, key, unreadCount: st.unread.length, messages, readThroughSeq });
      return true;
    }

    if (pathname === '/api/socialV2/recent') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (rejectAgent(req, key, 'getRecent', 'qq_get_recent_messages')) return true;
      const st = getSocialV2State(key);
      const start = Math.max(0, st.recentMessages.length - offset - limit);
      const end = Math.max(0, st.recentMessages.length - offset);
      const messages = st.recentMessages.slice(start, end);
      const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
      sendJson({ ok: true, key, messages, readThroughSeq });
      return true;
    }

    if (pathname === '/api/socialV2/self-image') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (rejectAgent(req, key, 'getSelfImage', 'qq_get_self_image')) return true;
      const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
      try {
        if (!fs.existsSync(selfPath)) {
          sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404);
          return true;
        }
        const buf = fs.readFileSync(selfPath);
        const mimeType = mimeFromBuffer(buf) || 'image/png';
        sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
      } catch (error) {
        sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

    if (pathname === '/api/socialV2/voices' || pathname === '/api/voice/list') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const voice = voiceCfg();
      const agentCall = Boolean(req.headers['x-agent-token']);
      // 与发送接口同样的分层：voice.enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
      if (agentCall && !voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return true; }
      if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentCall && !v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return true; }
      const wantProbe = url.searchParams.get('probe') !== '0';
      try {
        const files = listAudioFiles(voice.dir);
        const items = [];
        for (const f of files.slice(0, 100)) {
          const entry = { name: path.relative(voice.dir, f).split(path.sep).join('/') };
          if (wantProbe) {
            const info = await inspectAudio(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
            entry.ok = info.ok;
            entry.bytes = info.size;
            entry.detail = info.ok ? describeAudio(info) : null;
            entry.seconds = info.duration ?? null;
            if (!info.ok) entry.error = info.error;
          }
          items.push(entry);
        }
        sendJson({
          ok: true,
          key: key || null,
          dir: agentCall ? undefined : voice.dir,
          count: items.length,
          voices: items,
          limits: {
            maxSeconds: voice.maxSeconds,
            maxBytes: voice.maxBytes,
            maxPerMinute: voice.maxPerMinute,
            maxPerHour: voice.maxPerHour,
          },
          // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏。
          hint: items.length
            ? '用 qq_send_voice 传 name 即可把其中一个当语音发出去'
            : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voice.dir} 后重试`),
        });
      } catch (error) {
        sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

    if (pathname === '/api/socialV2/sticker-list') {
      if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
      const key = String(url.searchParams.get('key') ?? '').trim();
      const query = String(url.searchParams.get('query') ?? '').trim();
      const maxCount = Math.max(1, Number(getCfg().socialV2?.sticker?.maxListCount) || 100);
      const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
      // GET 上不再支持 refresh：强制同步是有副作用的写操作，挂在 GET 上会绕开 CSRF 防护。
      const force = false;
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (rejectAgent(req, key, 'listStickers', 'qq_list_stickers')) return true;
      try {
        const synced = await syncStickerLibrary(force);
        const list = formatStickerList(synced?.entries ?? getStickerEntries(), query, count);
        sendJson({
          ok: true, key, ...list,
          syncedAt: synced?.syncedAt ?? getStickerSyncedAt(),
          fromCache: synced?.fromCache ?? false,
        });
      } catch (error) {
        sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

    return false;
  };
}

export default createSocialV2ReadHandler;
