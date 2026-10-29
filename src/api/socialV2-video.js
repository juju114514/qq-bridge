// 控制台：视频相关只读接口（cookie 体检 / 视频链接分析）。
//
// 为什么单独一块：这两条都在 `/api/socialV2/video*` 前缀下，只读、无状态，
// 依赖也就五六个 —— 属于 startConsoleServer 里最好搬的一段。
//
// 依赖分两类（和其它控制台模块一致）：
//   · baseDeps —— 启动给一次
//   · ctx     —— 每请求的 res / writeJson / readJsonBody（**不能缓存**）

export function createSocialV2VideoHandlers(baseDeps = {}) {
  const {
    log = () => {},
    videoLinkConfig, cookieHealth, describeRemaining,
    videoLinkToModelParts, v2ToolEnabled
  } = baseDeps;

  /** GET /api/socialV2/video-cookies —— 抖音能不能取到流，取决于 cookies 是否还新鲜 */
  async function handleCookies(ctx = {}) {
    const { writeJson } = ctx;
    try {
      const cookiePath = videoLinkConfig().cookiesPath;
      const health = cookieHealth(cookiePath);
      writeJson({
        ok: true,
        path: cookiePath ? String(cookiePath) : '',
        healthy: health.ok,
        code: health.code ?? 'ok',
        message: health.message ?? '',
        remaining: health.stats?.earliestExpiry ? describeRemaining(health.stats.earliestExpiry) : '',
        stats: health.stats
      });
    } catch (error) {
      writeJson({ ok: false, error: `cookie 体检失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  /**
   * POST /api/socialV2/video-link —— 模型把用户贴的链接交过来，
   * 用 yt-dlp 下前 N 秒再分析。与消息附件那条路分开：不依赖 QQ 媒体段，但要过站点白名单。
   */
  async function handleLink(ctx = {}) {
    const { req, writeJson, readJsonBody } = ctx;
    const body = await readJsonBody(req);
    const linkUrl = String(body?.url ?? '').trim();
    // meta = 只取作者/标题/文案（不下载视频，风控最低）
    const mode = body?.mode === 'transcript' ? 'transcript' : body?.mode === 'meta' ? 'meta' : 'storyboard';
    if (!linkUrl) { writeJson({ ok: false, error: 'url 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getImages')) {
      writeJson({ ok: false, error: '工具未启用：qq_open_video' }, 403);
      return true;
    }
    try {
      const got = await videoLinkToModelParts(linkUrl, mode);
      if (!got.ok) { writeJson({ ok: false, url: linkUrl, mode, error: got.error }); return true; }
      if (got.textOnly) { writeJson({ ok: true, url: linkUrl, mode, text: got.textOnly }); return true; }
      writeJson({
        ok: true,
        url: linkUrl,
        mode,
        mimeType: got.board.mimeType,
        data: got.board.buffer.toString('base64'),
        note: got.note
      });
    } catch (error) {
      log(`视频链接分析失败 ${linkUrl}: ${error?.message ?? error}`);
      writeJson({ ok: false, url: linkUrl, error: `视频链接分析失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  return { handleCookies, handleLink };
}