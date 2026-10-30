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
    socialVideo, writeJson, readJsonBody, handleImages, res
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

  return false;
}