// 控制台"杂项"路由 —— 波次 4 第二批从 bridge.js 内联搬出来的 6 条。
//
// 它们原先散在 bridge 的 if 链里，各自 new 一次 handler；现在统一成
// 「匹配路径 → 委托 → 返回 true/false」的派发链契约。
//
// 为什么单独成文件而不是塞进已有模块：这 6 条跨了三个域（会话待办 / DSH 模型 /
// 控制台运维 / 提醒投递），归到哪个域都不合适；先集中在这里，等某个域长大了再拆。
export async function handleConsoleMiscRoutes(req, url, deps = {}) {
  const p = url.pathname;
  const {
    pending,
    consoleDsh,
    getConsoleOps,
    createConsoleNotifyHandler,
    notifyDeps,
    sendJson,
    readBody,
    log,
    createWhitelistHandler, createSecurityHandler, handleImages,
    cfgGet, rootDir, pathModule, crypto, stateDir,
    getStateDirHardened, setStateDirHardened, manualDirCommand, hardenStateDirAcl,
    readConfigObject, atomicWriteJson, normalizeOwnerQQ, reconcileSessionPolicies
  } = deps;

  // GET /api/pending —— 待回答的提问 / 待审批的工具调用
  if (req.method === 'GET' && p === '/api/pending') {
    const list = [];
    for (const [key, item] of pending.entries()) {
      list.push({
        key,
        kind: item.kind,
        sessionId: item.sessionId,
        ...(item.kind === 'approval' ? { toolName: item.toolName, reason: item.reason, approvalId: item.approvalId } : {}),
        ...(item.kind === 'question' ? { questions: item.questions } : {})
      });
    }
    sendJson({ pending: list });
    return true;
  }

  // GET /api/dsh/model · POST /api/dsh/effort —— DSH 的模型与思考档位
  if (req.method === 'GET' && p === '/api/dsh/model') {
    await consoleDsh.handleModel({ sendJson, readBody });
    return true;
  }
  if (req.method === 'POST' && p === '/api/dsh/effort') {
    await consoleDsh.handleEffort({ sendJson, readBody });
    return true;
  }

  // POST /api/console/token · POST /api/test-send —— 控制台令牌与测试发送
  if (req.method === 'POST' && p === '/api/console/token') {
    await getConsoleOps().handleToken({ readBody, sendJson });
    return true;
  }
  if (req.method === 'POST' && p === '/api/test-send') {
    await getConsoleOps().handleTestSend({ readBody, sendJson });
    return true;
  }

  // POST /api/console/notify-ai —— 后台向指定会话投递提醒
  if (req.method === 'POST' && p === '/api/console/notify-ai') {
    await createConsoleNotifyHandler(notifyDeps)(req, url);
    return true;
  }


  // GET/POST /api/whitelist —— 白名单可视化编辑（写 config.json + 热更新）
  if (p === '/api/whitelist') {
    await createWhitelistHandler({
      sendJson, readBody, log,
      getCfg: () => cfgGet(), rootDir, path: pathModule,
      readConfigObject, atomicWriteJson, normalizeOwnerQQ, reconcileSessionPolicies
    })(req, url);
    return true;
  }

  // GET/POST /api/security —— 安全拦截 / 目录 ACL / 手动加固
  if (p === '/api/security') {
    await createSecurityHandler({
      sendJson, readBody, log,
      getCfg: () => cfgGet(), rootDir, path: pathModule, crypto,
      stateDir, getStateDirHardened, setStateDirHardened,
      manualDirCommand, hardenStateDirAcl,
      readConfigObject, atomicWriteJson
    })(req, url);
    return true;
  }

  // GET /api/images/message —— 取某条消息里的图片（终端处理器，自己写响应）
  if (req.method === 'GET' && p === '/api/images/message') {
    await handleImages(req, url);
    return true;
  }

  return false;
}