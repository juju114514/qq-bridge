// /reset 的清理清单（src/session-reset.js）：**每个集合都必须被清**。
//
// 这个模块存在的唯一理由就是"别漏删"。漏删不报错，只会让内存慢慢涨、
// 旧上下文串进新会话 —— 所以测试的重点是逐项核对，而不是"跑通不抛异常"。

import assert from 'node:assert/strict';

const { createSessionResetter } = await import(new URL('../src/session-reset.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const KEY = 'private:10001';
const SID = 'session-abc';

function makeWorld() {
  const reg = {
    epoch: 0,
    cleared: [],
    bumpEpoch() { this.epoch += 1; },
    clearSession(sid) { this.cleared.push(sid); }
  };
  const m = () => new Map();
  const collections = {
    sessionRegistry: reg,
    state: { sessions: { [KEY]: SID }, sessionPolicies: { [KEY]: 'p' } },
    social: { silentTurns: new Set([SID]), exitingSessions: new Set([SID]), recentMessages: m(), pendingSummaries: m(), states: m(), silentContext: m() },
    socialV2: { conversations: m() },
    pending: m(), queued: m(), queuedHintAt: m(), sessionPromises: m(),
    messageMediaStore: m(), slangWindows: m(), slangExtractionCooldowns: m(), slangSubmitTimes: m(),
    pendingWakeKeys: new Set(), wakeConfigUpdatedKeys: new Set(), markReadCalledKeys: new Set(), wakeConfigMissCount: m(),
    seenForwardIds: m()
  };
  // 按"真实归属"填痕迹：
  //   · 会话级（sessionId）：social.silentTurns / exitingSessions / registry
  //   · 会话 key 级：其余全部（pendingWakeKeys / wakeConfigUpdatedKeys / markReadCalledKeys …）
  const SID_SETS = new Set(['silentTurns', 'exitingSessions']);
  for (const coll of [collections.social, collections.socialV2]) {
    for (const [sub, v] of Object.entries(coll)) {
      if (v instanceof Set) v.add(SID_SETS.has(sub) ? SID : KEY);
      else if (v?.set) v.set(KEY, 1);
    }
  }
  for (const [k, v] of Object.entries(collections)) {
    if (k === 'sessionRegistry' || k === 'state' || k === 'social' || k === 'socialV2') continue;
    if (v instanceof Set) v.add(KEY);
    else if (v?.set) v.set(KEY, 1);
  }
  // pending 里放一个"带定时器"的挂起项 —— 否则 clearTimeout 分支永远测不到
  collections.pending.set(KEY, { timer: 12345, kind: 'question' });
  const calls = [];
  const hooks = {
    clearTimeout: (t) => calls.push(['clearTimeout', t]),
    cancelPendingEntry: async (e) => calls.push(['cancelPendingEntry']),
    cancelSocialTimers: (k) => calls.push(['cancelSocialTimers', k]),
    clearSocialV2Timers: (k) => calls.push(['clearSocialV2Timers', k]),
    drainPromptQueue: (k, why) => calls.push(['drainPromptQueue', k, why]),
    forgetAgentToken: (k) => calls.push(['forgetAgentToken', k]),
    persistQueueSoon: () => calls.push(['persistQueueSoon']),
    saveSocialV2State: () => calls.push(['saveSocialV2State']),
    saveState: () => calls.push(['saveState']),
    stopSessionWork: async (sid) => calls.push(['stopSessionWork', sid]),
    archiveSession: async (sid) => calls.push(['archiveSession', sid])
  };
  return { collections, hooks, calls, reg };
}

await check('没有会话时直接返回 no-session（不做任何清理）', async () => {
  const { collections, hooks } = makeWorld();
  const r = createSessionResetter({ collections, hooks });
  const out = await r.resetConversation('private:99999');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-session');
});

await check('全部集合被清空 + epoch 递增 + 依次通知 DSH', async () => {
  const { collections, hooks, calls, reg } = makeWorld();
  const r = createSessionResetter({ collections, hooks });
  const out = await r.resetConversation(KEY);
  assert.equal(out.ok, true);
  assert.equal(out.sessionId, SID);

  assert.equal(reg.cleared.length, 1, 'registry.clearSession 必须被调用');
  assert.ok(reg.epoch >= 1, 'epoch 必须递增（防止旧异步流程复活）');
  assert.equal(collections.state.sessions[KEY], undefined);
  assert.equal(collections.state.sessionPolicies[KEY], undefined);

  // social / socialV2 是对象（里面装着 Set/Map），要展开再查
  const flat = [];
  for (const [name, coll] of Object.entries(collections)) {
    if (['sessionRegistry', 'state'].includes(name)) continue;
    if (coll instanceof Set || coll instanceof Map) flat.push([name, coll]);
    else if (coll && typeof coll === 'object') {
      for (const [sub, inner] of Object.entries(coll)) {
        if (inner instanceof Set || inner instanceof Map) flat.push([`${name}.${sub}`, inner]);
      }
    }
  }
  for (const [name, coll] of flat) {
    const keys = coll instanceof Set ? [...coll] : [...coll.keys()];
    const leftover = keys.filter((k) => k === KEY || k === SID);
    assert.equal(leftover.length, 0, `${name} 还有残留：${leftover.join(',')}`);
  }

  const names = calls.map((c) => c[0]);
  for (const fn of ['clearTimeout', 'cancelPendingEntry', 'cancelSocialTimers', 'clearSocialV2Timers',
    'drainPromptQueue', 'forgetAgentToken', 'persistQueueSoon', 'saveSocialV2State', 'saveState',
    'stopSessionWork', 'archiveSession']) {
    assert.ok(names.includes(fn), `副作用钩子 ${fn} 没被调用`);
  }
  // 顺序：先停工作再归档
  assert.ok(names.indexOf('stopSessionWork') < names.indexOf('archiveSession'));
});

await check('钩子抛错不影响整体清理（fail-soft）', async () => {
  const { collections } = makeWorld();
  const hooks = {
    cancelSocialTimers: () => { throw new Error('boom'); },
    stopSessionWork: async () => { throw new Error('dsh down'); }
  };
  const r = createSessionResetter({ collections, hooks });
  const out = await r.resetConversation(KEY);
  assert.equal(out.ok, true, '钩子失败也要完成清理并返回 ok');
  assert.equal(collections.state.sessions[KEY], undefined);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }