// 管理命令（只读/状态类）：/status /role /silent /active。
//
// 为什么只搬这四个：
//   /reset 会动 sessionEpoch 与一堆 Map，/song 会 spawn PowerShell，/空间评论 会
//   deliverPrompt 起任务 —— 它们与桥接内部状态纠缠太深，硬搬只会把复杂度挪个地方。
//   这四个是干净的：只读状态 + 调注入进来的写函数。
//
// 语义：返回 true = 已处理；false = 不是这四个命令（继续交给 /reset 或 DSH 斜杠命令）。

import { parseRemindCommand, formatTaskList, REMIND_HELP } from './scheduler/commands.js';
import { getSchedulerInstance } from './scheduler/instance.js';

export function createIncomingStatusCommands(deps = {}) {
  const {
    sendToQQ, readRoleState, writeRoleStateForKey,
    sanitizeRoleName, resolveRoleName, listRoles, roleName,
    allowed, getCfg, getState, getRoleState,
    getSelfCheck, buildSelfCheckReport, getDecisionTrace, schedulerDeps
  } = deps;

  async function handleStatusCommands(ctx = {}) {
    const { key, kind, id, plainContent } = ctx;
    const cfg = getCfg();
    const roleState = getRoleState();
    const state = getState();
    // /自检 —— 完整健康报告。**管理员限定**（调用方已做 isOwner 判定），
    // 因为里面有网关地址/队列积压/会话数这些运维信息，不能给群友看。
    // 想给群友看健康状态，用 shortStatus（只回"在线/维护中"）。
    // 兼容几种写法：/自检、自检、／自检（全角）、/selfcheck
    // 真实事故：用户发了「/自检」，但严格相等没匹配上（客户端可能带全角斜杠或空格），
    // 结果命令落到模型手里，模型自己编了一份"自检报告"。
    const selfCheckCmd = String(plainContent ?? '').trim().replace(/^[@＠]\S+\s*/, '');
    if (/^[\/／]?(自检|selfcheck)$/i.test(selfCheckCmd)) {
      try {
        const snap = typeof getSelfCheck === 'function' ? getSelfCheck() : {};
        const text = typeof buildSelfCheckReport === 'function' ? buildSelfCheckReport(snap) : '（自检模块未接）';
        await sendToQQ(key, text);
      } catch (error) {
        await sendToQQ(key, `自检失败：${error?.message ?? error}`);
      }
      return true;
    }
    // /提醒（/remind、/定时）—— **管理员限定**，桥接直接执行不经过模型。
    // 支持 daily / once / in 30m / weekly / workdays / monthly / random；
    // 内容前加 ai = 叫 AI 来说，否则发固定文字。默认只发给管理员自己的私聊。
    const remind = /^[\/／](remind|提醒|定时)(\s|$)/i.test(String(plainContent ?? '').trim())
      ? parseRemindCommand(String(plainContent ?? '').trim(), { now: Date.now(), tz: getCfg()?.scheduler?.timezone || 'Asia/Shanghai' })
      : null;
    if (remind) {
      try {
        if (remind.error) { await sendToQQ(key, remind.error); return true; }
        if (remind.action === 'help') { await sendToQQ(key, REMIND_HELP); return true; }
        const sched = getSchedulerInstance(schedulerDeps);
        const ownerTarget = `private:${String(getCfg()?.ownerQQ ?? '').trim()}`;
        if (remind.action === 'list') { await sendToQQ(key, formatTaskList(sched.listTasks())); return true; }
        if (remind.action === 'delete') { sched.deleteTask(remind.id, { source: 'owner-command' }); await sendToQQ(key, `已删除任务 #${remind.id}`); return true; }
        if (remind.action === 'enable' || remind.action === 'disable') {
          sched.setEnabled(remind.id, remind.action === 'enable', { source: 'owner-command' });
          await sendToQQ(key, `任务 #${remind.id} 已${remind.action === 'enable' ? '启用' : '停用'}`);
          return true;
        }
        if (remind.action === 'run') {
          const r = await sched.runNow(remind.id, { source: 'owner-command' });
          await sendToQQ(key, r?.outcomes?.[0]?.ok === false ? '执行了，但投递失败（看日志）' : `已执行任务 #${remind.id}`);
          return true;
        }
        if (remind.action === 'add') {
          const task = sched.createTask({ ...remind.task, targets: [ownerTarget] }, { source: 'owner-command' });
          await sendToQQ(key, `已建任务 #${task.id}：${task.scheduleText}\n只发给你自己；要发群请用控制台「定时任务」页。`);
          return true;
        }
        await sendToQQ(key, REMIND_HELP);
      } catch (error) {
        await sendToQQ(key, `定时任务出错：${error?.message ?? error}`);
      }
      return true;
    }

    // /诊断 [全部|#序号] —— **管理员限定**。
    // 回答"这条消息为什么没回我"：闸门/唤醒/投递 每一步的判定都在这。
    // 为什么值得一个命令：handleIncoming 里有 8 个提前 return 的点，以前全是沉默的。
    const diagCmd = String(plainContent ?? '').trim().replace(/^[@＠]\S+\s*/, '');
    const diagMatch = /^[\/／]?(?:诊断|diag)(?:\s+(\S+))?$/i.exec(diagCmd);
    if (diagMatch) {
      try {
        const trace = typeof getDecisionTrace === 'function' ? getDecisionTrace() : null;
        if (!trace) {
          await sendToQQ(key, '【诊断】决策追踪未接（这版没启用）');
          return true;
        }
        const arg = String(diagMatch[1] ?? '').trim();
        if (!arg) {
          await sendToQQ(key, trace.formatReport({ key, limit: 8 }));
        } else if (arg === '全部' || arg === 'all') {
          await sendToQQ(key, trace.formatReport({ limit: 12 }));
        } else if (/^#?\d+$/.test(arg)) {
          const rec = trace.find(arg.replace('#', ''));
          await sendToQQ(key, rec ? trace.formatOne(rec) : `【诊断】没找到 #${arg}（缓冲 80 条，重启即清）`);
        } else {
          await sendToQQ(key, '【诊断】用法：/诊断 │ /诊断 全部 │ /诊断 #12');
        }
      } catch (error) {
        await sendToQQ(key, `诊断失败：${error?.message ?? error}`);
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
