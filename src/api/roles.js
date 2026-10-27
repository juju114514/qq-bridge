/**
 * 人格管理：/api/role, /api/role-mode, /api/roles*, /api/roles/content|limit|create|update|rename|delete
 *
 * 「按域拆 handler」第 3 组（roles）。行为与迁移前逐行等价；依赖显式注入。
 *
 * 注意：`/api/roles/limit` 会改**运行时**的 roleInjectMaxChars 与 config.json，
 * 这里不直接改，而是回调 `setInjectLimit(next)`，让状态变更留在 bridge（单一写入点）。
 */

export function createRolesHandler(deps) {
  const {
    sendJson,
    readBody,
    log,
    fs,
    path,
    ROOT,
    readRoleState,
    writeRoleState,
    roleSummaries,
    readRoleContent,
    writeRoleContent,
    roleWarnings,
    roleCharStats,
    roleSectionReport,
    validateRoleName,
    validateRoleContent,
    sanitizeRoleName,
    resolveExistingRole,
    roleFilePath,
    getInjectMaxChars,
    setInjectLimit,
    limits,
  } = deps;

  const roleExists = (name) => fs.existsSync(roleFilePath(name));

  function fail(error, status = 400) {
    sendJson({ ok: false, error: error.message }, status);
    return true;
  }

  return async function handleRoles(req, url) {
    const { pathname } = url;
    const method = req.method;

    // ── POST /api/role —— 切换/清除当前人格 ─────────────────────────────────
    if (method === 'POST' && pathname === '/api/role') {
      const body = await readBody();
      const rs = readRoleState();
      if (body.role && typeof body.role === 'string') {
        const name = sanitizeRoleName(body.role);
        if (!fs.existsSync(path.join(ROOT, 'roles', name + '.md'))) {
          sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
          return true;
        }
        writeRoleState(name, rs.mode);
        log(`控制台：角色已设置为 ${name}`);
        sendJson({ ok: true, role: name });
      } else {
        writeRoleState(null, rs.mode);
        log('控制台：角色已清除');
        sendJson({ ok: true, role: null });
      }
      return true;
    }

    // ── POST /api/role-mode —— 静默/活跃 ───────────────────────────────────
    if (method === 'POST' && pathname === '/api/role-mode') {
      const body = await readBody();
      const rs = readRoleState();
      const mode = body.mode === 'silent' ? 'silent' : 'active';
      writeRoleState(rs.role, mode);
      log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
      sendJson({ ok: true, roleMode: mode });
      return true;
    }

    // ── GET /api/roles —— 列表 ─────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/roles') {
      const rs = readRoleState();
      const summaries = roleSummaries();
      sendJson({
        // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
        // 富信息放在 summaries 里，新老调用方互不影响。
        roles: summaries.map((role) => role.name),
        summaries,
        current: rs.role ?? null,
        limits: {
          nameMax: limits.ROLE_NAME_MAX,
          contentMaxBytes: limits.ROLE_CONTENT_MAX_BYTES,
          injectMaxChars: getInjectMaxChars(),
        },
      });
      return true;
    }

    // ── GET /api/roles/content —— 读某个角色卡 ─────────────────────────────
    if (method === 'GET' && pathname === '/api/roles/content') {
      let name;
      try { name = resolveExistingRole(url.searchParams.get('name')) ?? validateRoleName(url.searchParams.get('name')); } catch (error) { return fail(error); }
      if (!roleExists(name)) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return true; }
      const content = readRoleContent(name);
      sendJson({
        ok: true,
        name,
        content,
        chars: content.length,
        bytes: Buffer.byteLength(content, 'utf8'),
        warnings: roleWarnings(content),
        limits: { injectMaxChars: getInjectMaxChars() },
        stats: roleCharStats(content),
        // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
        sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
      });
      return true;
    }

    // ── POST /api/roles/limit —— 注入上限 ───────────────────────────────────
    if (method === 'POST' && pathname === '/api/roles/limit') {
      const body = await readBody();
      const next = setInjectLimit(body.maxInjectChars);
      sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
      return true;
    }

    // ── POST /api/roles/create ──────────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/roles/create') {
      const body = await readBody();
      let name; let content;
      try {
        name = validateRoleName(body.name);
        content = validateRoleContent(body.content);
      } catch (error) { return fail(error); }
      if (roleExists(name)) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return true; }
      writeRoleContent(name, content);
      log(`控制台：创建人格「${name}」（${content.length} 字符）`);
      sendJson({ ok: true, role: name, warnings: roleWarnings(content) });
      return true;
    }

    // ── POST /api/roles/update ──────────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/roles/update') {
      const body = await readBody();
      let name; let content;
      try {
        name = validateRoleName(body.name);
        content = validateRoleContent(body.content);
      } catch (error) { return fail(error); }
      if (!roleExists(name)) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return true; }
      writeRoleContent(name, content);
      log(`控制台：更新人格「${name}」（${content.length} 字符）`);
      sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content) });
      return true;
    }

    // ── POST /api/roles/rename ──────────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/roles/rename') {
      const body = await readBody();
      let from; let to;
      try {
        from = resolveExistingRole(body.from) ?? validateRoleName(body.from);
        to = validateRoleName(body.to);
      } catch (error) { return fail(error); }
      if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return true; }
      if (!roleExists(from)) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return true; }
      if (roleExists(to)) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return true; }
      fs.renameSync(roleFilePath(from), roleFilePath(to));
      const rs = readRoleState();
      const switched = rs.role === from;
      if (switched) writeRoleState(to, rs.mode);
      log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
      sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
      return true;
    }

    // ── POST /api/roles/delete ──────────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/roles/delete') {
      const body = await readBody();
      let name;
      try { name = resolveExistingRole(body.name) ?? validateRoleName(body.name); } catch (error) { return fail(error); }
      if (!roleExists(name)) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return true; }
      fs.rmSync(roleFilePath(name));
      const rs = readRoleState();
      const cleared = rs.role === name;
      if (cleared) writeRoleState(null, rs.mode);
      log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
      sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
      return true;
    }

    return false;
  };
}

export default createRolesHandler;
