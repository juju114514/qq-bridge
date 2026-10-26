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
  } = deps;

  return async function handleSocialV2Send(req, url) {
    if (req.method !== 'POST') return false;
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

    return false;
  };
}

export default createSocialV2SendHandler;
