// 每个群接入哪个角色 + 角色状态（潜水/活跃）（0.4.98）
//
// 背景：桥接里已经有"按会话设置角色"的能力（rolesByKey / readRoleStateForKey），
// 但控制台**从来没有一页能看清"哪个群在用什么角色"**。用户问"检查时是否有群聊人设卡隔离问题"，
// 要看隔离是否成立，首先得能看见。这里把判定逻辑抽成纯函数，方便测、也方便页面复用。
//
// 生效规则（与 bridge 的 readRoleStateForKey 一致）：
//   1. 该会话有单独记录 → 用记录里的 role
//   2. 群聊且开启 groupEnabled → 用 groupDefaultName
//   3. 群聊且没开 → 不注入人设（null）
//   4. 私聊且无记录 → 跟随全局角色

export const WAKE_LABELS = {
  active: '活跃',
  diving: '潜水'
};

/** 角色来源：单独 / 群默认 / 全局 / 无 */
export function roleSource({ key = '', record = null, groupEnabled = false } = {}) {
  if (record && typeof record === 'object' && record.role != null) return 'per-key';
  if (String(key).startsWith('group:')) return groupEnabled ? 'group-default' : 'none';
  return 'global';
}

/**
 * 计算某会话最终生效的角色。
 * @returns {{role:string|null, source:string, mode:string}}
 */
export function effectiveRole({ key = '', record = null, globalRole = null, groupEnabled = false, groupDefaultName = null } = {}) {
  if (record && typeof record === 'object' && record.role != null) {
    return { role: String(record.role), source: 'per-key', mode: String(record.mode || 'active') };
  }
  if (String(key).startsWith('group:')) {
    if (groupEnabled) {
      const def = String(groupDefaultName || '').trim();
      return def ? { role: def, source: 'group-default', mode: 'active' } : { role: null, source: 'none', mode: 'active' };
    }
    return { role: null, source: 'none', mode: 'active' };
  }
  return { role: globalRole ? String(globalRole) : null, source: globalRole ? 'global' : 'none', mode: 'active' };
}

/** 唤醒状态的一句话（潜水多久 / 活跃 / 暂停） */
export function wakeLabel(wakeConfig = {}, { paused = false, now = Date.now() } = {}) {
  if (paused) return '已暂停';
  const mode = String(wakeConfig?.mode || 'active');
  const label = WAKE_LABELS[mode] || mode;
  if (mode === 'diving') {
    if (wakeConfig?.infinite) return `${label}（条件唤醒）`;
    const until = Number(wakeConfig?.sleepUntil || 0);
    if (until > now) {
      const mins = Math.max(1, Math.round((until - now) / 60000));
      return `${label}（还有约 ${mins} 分钟）`;
    }
    return `${label}（已到期，等下条消息唤醒）`;
  }
  return label;
}

/**
 * 把"会话列表 + 角色记录 + 配置"合成页面要的行。
 * @param {{conversations:Array, rolesByKey:Object, globalRole:string|null, groupEnabled:boolean, groupDefaultName:string|null, paused:boolean, now:number}} p
 */
export function summarizeAssignments({ conversations = [], rolesByKey = {}, globalRole = null, groupEnabled = false, groupDefaultName = null, paused = false, now = Date.now() } = {}) {
  return conversations
    .map((c) => {
      const key = String(c?.key || '');
      if (!key) return null;
      const record = rolesByKey[key] || null;
      const eff = effectiveRole({ key, record, globalRole, groupEnabled, groupDefaultName });
      const kind = key.startsWith('group:') ? 'group' : 'private';
      const id = key.split(':')[1] || '';
      return {
        key,
        kind,
        id,
        label: (kind === 'group' ? '群 ' : '私聊 ') + id,
        role: eff.role,
        source: eff.source,
        mode: eff.mode,
        wake: wakeLabel(c?.wakeConfig, { paused, now }),
        wakeMode: String(c?.wakeConfig?.mode || 'active'),
        overridden: eff.source === 'per-key'
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'group' ? -1 : 1;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
}

/** 隔离检查：同一个 key 反复写、不同 key 互不影响 */
export function isolationReport({ conversations = [], rolesByKey = {}, groupEnabled = false } = {}) {
  const issues = [];
  const seen = new Set();
  for (const c of conversations) {
    const key = String(c?.key || '');
    if (!key) continue;
    if (seen.has(key)) issues.push({ key, problem: 'duplicate-key' });
    seen.add(key);
    const rec = rolesByKey[key];
    if (rec && typeof rec === 'object' && rec.role != null && !String(key).match(/^(group|private):/)) {
      issues.push({ key, problem: 'bad-key-format' });
    }
  }
  if (!groupEnabled) {
    const groupsWithRole = conversations
      .filter((c) => String(c?.key || '').startsWith('group:'))
      .filter((c) => rolesByKey[String(c.key)]?.role != null);
    if (groupsWithRole.length) {
      // 不是错：单独给某个群设了角色；但值得在页面上标出来
      issues.push({ key: '*', problem: 'group-role-without-group-default', count: groupsWithRole.length });
    }
  }
  return issues;
}
