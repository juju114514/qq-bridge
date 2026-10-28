/**
 * /api/images/message —— 按需读取某条消息里的图片/表情（MCP qq_get_message_images 走这里）。
 *
 * 「按域拆 handler」第 2 组（images）。原则同 status：**行为完全不变**，
 * 只把 if 分支变成导出函数；依赖显式注入。
 *
 * 安全语义（逐条保留）：
 *   · reserved2 模式必须带 agent token；
 *   · chat/reserved（一代）不允许按需取图（图片已内联）；
 *   · agent token 必须对该会话有效，且 qq_get_message_images 工具要启用；
 *   · 会话必须通过 modeAllowed（模式白名单）。
 */

export function createImagesHandler(deps) {
  const {
    sendJson,
    getMode,
    agentTokenOk,
    modeAllowed,
    getCfg,
    v2ToolEnabled,
    findMessageMedia,
    fetchMediaData,
    log,
  } = deps;

  return async function handleImages(req, url) {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const messageId = String(url.searchParams.get('messageId') ?? '').trim();
    const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
    const currentMode = getMode();
    const cfg = getCfg();

    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) {
      sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
      return true;
    }
    if (!messageId) {
      sendJson({ ok: false, error: 'messageId 不能为空' }, 400);
      return true;
    }
    if (currentMode === 'reserved2' && !agentToken) {
      sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
      return true;
    }
    if (currentMode === 'chat' || currentMode === 'reserved') {
      sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
      return true;
    }
    if (agentToken && !agentTokenOk(key, agentToken)) {
      sendJson({ ok: false, error: 'agent token 无效' }, 403);
      return true;
    }

    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if ((typeof id !== 'string' && (!Number.isFinite(id) || id <= 0)) || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
      return true;
    }
    if (agentToken && !v2ToolEnabled('getImages')) {
      sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
      return true;
    }
    if (!agentToken && currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
      sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
      return true;
    }

    const media = findMessageMedia(key, messageId);
    if (!media.length) {
      sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情/视频元数据' });
      return true;
    }
    // mode: auto（默认，长图先 OCR）/ text（只要文字）/ image（只要图，长图切片）/
    //       transcript（视频只要转写）。
    // 视频：kind:'video' 的条目由 fetchMediaData 走"故事板 + 转写"，返回的仍是 images[] 里的一项。
    // 为什么给模型这个开关：长截图切成 5 片 ≈1.5 万 token，而 OCR 出文字只要几百 token。
    // 群里的结论也是这个——「只想知道写了什么就先 OCR，看图才需要切片，两套一起用也行」。
    const rawMode = String(url?.searchParams?.get('mode') ?? '').toLowerCase();
    // transcript 是视频专用（只要转写、不抽帧）；图片遇到它按 auto 处理
    const mode = ['auto', 'text', 'image', 'transcript'].includes(rawMode) ? rawMode : 'auto';
    try {
      const images = await fetchMediaData(media, { mode });
      sendJson({ ok: true, messageId, media, mode, images });
    } catch (error) {
      log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
    }
    return true;
  };
}

export default createImagesHandler;
