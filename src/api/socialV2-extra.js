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
    rootDir, pathModule
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

  return false;
}