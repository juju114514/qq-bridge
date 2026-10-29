// 人物笔记的读写接口（POST /api/socialV2/people-note）。
//
// 为什么需要：模型能"认人"（读印象）但**写不回去** —— 这次补上"记事"和"纠错"。
// 三件事都必须支持，否则记忆是个死档案：
//   add   记住一条（scope 决定是"这个群里的他"还是"整体印象"）
//   list  看现在记了什么（按关系档位截断，跟提示词注入一致）
//   clear 删掉一条（写错了要能改，不能只能 /reset 全清）
//
// 权限：与其它 agent 路由一致 —— 有 token 就校验 token + 会话允许 + 工具开关；
// 操作者（无 token）路径由调用方决定是否放行（这条路只在控制台/本机用）。

export function createPeopleNoteHandler(baseDeps = {}) {
  const {
    log = () => {},
    agentTokenOk, v2SessionAllowed, v2ToolEnabled,
    loadPeopleDb, schedulePeopleSave,
    setNote, removeNote, notesInScope, visibleNotes, levelOf, normalizeQQ
  } = baseDeps;

  async function handle(ctx = {}) {
    const { req, sendJson, readBody } = ctx;
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const token = req.headers['x-agent-token'];
    const targetQq = normalizeQQ(body.qq ?? body.userId ?? '');
    const scope = String(body.scope ?? key ?? 'global').trim();
    const op = String(body.op ?? 'add').trim().toLowerCase();

    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (token && !v2ToolEnabled('peopleNote')) { sendJson({ ok: false, error: '工具未启用：qq_people_note' }, 403); return true; }
    if (!targetQq) { sendJson({ ok: false, error: 'qq 不能为空（要记的是谁）' }, 400); return true; }

    try {
      const db = loadPeopleDb();
      if (op === 'list') {
        const level = levelOf(db, targetQq);
        const inScope = notesInScope(db, targetQq, scope);
        const visible = visibleNotes(db, targetQq, scope, { level });
        // 关系档位低（stranger/listed）时笔记**不会注入提示词**（防止把陌生人档案带进上下文）。
        // 不说明的话，模型会以为"记了却没生效"，用户也会困惑 —— 所以显式给出隐藏条数与原因。
        const hidden = Math.max(0, inScope.length - visible.length);
        sendJson({
          ok: true,
          op,
          qq: targetQq,
          scope,
          level,
          inScope,
          visible,
          hidden,
          hint: hidden > 0
            ? `${hidden} 条暂不注入提示词：关系档位是 ${level}（陌生人/仅名单），多聊几次会自动升档`
            : ''
        });
        return true;
      }
      if (op === 'add') {
        const text = String(body.text ?? '').trim();
        if (!text) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return true; }
        const r = setNote(db, { qq: targetQq, scope, text });
        schedulePeopleSave();
        log(`[people] 记笔记 ${targetQq} @${r.scope}（${r.added ? '新增' : '已存在'}，共 ${r.count} 条）`);
        sendJson({ ok: true, op, qq: targetQq, ...r });
        return true;
      }
      if (op === 'clear') {
        const text = String(body.text ?? '').trim();
        const r = removeNote(db, { qq: targetQq, scope, text });
        schedulePeopleSave();
        log(`[people] 删笔记 ${targetQq} @${r.scope}（${r.removed ? '已删' : '没找到'}，剩 ${r.count} 条）`);
        sendJson({ ok: true, op, qq: targetQq, ...r });
        return true;
      }
      sendJson({ ok: false, error: `不支持的 op：${op}（add / list / clear）` }, 400);
    } catch (error) {
      log(`人物笔记操作失败 ${op} ${targetQq}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
    }
    return true;
  }

  return { handle };
}