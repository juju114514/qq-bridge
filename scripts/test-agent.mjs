// agent 的 provider / loop / tools（0.5.46 · C1+C2）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const providerMod = await import(new URL('../src/agent/provider.js', import.meta.url).href);
const loopMod = await import(new URL('../src/agent/loop.js', import.meta.url).href);
const toolsMod = await import(new URL('../src/agent/tools.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

/** 假 provider：按脚本依次返回 */
const scripted = (steps) => {
  let i = 0;
  return {
    calls: [],
    async textChat(req) {
      this.calls.push(req);
      const s = steps[Math.min(i, steps.length - 1)];
      i += 1;
      return typeof s === 'function' ? s(req) : s;
    }
  };
};

await check('provider：没 apiKey 直接抛（不发出无凭据请求）', () => {
  assert.throws(() => providerMod.createProvider({ apiKey: '' }), /apiKey/);
});

await check('provider：请求体与鉴权头正确', async () => {
  let seen = null;
  const p = providerMod.createProvider({
    apiKey: 'k-123',
    model: 'm-1',
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) };
    }
  });
  const r = await p.textChat({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 't' } }] });
  assert.match(seen.url, /\/chat\/completions$/);
  assert.equal(seen.init.headers.authorization, 'Bearer k-123');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, 'm-1');
  assert.equal(body.tools.length, 1);
  assert.equal(r.content, 'hi');
});

await check('provider：HTTP 非 2xx 把服务端原文带出来', async () => {
  const p = providerMod.createProvider({
    apiKey: 'k',
    fetchImpl: async () => ({ ok: false, status: 402, text: async () => '余额不足' })
  });
  await assert.rejects(() => p.textChat({ messages: [{ role: 'user', content: 'x' }] }), /402.*余额不足/s);
});

await check('loop：无工具调用 → 一轮就返回', async () => {
  const prov = scripted([{ content: '答案', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' }]);
  const loop = loopMod.createAgentLoop({ provider: prov, maxSteps: 3 });
  const r = await loop.run({ userText: '问' });
  assert.equal(r.reply, '答案');
  assert.equal(r.steps, 1);
  assert.equal(prov.calls.length, 1);
});

await check('loop：模型要工具 → 执行并把结果回填成 tool 消息', async () => {
  const calls = [];
  const prov = scripted([
    { content: '', toolCalls: [{ id: 'c1', function: { name: 'echo', arguments: '{"v":"你好"}' } }], usage: null, finishReason: 'tool_calls' },
    { content: '收到你好', toolCalls: [], usage: null, finishReason: 'stop' }
  ]);
  const loop = loopMod.createAgentLoop({
    provider: prov, maxSteps: 3,
    tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object', properties: { v: { type: 'string' } } }, run: async (a) => { calls.push(a); return { ok: true, echo: a.v }; } }]
  });
  const r = await loop.run({ userText: '试' });
  assert.equal(r.reply, '收到你好');
  assert.equal(r.steps, 2);
  assert.deepEqual(calls, [{ v: '你好' }]);
  const toolMsg = prov.calls[1].messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, '没回填 tool 消息');
  assert.match(toolMsg.content, /你好/);
});

await check('loop：模型一直要工具 → 到步数上限就停，不无限烧', async () => {
  const prov = {
    async textChat() {
      return { content: '', toolCalls: [{ id: 'x', function: { name: 'noop', arguments: '{}' } }], usage: null, finishReason: 'tool_calls' };
    }
  };
  const loop = loopMod.createAgentLoop({ provider: prov, maxSteps: 2, tools: [{ name: 'noop', description: '', parameters: {}, run: async () => ({ ok: true }) }] });
  const r = await loop.run({ userText: 'x' });
  assert.equal(r.steps, 2);
  assert.equal(r.error, 'max-steps');
  assert.match(r.reply, /圈/);
});

await check('loop：模型调用失败 → 返回人话，不抛', async () => {
  const prov = { async textChat() { throw new Error('ECONNREFUSED'); } };
  const loop = loopMod.createAgentLoop({ provider: prov });
  const r = await loop.run({ userText: 'x' });
  assert.match(r.reply, /模型没连上/);
  assert.match(r.error, /ECONNREFUSED/);
});

await check('loop：工具不存在 → 回填错误而不是崩', async () => {
  const prov = scripted([
    { content: '', toolCalls: [{ id: 'c', function: { name: 'ghost', arguments: '{}' } }], usage: null, finishReason: 'tool_calls' },
    { content: '好的', toolCalls: [], usage: null, finishReason: 'stop' }
  ]);
  const loop = loopMod.createAgentLoop({ provider: prov, tools: [] });
  const r = await loop.run({ userText: 'x' });
  assert.equal(r.reply, '好的');
  assert.equal(r.toolRuns[0].ok, false);
});

await check('tools：qq_send_message 走注入的发送通道', async () => {
  const sent = [];
  const tools = toolsMod.createSocialTools({ stateDir: os.tmpdir(), sendToQQ: async (k, t) => sent.push([k, t]) });
  const send = tools.find((t) => t.name === 'qq_send_message');
  const r = await send.run({ key: 'group:123', text: '测试' });
  assert.equal(r.ok, true);
  assert.deepEqual(sent, [['group:123', '测试']]);
});

await check('tools：非法 key 被拒（正则白名单）', async () => {
  const tools = toolsMod.createSocialTools({ stateDir: os.tmpdir(), sendToQQ: async () => {} });
  const send = tools.find((t) => t.name === 'qq_send_message');
  const r = await send.run({ key: '../../etc/passwd', text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /key 格式不对/);
});

await check('tools：qq_get_context 读 state/social-v2.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-agent-'));
  fs.writeFileSync(path.join(dir, 'social-v2.json'), JSON.stringify({
    conversations: {
      'group:123': {
        lastWakeReason: 'atMention',
        recentMessages: [{ seq: 1, sender: '甲', text: '在吗' }, { seq: 2, sender: '乙', text: '在' }],
        unread: [{ seq: 3, sender: '丙', text: '来玩' }]
      }
    }
  }));
  const tools = toolsMod.createSocialTools({ stateDir: dir });
  const get = tools.find((t) => t.name === 'qq_get_context');
  const r = await get.run({ key: 'group:123' });
  assert.equal(r.ok, true);
  assert.equal(r.recent.length, 2);
  assert.equal(r.unread.length, 1);
  assert.equal(r.wakeReason, 'atMention');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('tools：状态文件坏了也不崩', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-agent-'));
  fs.writeFileSync(path.join(dir, 'social-v2.json'), '{坏 JSON');
  const tools = toolsMod.createSocialTools({ stateDir: dir });
  const get = tools.find((t) => t.name === 'qq_get_context');
  const r = await get.run({ key: 'group:123' });
  assert.equal(r.ok, true);
  assert.equal(r.found, false);
  fs.rmSync(dir, { recursive: true, force: true });
});


await check('loop：doneWhen 命中就收尾（发过消息不再追问）', async () => {
  const prov = scripted([
    { content: '', toolCalls: [{ id: 'c', function: { name: 'send', arguments: '{}' } }], usage: null, finishReason: 'tool_calls' },
    { content: '不该走到这里', toolCalls: [], usage: null, finishReason: 'stop' }
  ]);
  let sent = false;
  const loop = loopMod.createAgentLoop({
    provider: prov, maxSteps: 4,
    tools: [{ name: 'send', description: '', parameters: {}, run: async () => { sent = true; return { ok: true }; } }],
    doneWhen: () => sent
  });
  const r = await loop.run({ userText: 'x' });
  assert.equal(r.steps, 1);
  assert.equal(r.doneEarly, true);
  assert.equal(r.reply, '');
});

await check('tools：defaultKey 覆盖模型自填的 key（只能发当前会话）', async () => {
  const sent = [];
  const tools = toolsMod.createSocialTools({ stateDir: os.tmpdir(), sendToQQ: async (k, t) => sent.push([k, t]), defaultKey: 'private:111' });
  const send = tools.find((t) => t.name === 'qq_send_message');
  await send.run({ key: 'group:999', text: 'hi' });
  assert.deepEqual(sent, [['private:111', 'hi']]);
});


const personaMod = await import(new URL('../src/agent/persona.js', import.meta.url).href);

await check('persona：config 里直接写的一句话优先', () => {
  const r = personaMod.resolvePersona({ agent: { persona: '我是小鲸鱼' } });
  assert.equal(r.text, '我是小鲸鱼');
  assert.equal(r.source, 'agent.persona');
});

await check('persona：personaFile 能读到文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-persona-'));
  const f = path.join(dir, 'p.md');
  fs.writeFileSync(f, '# 人设\n说话简短。');
  const r = personaMod.resolvePersona({ agent: { personaFile: f } });
  assert.match(r.text, /说话简短/);
  assert.match(r.source, /personaFile/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('persona：文件不存在 → 退回默认，不崩', () => {
  const r = personaMod.resolvePersona({ agent: { personaFile: '/no/such/file.md' } });
  assert.equal(r.source, 'default');
  assert.ok(r.text.length > 5);
});

await check('persona：超长会被截断（别把上下文吃光）', () => {
  const long = 'x'.repeat(5000);
  const r = personaMod.resolvePersona({ agent: { persona: long } }, { maxChars: 100 });
  assert.equal(r.text.length, 101);   // 100 + '…'
});

await check('composeSystemPrompt：人格在前、key 居中、约束在后', () => {
  const s = personaMod.composeSystemPrompt({ persona: 'P', keyLine: 'K', base: 'B' });
  assert.equal(s, 'P\n\nK\n\nB');
});


const secretMod = await import(new URL('../src/secret-box.js', import.meta.url).href);

await check('secret-box：protect/unprotect 往返（非 Windows 走本地 AES）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-sec-'));
  const box = secretMod.createSecretBox({ platform: 'linux', keyFile: path.join(dir, 'secret.key') });
  const enc = box.protect('sk-test-123456');
  assert.match(enc, /^local:/);
  assert.equal(box.unprotect(enc), 'sk-test-123456');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('secret-box：解不开返回空串，不抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-sec-'));
  const box = secretMod.createSecretBox({ platform: 'linux', keyFile: path.join(dir, 'secret.key') });
  assert.equal(box.unprotect('local:bm90LWEtcmVhbC1ibG9i'), '');
  assert.equal(box.unprotect(''), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('secret-box：没前缀的旧明文照常返回（平滑迁移）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-sec-'));
  const box = secretMod.createSecretBox({ platform: 'linux', keyFile: path.join(dir, 'secret.key') });
  assert.equal(box.unprotect('sk-plain'), 'sk-plain');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('resolveApiKey：密文优先于明文，明文优先于环境变量', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-sec-'));
  const box = secretMod.createSecretBox({ platform: 'linux', keyFile: path.join(dir, 'secret.key') });
  const enc = box.protect('sk-from-cipher');
  assert.equal(secretMod.resolveApiKey({ apiKeyEnc: enc, apiKey: 'sk-plain' }, { box }), 'sk-from-cipher');
  assert.equal(secretMod.resolveApiKey({ apiKey: 'sk-plain' }, { box, env: { DEEPSEEK_API_KEY: 'sk-env' } }), 'sk-plain');
  assert.equal(secretMod.resolveApiKey({}, { box, env: { DEEPSEEK_API_KEY: 'sk-env' } }), 'sk-env');
  fs.rmSync(dir, { recursive: true, force: true });
});


await check('provider：503 busy 会重试，重试后成功则正常返回', async () => {
  let calls = 0;
  const p = providerMod.createProvider({
    apiKey: 'k',
    fetchImpl: async () => {
      calls += 1;
      if (calls < 2) return { ok: false, status: 503, text: async () => 'Service is too busy.' };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '好了' }, finish_reason: 'stop' }], usage: null }) };
    }
  });
  const r = await p.textChat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.content, '好了');
  assert.equal(calls, 2);
});

await check('provider：连续 503 重试用尽后抛 MODEL_BUSY（人话）', async () => {
  let calls = 0;
  const p = providerMod.createProvider({
    apiKey: 'k',
    fetchImpl: async () => { calls += 1; return { ok: false, status: 503, text: async () => 'Service is too busy.' }; }
  });
  await assert.rejects(() => p.textChat({ messages: [{ role: 'user', content: 'x' }] }), (e) => {
    assert.equal(e.code, 'MODEL_BUSY');
    assert.match(e.message, /正忙/);
    return true;
  });
  assert.ok(calls >= 2, `应该重试过，实际 ${calls} 次`);
});

await check('provider：401 不重试（配置错，重试没意义）', async () => {
  let calls = 0;
  const p = providerMod.createProvider({
    apiKey: 'k',
    fetchImpl: async () => { calls += 1; return { ok: false, status: 401, text: async () => 'unauthorized' }; }
  });
  await assert.rejects(() => p.textChat({ messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(calls, 1);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
