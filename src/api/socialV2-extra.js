// socialV2 的"薄委托"路由 —— 波次 4 第三批（7 条）。
//
// 这些端点在 bridge 里原本只是 `if (path) { await 某handler(...); return; }`，
// 真正的逻辑早就在 src/api/*.js 里了。搬出来只是为了**把路径判定也搬走**，
// 让 bridge 的内联 if 数量继续下降（棘轮：只减不增）。
export async function handleSocialV2ExtraRoutes(req, url, deps = {}) {
  const p = url.pathname;
  const {
    sendJson, readBody,
    createSocialV2InspectHandler, inspectDeps,
    getPeopleNoteHandler, getGroupMembersHandler, getSlangSubmitHandler,
    socialVideo, writeJson, readJsonBody, handleImages, res,
    cfgGet, getSocialV2State, computeWakeSafety, gateAgent,
    createSocialV2ConfigHandler, createSocialV2PromptHandler, promptDeps,
    readConfigObject, atomicWriteJson, refreshAllDefaultWakeConfigs,
    rootDir, pathModule,
    socialV2, clearAllSocialV2Timers, setupSleepTimerV2, scheduleProactiveCheckV2,
    saveSocialV2State, modeGet, fetchMediaData, log,
    agentTokenOk, v2SessionAllowed, v2ToolEnabled, shouldBlockSilentReply, handleV2Wait,
    pathMod, fsMod, osMod, spawnFn, resolveRuntimeDir, ensureDirSafe,
    stickerEnabled, syncStickerLibrary, formatStickerList, getStickerEntries, getStickerSyncedAt,
    stickerSyncNow, lastForcedAgentStickerSyncGet, setLastForcedAgentStickerSync
  } = deps;

  // 单条消息详情 / 合并转发取件
  if (p === '/api/socialV2/message-detail' || p === '/api/socialV2/forward-message') {
    await createSocialV2InspectHandler(inspectDeps)(req, url);
    return true;
  }

  // 人物笔记
  if (req.method === 'POST' && p === '/api/socialV2/people-note') {
    await getPeopleNoteHandler().handle({ req, sendJson, readBody });
    return true;
  }

  // 群成员列表
  if (req.method === 'GET' && p === '/api/socialV2/group-members') {
    await getGroupMembersHandler().handle({ req, url, sendJson });
    return true;
  }

  // 黑话候选提交
  if (req.method === 'POST' && p === '/api/socialV2/slang/submit') {
    await getSlangSubmitHandler().handle({ req, sendJson, readBody });
    return true;
  }

  // 抖音 cookies 状态 / 链接解析
  if (req.method === 'GET' && p === '/api/socialV2/video-cookies') {
    await socialVideo.handleCookies({ writeJson: (obj, status = 200) => writeJson(res, obj, status) });
    return true;
  }
  if (req.method === 'POST' && p === '/api/socialV2/video-link') {
    await socialVideo.handleLink({ req, writeJson: (obj, status = 200) => writeJson(res, obj, status), readJsonBody });
    return true;
  }

  // 图片消息（终端处理器：自己写响应）
  if (req.method === 'GET' && p === '/api/socialV2/video') {
    await handleImages(req, url);
    return true;
  }


  // ── GET /api/socialV2/state —— 会话唤醒状态快照（agent token 三重校验） ──────
  if (req.method === 'GET' && p === '/api/socialV2/state') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (!gateAgent(key)) return true;
    const st = getSocialV2State(key);
    sendJson({
      ok: true,
      key,
      wakeConfig: st.wakeConfig,
      wakeSafety: computeWakeSafety(st.wakeConfig),
      unreadCount: st.unread.length,
      recentCount: st.recentMessages.length,
      lastWakeReason: st.lastWakeReason,
      lastAiReplyAt: st.lastAiReplyAt
    });
    return true;
  }

  // ── GET /api/socialV2/active-members —— 按近期发言统计活跃成员 ─────────────
  if (req.method === 'GET' && p === '/api/socialV2/active-members') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (!gateAgent(key, 'getActiveMembers')) return true;
    const st = getSocialV2State(key);
    const map = new Map();
    for (const m of st.recentMessages) {
      if (!m || m.isSelf) continue;
      const uid = m.userId ? String(m.userId) : '';
      const bucket = uid || String(m.sender || '未知');
      const cur = map.get(bucket) || { sender: m.sender || bucket, userId: uid || undefined, count: 0, lastTime: 0, isOwner: false };
      if (!cur.userId && uid) cur.userId = uid;
      cur.count += 1;
      if (m.time > cur.lastTime) cur.lastTime = m.time;
      if (m.isOwner) cur.isOwner = true;
      map.set(bucket, cur);
    }
    const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
    sendJson({ ok: true, key, members });
    return true;
  }

  // ── GET /api/socialV2/tools —— 工具面开关（模型看不到工具时先看这里） ──────
  if (req.method === 'GET' && p === '/api/socialV2/tools') {
    const flags = cfgGet()?.socialV2?.tools ?? {};
    const getImagesOn = flags.getImages !== false;
    writeJson(res, {
      ok: true,
      getImages: getImagesOn,
      tools: {
        image: { name: 'qq_get_message_images', flag: 'getImages', registered: getImagesOn },
        video: { name: 'qq_get_message_video', flag: 'getImages', registered: getImagesOn },
        link: { name: 'qq_open_video', flag: 'getImages', registered: getImagesOn }
      },
      otherDisabled: Object.entries(flags).filter(([, v]) => v === false).map(([k]) => k),
      hint: getImagesOn
        ? '这三个工具会注册；如果模型看不到，多半是改完代码/开关后没重启 DSH（MCP 工具清单是启动快照）'
        : 'socialV2.tools.getImages=false ⇒ 图片/视频/链接三件套都不会注册（模型看不到、也不占 token）；要用来改回 true 并重启 DSH'
    });
    return true;
  }


  // ── POST /api/socialV2/config —— 改 socialV2 配置（写 config.json + 热更新）──
  if (req.method === 'POST' && p === '/api/socialV2/config') {
    await createSocialV2ConfigHandler({
      sendJson, readBody, log,
      getCfg: () => cfgGet(), rootDir: rootDir, path: pathModule,
      readConfigObject, atomicWriteJson, refreshAllDefaultWakeConfigs
    })(req, url);
    return true;
  }

  // ── GET /api/socialV2/prompt —— 模型看到的那份提示词（自检入口）──────────
  if (req.method === 'GET' && p === '/api/socialV2/prompt') {
    await createSocialV2PromptHandler(promptDeps)(req, url);
    return true;
  }


  // ── POST /api/socialV2/activity —— 暂停 / 恢复二代 AI（会停或重建全部定时器）──
  if (req.method === 'POST' && p === '/api/socialV2/activity') {
    const body = await readBody();
    const paused = body.paused === true;
    socialV2.paused = paused;
    if (paused) {
      clearAllSocialV2Timers();
      log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
    } else {
      log('控制台：二代 AI 已恢复');
      for (const key of socialV2.conversations.keys()) {
        setupSleepTimerV2(key);
        scheduleProactiveCheckV2(key);
      }
    }
    saveSocialV2State();
    sendJson({ ok: true, paused: socialV2.paused });
    return true;
  }

  // ── POST /api/socialV2/forward-media —— 取合并转发里的图片 ─────────────────
  if (req.method === 'POST' && p === '/api/socialV2/forward-media') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const media = Array.isArray(body.media) ? body.media : [];
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (!gateAgent(key, 'getForwardMsg')) return true;
    if (modeGet() !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return true; }
    if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return true; }
    try {
      const images = await fetchMediaData(media);
      sendJson({ ok: true, key, media, images });
    } catch (error) {
      log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
      sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }


  // ── POST /api/socialV2/song —— 点歌（spawn PowerShell + ffmpeg，10~20s 后发语音条）──
  if (req.method === 'POST' && p === '/api/socialV2/song') {
    const body = await readBody();
    const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
    const key = String(body.key ?? '').trim();
    const name = String(body.name ?? '').trim().slice(0, 60);
    const quality = String(body.quality ?? '').trim();
    const full = body.full === true;
    const seconds = full ? 300 : Math.max(10, Math.min(300, Number(body.seconds) || 40));
    if (modeGet() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (!name) { sendJson({ ok: false, error: 'name 不能为空（歌名/歌手）' }, 400); return true; }
    if (req.headers['x-agent-token']) {
      if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_song（需要开启语音工具）' }, 403); return true; }
      if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    }
    if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }
    // 点歌同样依赖 powershell.exe（song.ps1 里还要 ffmpeg）：非 Windows 上直接说清楚，别让用户对着 ENOENT 猜。
    if (process.platform !== 'win32' && !process.env.QQBOT_SONG_SCRIPT) {
      sendJson({ ok: false, error: `点歌依赖 Windows PowerShell（当前是 ${process.platform}）；设 QQBOT_SONG_SCRIPT 可指定脚本路径` }, 501);
      return true;
    }
    const songScript = process.env.QQBOT_SONG_SCRIPT || pathMod.join(resolveRuntimeDir('QQBOT_TOOLS', 'tools', ''), 'song.ps1');
    if (!fsMod.existsSync(songScript)) { sendJson({ ok: false, error: '点歌脚本不存在' }, 500); return true; }
    const nameFile = pathMod.join(osMod.tmpdir(), `qq-song-${Date.now()}.txt`);
    try { fsMod.writeFileSync(nameFile, name, 'utf8'); } catch (error) { sendJson({ ok: false, error: `写歌名临时文件失败：${error?.message ?? error}` }, 500); return true; }
    let songLog = null;
    try { songLog = fsMod.openSync(pathMod.join(ensureDirSafe(resolveRuntimeDir('QQBOT_LOGS', 'logs', '')), 'song.log'), 'a'); } catch { songLog = null; }
    const songStdio = songLog !== null ? ['ignore', songLog, songLog] : 'ignore';
    try {
      const songArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', songScript, '-NameFile', nameFile, '-Key', key, '-Seconds', String(seconds)];
      if (full) songArgs.push('-Full');
      if (quality) songArgs.push('-Quality', quality);
      const child = spawnFn('powershell.exe', songArgs, { windowsHide: true, stdio: songStdio });
      child.on('exit', (code) => log(`[song] ${key} 结束 code=${code}（${name}｜${seconds}s）`));
      child.on('error', (error) => log(`[song] ${key} 失败：${error?.message ?? error}`));
      log(`[song] ${key} 开始点歌（${name}｜${seconds}s｜${quality || '普通'}）`);
      sendJson({ ok: true, key, name, seconds, note: '正在下载并截取，约 10~20 秒后以语音条发出' });
    } catch (error) {
      sendJson({ ok: false, error: `启动点歌失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  // ── POST /api/socialV2/sticker-list —— 表情列表（AI 强制刷新有 10s 最小间隔）──
  if (req.method === 'POST' && p === '/api/socialV2/sticker-list') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const query = String(body.query ?? '').trim();
    const maxCount = Math.max(1, Number(cfgGet()?.socialV2?.sticker?.maxListCount) || 100);
    const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
    let force = body.refresh === true;
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return true; }
    // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载
    if (req.headers['x-agent-token'] && force) {
      const at = stickerSyncNow();
      if (at - lastForcedAgentStickerSyncGet() < 10000) force = false;
      else setLastForcedAgentStickerSync(at);
    }
    try {
      const synced = await syncStickerLibrary(force);
      const list = formatStickerList(synced?.entries ?? getStickerEntries(), query, count);
      sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? getStickerSyncedAt(), fromCache: !force });
    } catch (error) {
      sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  // ── POST /api/socialV2/wait —— 长轮询等待（终端处理器：自己写响应）────────
  if (req.method === 'POST' && p === '/api/socialV2/wait') {
    await handleV2Wait(req, res, url);
    return true;
  }

  return false;
}