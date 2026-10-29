// 管理命令（只读/状态类）：/status /role /silent /active。
//
// 为什么只搬这四个：
//   /reset 会动 sessionEpoch 与一堆 Map，/song 会 spawn PowerShell，/空间评论 会
//   deliverPrompt 起任务 —— 它们与桥接内部状态纠缠太深，硬搬只会把复杂度挪个地方。
//   这四个是干净的：只读状态 + 调注入进来的写函数。
//
// 语义：返回 true = 已处理；false = 不是这四个命令（继续交给 /reset 或 DSH 斜杠命令）。

export function createIncomingStatusCommands(deps = {}) {
  const {
    sendToQQ, readRoleState, writeRoleStateForKey,
    sanitizeRoleName, resolveRoleName, listRoles, roleName,
    allowed, getCfg, getState, getRoleState,
    getSelfCheck, buildSelfCheckReport
  } = deps;

  async function handleStatusCommands(ctx = {}) {
    const { key, kind, id, plainContent } = ctx;
    const cfg = getCfg();
    const roleState = getRoleState();
    const state = getState();
    // /自检 —— 完整健康报告。**管理员限定**（调用方已做 isOwner 判定），
    // 因为里面有网关地址/队列积压/会话数这些运维信息，不能给群友看。
    // 想给群友看健康状态，用 shortStatus（只回"在线/维护中"）。
    if (plainContent === '/自检' || plainContent === '/selfcheck') {
      try {
        const snap = typeof getSelfCheck === 'function' ? getSelfCheck() : {};
        const text = typeof buildSelfCheckReport === 'function' ? buildSelfCheckReport(snap) : '（自检模块未接）';
        await sendToQQ(key, text);
      } catch (error) {
        await sendToQQ(key, `自检失败：${error?.message ?? error}`);
      }
      return true;
    }
    if (plainContent === '/status') {
      const rs = readRoleState();
      await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ? roleName(rs.role) : '无'}；模式 ${rs.mode}`);
      return true;
    }
    if (plainContent === '/role' || plainContent.startsWith('/role ')) {
      const rawName = plainContent.slice(5).trim();
      const name = sanitizeRoleName(rawName);
      const where = kind === 'group' ? '本群' : '本私聊';
      if (!rawName || name === 'off' || name === 'clear') {
        writeRoleStateForKey(key, null, roleState.mode);
        await sendToQQ(key, kind === 'group'
          ? `已解除${where}的人设锁定，回落到默认设置。`
          : `已清除${where}的角色，恢复正常人格。`);
      } else {
        const resolved = resolveRoleName(rawName) || resolveRoleName(name);
        if (!resolved) {
          await sendToQQ(key, `角色「${rawName}」不存在。现有：${listRoles().map((id) => roleName(id)).join('、') || '（无）'}`);
        } else {
          writeRoleStateForKey(key, resolved, roleState.mode);
          await sendToQQ(key, kind === 'group'
            ? `${where}的人设已锁定为：${resolved}。（只有管理员能改，其他会话不受影响）`
            : `已切换${where}的角色：${resolved}。（其他会话不受影响）`);
        }
      }
      return true;
    }
    if (plainContent === '/silent' || plainContent === '/quiet') {
      writeRoleStateForKey(key, roleState.role, 'silent');
      await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
      return true;
    }
    if (plainContent === '/active' || plainContent === '/speak') {
      writeRoleStateForKey(key, roleState.role, 'active');
      await sendToQQ(key, '已退出静默模式，恢复正常回复。');
      return true;
    }
        return false;
  }

  return { handleStatusCommands };
}
