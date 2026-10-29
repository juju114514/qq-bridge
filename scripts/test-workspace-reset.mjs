// 清空工作区（src/api/workspace-reset.js）：危险动作，重点验"清干净 + 不误伤"。
//
// 不跑真机（它会作废所有会话与 token），用假集合 + 假 DSH 验证：
//   ① 只归档 cwd 在本仓库 state/ 下的根会话（子代理会话不能碰）
//   ② 桥接自己的集合全部清空
//   ③ 统计数字对得上

import assert from 'node:assert/strict';
import path from 'node:path';

const { createWorkspaceResetHandler } = await import(new URL('../src/api/workspace-reset.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const STATE_DIR = path.resolve('D:/qqbridge-state');

function makeWorld(sessions = []) {
  const m = () => new Map();
  const calls = { stopped: [], archived: [], drained: [], saved: [] };
  const deps = {
    log: () => {}, fs: { writeFileSync: () => {} }, path, process,
    api: {
      sessions: { list: async () => ({ items: sessions }) },
      stopSessionWork: async (sid) => { calls.stopped.push(sid); },
      workspace: { archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); } }
    },
    withTimeout: async (p) => p,
    unwrap: (v) => v,
    DSH_CONTROL_TIMEOUT_MS: 1000,
    STATE_DIR,
    sessionRegistry: { bumped: 0, bumpEpoch() { this.bumped += 1; } },
    state: { sessions: { 'private:1': 's1' }, sessionPolicies: { 'private:1': 'p' } },
    social: { states: m(), recentMessages: m(), pendingSummaries: m(), silentContext: m(), silentTurns: new Set(['s1']), exitingSessions: new Set(['s1']) },
    socialV2: { conversations: m() },
    pending: m(), queued: m(), queuedHintAt: m(), sessionPromises: m(),
    messageMediaStore: m(), seenForwardIds: m(),
    slangWindows: m(), slangExtractionCooldowns: m(), slangSubmitTimes: m(),
    reverse: m(), collectors: m(), sendToolSucceededSessions: new Set(['s1']),
    pendingSendToolCalls: m(), v2TurnStartAt: m(), toolCallNames: m(),
    CONVERSATION_TOKENS: m(), KNOWN_AGENT_TOKENS: new Set(['t']),
    cancelPendingEntry: async () => {},
    drainAllPromptQueues: (why) => calls.drained.push(why),
    cancelAllSocialTimers: () => {},
    clearAllSocialV2Timers: () => {},
    saveSocialV2State: () => calls.saved.push('social'),
    saveState: () => calls.saved.push('state'),
    ACTIVITY_LOG: path.join(STATE_DIR, 'activity.log')
  };
  // 填点数据
  deps.pending.set('private:1', { timer: setTimeout(() => {}, 0), kind: 'question' });
  deps.queued.set('private:1', []);
  deps.social.recentMessages.set('private:1', []);
  return { deps, calls };
}

await check('只归档 state/ 下的根会话（子代理与外部 cwd 跳过）', async () => {
  const { deps, calls } = makeWorld([
    { sessionId: 's-root', cwd: path.join(STATE_DIR, 'agents') },
    { sessionId: 's-sub', cwd: path.join(STATE_DIR, 'agents'), origin: 'subagent' },
    { sessionId: 's-child', cwd: path.join(STATE_DIR, 'agents'), parentSessionId: 's-root' },
    { sessionId: 's-other', cwd: 'C:/somewhere/else' }
  ]);
  const h = createWorkspaceResetHandler(deps);
  const out = await h.resetAll({ sendJson: () => {} });
  assert.deepEqual(calls.stopped, ['s-root']);
  assert.deepEqual(calls.archived, ['s-root']);
  assert.equal(out.archivedCount, 1);
  assert.equal(out.stoppedCount, 1);
});

await check('桥接集合全部清空 + 落盘 + 活动日志', async () => {
  const { deps, calls } = makeWorld([]);
  const h = createWorkspaceResetHandler(deps);
  await h.resetAll({ sendJson: () => {} });
  assert.equal(deps.sessionRegistry.bumped, 1, '必须递增 epoch');
  assert.deepEqual(deps.state.sessions, {});
  assert.deepEqual(deps.state.sessionPolicies, {});
  assert.equal(deps.pending.size, 0);
  assert.equal(deps.queued.size, 0);
  assert.equal(deps.social.recentMessages.size, 0);
  assert.equal(deps.socialV2.conversations.size, 0);
  assert.equal(deps.CONVERSATION_TOKENS.size, 0);
  assert.equal(deps.KNOWN_AGENT_TOKENS.size, 0);
  assert.equal(deps.collectors.size, 0);
  assert.equal(deps.toolCallNames.size, 0);
  assert.ok(calls.drained.includes('工作区已清空'));
  assert.deepEqual(calls.saved, ['social', 'state']);
});

await check('DSH 列会话失败也不影响本地清空', async () => {
  const { deps } = makeWorld([]);
  deps.api.sessions.list = async () => { throw new Error('dsh down'); };
  const h = createWorkspaceResetHandler(deps);
  const out = await h.resetAll({ sendJson: () => {} });
  assert.equal(out.ok, true);
  assert.equal(deps.pending.size, 0, '本地仍要清干净');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }