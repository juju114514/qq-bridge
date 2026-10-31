// P2-1（v0.4.49）：/api/socialV2/initial-prompt 必须对**有效** agent token 全方法拒绝。
//
// 旧测试的盲点（外部审查指出）：它用 'fixture-agent-token'，而这个令牌在
// prelude 第 139 行就被判为"无效"直接 403 —— 于是 POST 分支根本没被走到。
// 这里直接测 runPrelude：isLiveAgentToken 返回 true，模拟"真实存活"的智能体。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { runPrelude } from '../src/http/prelude.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const PORT = 3100;
const CONSOLE = 'fixture-console-token';
const LIVE_AGENT = 'live-agent-token';

function run({ method = 'GET', pathname, headers = {}, agentToken, isLive = () => true }) {
  // 写操作必须先过 CSRF 关（application/json）——否则命中的是 415 而不是权限关
  const base = { host: `127.0.0.1:${PORT}`, 'x-console-token': CONSOLE, 'content-type': 'application/json' };
  const req = { method, headers: { ...base, ...headers } };
  if (agentToken) {
    req.headers['x-agent-token'] = agentToken;
    req.headers['x-agent-call'] = '1';
  }
  return runPrelude({
    req,
    url: new URL(`http://127.0.0.1:${PORT}${pathname}`),
    boundPort: PORT,
    consoleToken: CONSOLE,
    crypto,
    isLiveAgentToken: isLive,
    isSocialV2Paused: () => false,
    isSocialV2Disabled: () => false,
    getMode: () => 'reserved2',
    slangStoreWritable: true,
    stickerStoreWritable: true,
  });
}

check('有效 agent token：POST initial-prompt → 403（这就是审查指出的漏洞）', () => {
  const r = run({ method: 'POST', pathname: '/api/socialV2/initial-prompt', agentToken: LIVE_AGENT });
  assert.equal(r?.status, 403, `应 403，实际 ${r?.status ?? '放行'}（放行=可被智能体改写初始提示词）`);
});

check('有效 agent token：DELETE initial-prompt → 403', () => {
  const r = run({ method: 'DELETE', pathname: '/api/socialV2/initial-prompt', agentToken: LIVE_AGENT });
  assert.equal(r?.status, 403);
});

check('有效 agent token：GET initial-prompt → 403（旧行为保留）', () => {
  const r = run({ method: 'GET', pathname: '/api/socialV2/initial-prompt', agentToken: LIVE_AGENT });
  assert.equal(r?.status, 403);
});

check('有效 agent token：其它 v2 写接口仍放行（不误伤智能体能力）', () => {
  const r = run({ method: 'POST', pathname: '/api/socialV2/send', agentToken: LIVE_AGENT });
  assert.equal(r, null, `不应被拦，实际 ${r?.status}`);
});

check('控制台令牌（无 agent 头）：POST initial-prompt 放行', () => {
  const r = run({ method: 'POST', pathname: '/api/socialV2/initial-prompt' });
  assert.equal(r, null, `管理员应可用，实际 ${r?.status}`);
});

check('无效 agent token 仍然 401/403（原有关卡不被削弱）', () => {
  const r = run({ method: 'POST', pathname: '/api/socialV2/send', agentToken: 'bogus', isLive: () => false });
  assert.equal(r?.status, 403);
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
