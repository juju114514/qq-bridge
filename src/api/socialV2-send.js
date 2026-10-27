/**
 * socialV2 —— C 批（安全子集）：语音合成类
 *
 *   POST /api/socialV2/say    现场 TTS（调 speak.ps1）
 *   POST /api/socialV2/sing   唱歌（调 sing.ps1；可指定歌名自动取词）
 *
 * 这两个端点**不经过 sendMessagesV2**：它们 spawn 外部 PowerShell 脚本，
 * 脚本自己发语音条。所以这里没有发送额度记账，只有守卫 + 启动子进程。
 *
 * 校验顺序与原实现一致（注意 say/sing 的顺序和别的端点不同）：
 *   reserved2 → key 空 → 文本空 → agent token → 工具开关 → 会话白名单 → 静默拦截
 */

import os from 'node:os';
import { spawn } from 'node:child_process';

export function createSocialV2SendHandler(deps) {
  const {
    sendJson,
    readBody,
    log,
    getMode,
    agentTokenOk,
    v2ToolEnabled,
    v2SessionAllowed,
    shouldBlockSilentReply,
    fs,
    path,
    resolveRuntimeDir,
    getCfg,
    getSocialV2,
    getSocialV2State,
    saveSocialV2State,
    syncStickerLibrary,
    getStickerEntries,
    pickStickersByMood,
    stickerEnabled,
    applyStickerNoteV2,
    setStickerRemarkV2,
    collectStickerV2,
    assertGroupMember,
    getSelfUserId,
    onebotHttpAction,
    appendActivity,
    getStickerImageData,
    safeFetchBuffer,
    MAX_MEDIA_BYTES,
    MAX_MEDIA_PIXELS,
    getImageDimensions,
    mimeFromBuffer,
    mimeFromUrl,
    toModelMedia,
    voiceCfg,
    modeAllowed,
    resolveVoicePathForV2,
    voiceBudgetCheck,
    inspectAudio,
    describeAudio,
    sendVoiceForV2,
    resolveReplyTargetV2,
    sendStickerV2,
    truncateText,
    scheduleReplyCheckV2,
    bot,
    captureSendGuard,
    computeGapsV2,
    SENSITIVE_RE,
    findCjkSpaceWarning,
    findSplitBoundaryWarning,
    sendMessagesV2,
    recordSentMessagesV2,
  } = deps;

  return async function handleSocialV2Send(req, url) {
    // sticker-image 是 GET（取图给模型看），其余都是 POST
    if (req.method !== 'POST' && url.pathname !== '/api/socialV2/sticker-image') return false;
    const { pathname } = url;

    // ── POST /api/socialV2/say ─────────────────────────────────────────────
    if (pathname === '/api/socialV2/say') {
      const body = await readBody();
      const agentToken = req.headers['x-agent-token'];
      const token = String(body.token ?? agentToken ?? '').trim();
      const key = String(body.key ?? '').trim();
      const text = String(body.text ?? '').trim().slice(0, 120);
      const mood = String(body.mood ?? '正常').trim();
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (!text) { sendJson({ ok: false, error: 'text 不能为空（要说的话）' }, 400); return true; }
      if (agentToken) {
        if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
        if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_say' }, 403); return true; }
        if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      }
      if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }

      // 平台闸门：这两个功能 spawn 的是 powershell.exe。换到 Linux 后它会直接 ENOENT，
      // 用户看到的是「启动合成失败：spawn powershell.exe ENOENT」—— 既没说是平台问题，
      // 也没说怎么绕。这里提前给出可执行的提示（换机器时最常踩的一条）。
      if (process.platform !== 'win32' && !process.env.QQBOT_SAY_SCRIPT) {
        sendJson({ ok: false, error: `语音合成依赖 Windows PowerShell（当前是 ${process.platform}）；设 QQBOT_SAY_SCRIPT 指向平台自带的合成脚本可绕过` }, 400);
        return true;
      }
      const sayScript = process.env.QQBOT_SAY_SCRIPT || path.join(resolveRuntimeDir('QQBOT_TOOLS', 'tools', ''), 'speak.ps1');
      if (!fs.existsSync(sayScript)) {
        sendJson({ ok: false, error: `说话脚本不存在：${sayScript}（可用 QQBOT_SAY_SCRIPT 或 config.paths.tools 指定）` }, 500);
        return true;
      }
      const textFile = path.join(os.tmpdir(), `qq-say-${Date.now()}.txt`);
      try {
        fs.writeFileSync(textFile, text, 'utf8');
      } catch (error) {
        sendJson({ ok: false, error: `写文本文件失败：${error?.message ?? error}` }, 500);
        return true;
      }
      try {
        const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sayScript, '-TextFile', textFile, '-Mood', mood, '-Target', key], { windowsHide: true, stdio: 'ignore' });
        child.on('exit', (code) => log(`[say] ${key} 结束 code=${code}（${mood}）`));
        child.on('error', (error) => log(`[say] ${key} 失败：${error?.message ?? error}`));
        log(`[say] ${key} 开始合成（${mood}｜${text.slice(0, 40)}）`);
        sendJson({ ok: true, key, text, mood, note: '正在合成，约 3 秒后以语音条发出' });
      } catch (error) {
        sendJson({ ok: false, error: `启动合成失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

    // ── POST /api/socialV2/sing ────────────────────────────────────────────
    if (pathname === '/api/socialV2/sing') {
      const body = await readBody();
      const agentToken = req.headers['x-agent-token'];
      const token = String(body.token ?? agentToken ?? '').trim();
      const key = String(body.key ?? '').trim();
      const lyric = String(body.lyric ?? '').trim().slice(0, 40);
      const songName = String(body.song ?? '').trim().slice(0, 60);
      const style = String(body.style ?? '儿歌').trim();
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (!lyric && !songName) { sendJson({ ok: false, error: 'lyric 或 song 至少给一个（song=唱某首歌，自动取歌词）' }, 400); return true; }
      if (agentToken) {
        if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
        if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_sing' }, 403); return true; }
        if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      }
      if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }

      if (process.platform !== 'win32' && !process.env.QQBOT_SING_SCRIPT) {
        sendJson({ ok: false, error: `唱歌依赖 Windows PowerShell（当前是 ${process.platform}）；设 QQBOT_SING_SCRIPT 指向平台自带脚本可绕过` }, 400);
        return true;
      }
      const singScript = process.env.QQBOT_SING_SCRIPT || path.join(resolveRuntimeDir('QQBOT_TOOLS', 'tools', ''), 'sing.ps1');
      if (!fs.existsSync(singScript)) {
        sendJson({ ok: false, error: `唱歌脚本不存在：${singScript}（可用 QQBOT_SING_SCRIPT 或 config.paths.tools 指定）` }, 500);
        return true;
      }
      const argFile = path.join(os.tmpdir(), `qq-sing-${Date.now()}.txt`);
      try {
        fs.writeFileSync(argFile, songName || lyric, 'utf8');
      } catch (error) {
        sendJson({ ok: false, error: `写临时文件失败：${error?.message ?? error}` }, 500);
        return true;
      }
      const singArgs = songName
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', singScript, '-SongFile', argFile, '-Style', style, '-Target', key]
        : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', singScript, '-LyricFile', argFile, '-Style', style, '-Target', key];
      const label = songName ? `唱《${songName}》` : lyric;
      try {
        const child = spawn('powershell.exe', singArgs, { windowsHide: true, stdio: 'ignore' });
        child.on('exit', (code) => log(`[sing] ${key} 生成结束 code=${code}（${style}｜${label}）`));
        child.on('error', (error) => log(`[sing] ${key} 生成失败：${error?.message ?? error}`));
        log(`[sing] ${key} 开始合成（${style}｜${label}）`);
        sendJson({
          ok: true,
          key,
          lyric,
          song: songName,
          style,
          note: songName ? '正在取歌词并合成，约 10~25 秒后以语音条发出' : '正在合成，几秒后以语音条发出',
        });
      } catch (error) {
        sendJson({ ok: false, error: `启动合成失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

    // ── POST /api/socialV2/sticker-pick（按情绪挑表情）────────────────────
    if (pathname === '/api/socialV2/sticker-pick') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
      const mood = String(body.mood ?? '').trim().slice(0, 20);
      const count = Math.max(1, Math.min(6, Number(body.count) || 3));
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      try {
        const synced = await syncStickerLibrary(false).catch(() => null);
        const entries = synced?.entries ?? getStickerEntries();
        const picked = pickStickersByMood(entries, mood, count);
        sendJson({ ok: true, mood, count: picked.length, stickers: picked, hint: '挑一张用 qq_send_sticker 发出去' });
      } catch (error) {
        sendJson({ ok: false, error: `挑选失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

    // ── POST /api/socialV2/like（名片点赞）─────────────────────────────────
    if (pathname === '/api/socialV2/like') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
      const times = Math.max(1, Math.min(10, Number(body.times) || 1));
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式点赞必须携带 agent token' }, 403); return true; }
      if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (getSocialV2().paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能点赞' }, 403); return true; }
      if (!/^[1-9]\d*$/.test(targetUserId)) { sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400); return true; }
      const km2 = /^(group|private):(\d+)$/.exec(key);
      if (!km2) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      if (km2[1] === 'group') {
        const memberError = await assertGroupMember(Number(km2[2]), targetUserId);
        if (memberError) {
          sendJson({ ok: false, error: String(memberError).replace('已拒绝拍一拍', '已拒绝点赞') }, 403);
          return true;
        }
      }
      const selfUserId = getSelfUserId();
      if (selfUserId && String(selfUserId) === targetUserId) { sendJson({ ok: false, error: '不能给自己点赞' }, 400); return true; }
      try {
        const res = await onebotHttpAction('send_like', { user_id: Number(targetUserId), times }, { timeoutMs: 20000 });
        const failed = res && (res.status === 'failed' || (res.retcode && res.retcode !== 0));
        if (failed) { sendJson({ ok: false, error: String(res.wording || res.message || '点赞失败') }, 502); return true; }
        log(`[like] ${key} 给 ${targetUserId} 点了 ${times} 个赞`);
        appendActivity(`${key} 点赞 ${targetUserId} ×${times}`);
        sendJson({ ok: true, key, targetUserId, times, note: `已给 ${targetUserId} 点赞 ${times} 次` });
      } catch (error) {
        sendJson({ ok: false, error: `点赞失败：${error?.message ?? error}` }, 502);
      }
      return true;
    }

    // ── POST /api/socialV2/sticker-note（本地笔记）─────────────────────────
    if (pathname === '/api/socialV2/sticker-note') {
      if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const stickerId = String(body.stickerId ?? '').trim();
      if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentToken && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return true; }
      const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
      const tags = body.tags !== undefined && body.tags !== null
        ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : [])
        : undefined;
      const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
      const entry = applyStickerNoteV2(stickerId, note, tags, usage);
      if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return true; }
      log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
      sendJson({ ok: true, key, sticker: entry });
      return true;
    }

    // ── POST /api/socialV2/sticker-remark（QQ 侧备注）──────────────────────
    if (pathname === '/api/socialV2/sticker-remark') {
      if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const stickerId = String(body.stickerId ?? '').trim();
      if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentToken && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return true; }
      try {
        const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
        log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
        sendJson({ ok: true, key, sticker: entry });
      } catch (error) {
        sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

    // ── POST /api/socialV2/collect-sticker（偷图）───────────────────────────
    if (pathname === '/api/socialV2/collect-sticker') {
      if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const messageRef = String(body.messageId ?? body.seq ?? '').trim();
      const remark = String(body.remark ?? '').trim();
      if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return true; }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentToken && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return true; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      const st = getSocialV2State(key);
      const collectCfg = getCfg().socialV2?.sticker?.collect ?? {};
      if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return true; }
      const now = Date.now();
      const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
      const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
      const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
        sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
        return true;
      }
      // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
      st.stickerCollectTimes = st.stickerCollectTimes || [];
      st.stickerCollectTimes.push(now);
      if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
      try {
        const result = await collectStickerV2(key, messageRef, remark);
        saveSocialV2State();
        log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
        appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
        sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
      } catch (error) {
        const idx = st.stickerCollectTimes.indexOf(now);
        if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
        if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
        saveSocialV2State();
        log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
        sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

    // ── GET /api/socialV2/sticker-image（取表情图给模型看）─────────────────
    if (pathname === '/api/socialV2/sticker-image') {
      if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
      const key = String(url.searchParams.get('key') ?? '').trim();
      const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
      if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentToken && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return true; }
      try {
        const entry = await getStickerImageData(stickerId);
        const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
        const dims = getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
          sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
          return true;
        }
        const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
        const prep = await toModelMedia(fetched.buffer, mimeType, `收藏表情 ${entry.id}`);
        if (!prep.ok) {
          sendJson({ ok: false, error: `表情图片无法提供给模型：${prep.error}` }, 413);
          return true;
        }
        sendJson({
          ok: true,
          key,
          sticker: {
            id: entry.id,
            desc: entry.desc || '',
            localNote: entry.localNote || '',
            tags: entry.tags || [],
            url: entry.url,
            md5: entry.md5,
          },
          image: { mimeType: prep.mimeType, data: prep.buffer.toString('base64') },
          ...(prep.note ? { note: prep.note } : {}),
        });
      } catch (error) {
        sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

    // ── POST /api/socialV2/send-voice（AI 通道发语音）──────────────────────
    if (pathname === '/api/socialV2/send-voice') {
      const body = await readBody();
      const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
      const key = String(body.key ?? body.target ?? '').trim();
      const voice = voiceCfg();
      if (!voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return true; }
      if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return true; }
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
      if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return true; }
      if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, getCfg(), getMode())) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return true;
      }
      // 只要名字（解析）不要内容（预览）：dry-run 也必须经过与真发相同的解析与校验。
      let resolved;
      try {
        resolved = resolveVoicePathForV2(body.voice ?? body.file ?? '');
      } catch (error) {
        sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
        return true;
      }
      try {
        voiceBudgetCheck(key, voice);
        if (body.dryRun === true) {
          const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
          if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return true; }
          sendJson({ ok: true, dryRun: true, key, file: resolved.path, detail: describeAudio(probe) });
          return true;
        }
        const sent = await sendVoiceForV2(key, body.voice ?? body.file, {
          label: body.label ? String(body.label).slice(0, 100) : '',
          verify: body.verify,
          readback: body.readback === true,
          // AI 也可以调音量（默认走 config 的 defaultVolume）
          audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
            ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
            : null,
        });
        sendJson({
          ok: true,
          key,
          messageId: sent.messageId,
          file: path.basename(sent.file),
          detail: sent.detail,
          audioProcessing: sent.audioProcessing,
          // verified=true 表示已用 get_msg 回读到这条消息的 record 段
          verified: sent.verification?.confirmed === true,
          readback: sent.readback,
          warnings: sent.warnings,
        });
      } catch (error) {
        // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
        sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
      }
      return true;
    }

    // ── POST /api/socialV2/send-sticker（发表情包）──────────────────────────
    if (pathname === '/api/socialV2/send-sticker') {
      if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const stickerId = String(body.stickerId ?? '').trim();
      const caption = String(body.message ?? body.caption ?? '').trim();
      const replyToMessageId = body.replyToMessageId;
      const atUserId = body.atUserId ?? null;
      if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
      // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
      if (caption) {
        sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
        return true;
      }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentToken && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return true; }
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (!agentToken) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, getCfg(), getMode())) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return true;
      }
      if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return true; }
      if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
        sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
        return true;
      }
      let quotedInfo = null;
      let actualReplyToMessageId = replyToMessageId;
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        const stForReply = getSocialV2State(key);
        const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
        if (!resolved) {
          sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
          return true;
        }
        quotedInfo = resolved.info;
        actualReplyToMessageId = resolved.messageId;
      }
      const sendCfg = getCfg().socialV2?.send ?? {};
      const now = Date.now();
      try {
        const st = getSocialV2State(key);
        const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
        const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
        const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
        const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
        if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
          sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
          return true;
        }
        st.sendTimes.push(now);
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        const sent = await sendStickerV2(key, stickerId, {
          replyToMessageId: actualReplyToMessageId,
          atUserId,
        });
        // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
        const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
        const text = `[表情包:${label}]`;
        st.recentMessages.push({
          messageId: sent.messageId ? String(sent.messageId) : null,
          sender: '我',
          text: truncateText(text, 200),
          plain: truncateText(text, 200),
          quoteTargetIsSelf: false,
          isOwner: true,
          ownerLabel: '我',
          isSelf: true,
          media: [],
          hasMedia: false,
          forwardIds: [],
          hasForward: false,
          sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
          time: Date.now(),
        });
        const recentLimit = Number(getCfg().socialV2?.context?.recentLimit) || 100;
        if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
        st.lastAiReplyAt = now;
        st.lastActionAt = now;
        st.wakeConfig.noActionCount = 0;
        st.preSleepWaitSatisfiedAt = 0;
        st.preSleepWaitObservedAt = 0;
        st.preSleepWaitAccumMs = 0;
        saveSocialV2State();
        scheduleReplyCheckV2(key);
        log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
        appendActivity(`${key} [sticker] 工具发送表情：${label}`);
        sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
      } catch (error) {
        const st = getSocialV2State(key);
        const idx = st.sendTimes.indexOf(now);
        if (idx >= 0) st.sendTimes.splice(idx, 1);
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        saveSocialV2State();
        log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
        sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

    // ── POST /api/socialV2/send-poke（拍一拍）───────────────────────────────
    if (pathname === '/api/socialV2/send-poke') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return true; }
      if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return true; }
      if (getSocialV2().paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return true; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, getCfg(), getMode())) {
        sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
        return true;
      }
      if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return true; }
      if (kind === 'group' && !targetUserId) {
        sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
        return true;
      }
      if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
        sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
        return true;
      }
      // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
      if (kind === 'group') {
        const memberError = await assertGroupMember(id, targetUserId);
        if (memberError) { sendJson({ ok: false, error: memberError }, 403); return true; }
      }
      const st = getSocialV2State(key);
      const sendCfg = getCfg().socialV2?.send ?? {};
      const now = Date.now();
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
        sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
        return true;
      }
      st.sendTimes.push(now);
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      // 成员校验是异步的（要问 OneBot）；期间操作者可能切模式/改白名单/开静默。
      // 拍一拍此前完全没有发送守卫，这里补上：真正发之前再确认一次。
      const sendGuard = captureSendGuard(key);
      try {
        sendGuard();
        if (shouldBlockSilentReply(key)) {
          const blocked = new Error('静默模式已开启，当前不允许拍一拍');
          blocked.statusCode = 403;
          throw blocked;
        }
        if (kind === 'group') {
          await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
        } else {
          // 私聊拍一拍：send_poke 自动路由到当前私聊对象
          await bot.raw('send_poke', { user_id: id });
        }
        st.lastActionAt = now;
        st.lastAiReplyAt = now;
        st.wakeConfig.noActionCount = 0;
        const pokeText = kind === 'group' ? `[拍一拍] 我拍了拍 ${targetUserId}` : '[拍一拍] 我拍了拍你';
        st.recentMessages.push({
          messageId: null,
          sender: '我',
          text: pokeText,
          plain: pokeText,
          tail: pokeText,
          kind: 'poke',
          quoteTargetIsSelf: false,
          isOwner: true,
          ownerLabel: '我',
          isSelf: true,
          media: [],
          hasMedia: false,
          forwardIds: [],
          hasForward: false,
          poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
          time: Date.now(),
        });
        const recentLimit = Number(getCfg().socialV2?.context?.recentLimit) || 100;
        if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
        st.preSleepWaitSatisfiedAt = 0;
        st.preSleepWaitObservedAt = 0;
        st.preSleepWaitAccumMs = 0;
        saveSocialV2State();
        log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
        appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
        sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
      } catch (error) {
        const idx = st.sendTimes.indexOf(now);
        if (idx >= 0) st.sendTimes.splice(idx, 1);
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
        sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, error?.statusCode ?? 500);
      }
      return true;
    }

    // ── POST /api/socialV2/send-burst（分条发送，不支持引用）────────────────
    if (pathname === '/api/socialV2/send-burst') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      let rawMessages = body.messages;
      if (typeof rawMessages === 'string') {
        const trimmed = rawMessages.trim();
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') rawMessages = parsed;
            else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch {}
        }
      }
      const messages = Array.isArray(rawMessages)
        ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
        : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
      const replyToMessageId = body.replyToMessageId;
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
        return true;
      }
      if (!key || !messages.length) {
        sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
        return true;
      }
      const sendCfgBurst = getCfg().socialV2?.send ?? {};
      if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
        sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
        return true;
      }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentToken && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return true; }
      if (getMode() !== 'reserved2') {
        sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
        return true;
      }
      if (!agentToken) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return true;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, getCfg(), getMode())) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return true;
      }
      if (shouldBlockSilentReply(key)) {
        sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
        return true;
      }
      const sendCfg = getCfg().socialV2?.send ?? {};
      const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
      const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
      if (messages.length > maxMsgs) {
        sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
        return true;
      }
      for (const msg of messages) {
        if (msg.length > maxChars) {
          sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
          return true;
        }
        if (SENSITIVE_RE.test(msg)) {
          sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
          return true;
        }
      }
      const st = getSocialV2State(key);
      const now = Date.now();
      try {
        const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
        const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
        const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
        const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
        if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
          sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
          return true;
        }
        // 先预占发送额度，避免并发绕过限频
        for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
        const sentMessages = await sendMessagesV2(key, messages, delays);
        recordSentMessagesV2(key, sentMessages);
        st.lastAiReplyAt = now;
        st.lastActionAt = now;
        st.wakeConfig.noActionCount = 0;
        saveSocialV2State();
        log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
        appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
        if (sentMessages.length > 0) scheduleReplyCheckV2(key);
        const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
        const spaceWarn = findCjkSpaceWarning(messages);
        const splitWarn = findSplitBoundaryWarning(messages);
        sendJson({
          ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length,
          ...(burstHint ? { hint: burstHint } : {}),
          ...(spaceWarn ? { warn: spaceWarn } : {}),
          ...(splitWarn ? { splitWarn } : {}),
        });
      } catch (error) {
        if (error?.sent?.length) {
          recordSentMessagesV2(key, error.sent);
          log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
        }
        // 失败/未发出的消息回滚预占的发送额度，避免假 429。
        const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
        const failedCount = Math.max(0, messages.length - sentCount);
        for (let i = 0; i < failedCount; i++) {
          const idx = st.sendTimes.indexOf(now);
          if (idx >= 0) st.sendTimes.splice(idx, 1);
        }
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        saveSocialV2State();
        sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
      }
      return true;
    }

    // ── POST /api/socialV2/send-message（统一发送，支持引用/@/gapMode）────────
    if (pathname === '/api/socialV2/send-message') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      let rawMessages = body.messages;
      if (typeof rawMessages === 'string') {
        const trimmed = rawMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') rawMessages = parsed;
            else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch {}
        }
      }
      const isRawString = typeof rawMessages === 'string';
      const messages = Array.isArray(rawMessages)
        ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
        : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
      const replyToMessageId = body.replyToMessageId;
      const atUserId = body.atUserId ?? null;
      // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
      const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
      const gapMs = Number(body.gapMs);
      const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
      if (!key || !messages.length) {
        sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
        return true;
      }
      const sendCfgBurst = getCfg().socialV2?.send ?? {};
      if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
        sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
        return true;
      }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentToken && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return true; }
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (!agentToken) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, getCfg(), getMode())) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return true;
      }
      if (kind === 'private' && atUserId) {
        sendJson({ ok: false, error: '私聊不需要 @' }, 400);
        return true;
      }
      if (shouldBlockSilentReply(key)) {
        sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
        return true;
      }
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
        sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
        return true;
      }
      const sendCfg = getCfg().socialV2?.send ?? {};
      const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
      const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
      if (messages.length > maxMsgs) {
        sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
        return true;
      }
      for (const msg of messages) {
        if (msg.length > maxChars) {
          sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
          return true;
        }
        if (SENSITIVE_RE.test(msg)) {
          sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
          return true;
        }
      }
      const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
      // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
      const st = getSocialV2State(key);
      const now = Date.now();
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
        sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
        return true;
      }
      // 先预占发送额度，避免并发绕过限频
      for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      let quotedInfo = null;
      let actualReplyToMessageId = replyToMessageId;
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
        if (!resolved) {
          // 引用解析失败：回滚已预占的发送额度
          for (let i = 0; i < messages.length; i++) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
          }
          saveSocialV2State();
          sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
          return true;
        }
        quotedInfo = resolved.info;
        actualReplyToMessageId = resolved.messageId;
      }
      try {
        const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
        recordSentMessagesV2(key, sentMessages);
        st.lastAiReplyAt = now;
        st.lastActionAt = now;
        st.wakeConfig.noActionCount = 0;
        saveSocialV2State();
        log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
        appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
        if (sentMessages.length > 0) scheduleReplyCheckV2(key);
        const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
        const spaceWarn = findCjkSpaceWarning(messages);
        const splitWarn = findSplitBoundaryWarning(messages);
        sendJson({
          ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length,
          delays, quoted: quotedInfo,
          ...(burstHint ? { hint: burstHint } : {}),
          ...(spaceWarn ? { warn: spaceWarn } : {}),
          ...(splitWarn ? { splitWarn } : {}),
        });
      } catch (error) {
        if (error?.sent?.length) {
          recordSentMessagesV2(key, error.sent);
          log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
        }
        const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
        const failedCount = Math.max(0, messages.length - sentCount);
        for (let i = 0; i < failedCount; i++) {
          const idx = st.sendTimes.indexOf(now);
          if (idx >= 0) st.sendTimes.splice(idx, 1);
        }
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        saveSocialV2State();
        sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
      }
      return true;
    }

    return false;
  };
}

export default createSocialV2SendHandler;
