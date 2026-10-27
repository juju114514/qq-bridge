// 「会话繁忙」这套东西的契约测试：诊断脚本 + status 快照 + 两道租约 + 文档。
//
// 为什么值得钉：这套逻辑的失败方式是**静默的**——回合卡住时桥接不报错、`dshReady` 还是 true、
// 群里就是不回话。用户只能靠日志里那行「会话繁忙，暂存唤醒原因」猜到，而它**大多数时候
// 是正常背压**。所以三件事必须一直成立：
//   1. 有办法拿事实（`diag-session-busy.mjs` + `/api/status.socialV2Busy`）
//   2. 有自愈（10 分钟告警 / 30 分钟强制解锁），且不能把自愈逻辑删掉
//   3. 有文档说明「什么时候正常、什么时候该动手」，且锚点能对上

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

// ── 1. 诊断脚本 ───────────────────────────────────────────────────────────
check('诊断脚本存在，且只用内置模块（不依赖 node_modules）', () => {
  const p = path.join(root, 'scripts/diag-session-busy.mjs');
  assert.ok(fs.existsSync(p), '缺 scripts/diag-session-busy.mjs');
  const text = fs.readFileSync(p, 'utf8');
  const imports = [...text.matchAll(/^import .*from '([^']+)'/gm)].map((m) => m[1]);
  for (const spec of imports) {
    assert.ok(spec.startsWith('node:'), `诊断脚本不该 import 第三方/项目模块：${spec}`);
  }
  assert.match(text, /socialV2Busy/, '必须读 /api/status 的 socialV2Busy');
  assert.match(text, /--key/, '应支持 --key 过滤');
});

check('诊断脚本能跑起来（--json 连不上时优雅退出，不抛栈）', () => {
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [path.join(root, 'scripts/diag-session-busy.mjs'), '--base', 'http://127.0.0.1:1'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    });
  } catch (error) {
    code = error.status ?? 1;
    out = String(error.stdout ?? '') + String(error.stderr ?? '');
  }
  assert.equal(code, 2, `连不上时应退出 2，实际 ${code}`);
  assert.match(out, /读不到|找不到 state\/console-token/, '应有可读的错误提示');
  assert.doesNotMatch(out, /\n\s+at /, '不该把异常栈丢给用户');
});

// ── 2. /api/status 的快照（只给操作端）───────────────────────────────────
check('/api/status 操作端返回 socialV2Busy，且 agent 视图里没有', () => {
  const status = read('src/api/status.js');
  assert.match(status, /socialV2Busy/, 'status.js 必须返回 socialV2Busy');
  const bridge = read('src/bridge.js');
  assert.match(bridge, /function socialV2BusySnapshot\(\)/, 'bridge 必须有 socialV2BusySnapshot');
  // status 的依赖构造函数（可能被提到 main() 顶部），断言「构造块里确实传了快照」
  const block = bridge.slice(bridge.indexOf('createStatusHandler({'), bridge.indexOf('createStatusHandler({') + 600);
  assert.match(block, /socialV2BusySnapshot/, 'createStatusHandler 必须注入 socialV2BusySnapshot');

  // agent 分支（x-agent-token / x-agent-call）里不能出现 socialV2Busy
  const agentStart = status.indexOf("if (req.headers['x-agent-token'] || req.headers['x-agent-call']");
  const agentEnd = status.indexOf('// 操作端：完整对象');
  assert.ok(agentStart >= 0 && agentEnd > agentStart, '找不到 agent 分支的边界');
  const agentBlock = status.slice(agentStart, agentEnd);
  assert.doesNotMatch(agentBlock, /socialV2Busy/, 'agent 视图不能看到别的会话的 busy 状态');
});

check('快照字段齐全（reason / 回合时长 / 上锁时长 / 租约剩余 / 暂存数）', () => {
  const bridge = read('src/bridge.js');
  for (const field of ['reason:', 'turnStartedAgoMs', 'armedAgoMs', 'leaseLeftMs', 'pendingWakeReasons']) {
    assert.ok(bridge.includes(field), `快照缺字段 ${field}`);
  }
});

// ── 3. 两道保险不能丢 ────────────────────────────────────────────────────
check('唤醒租约：10 分钟告警 + 30 分钟强制解除，都还在', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /PENDING_WAKE_WARN_MS\s*=\s*10 \* 60 \* 1000/, '缺 10 分钟告警常量');
  assert.match(bridge, /PENDING_WAKE_LEASE_MS\s*=\s*30 \* 60 \* 1000/, '缺 30 分钟租约常量');
  assert.match(bridge, /已「繁忙」10 分钟/, '缺 10 分钟 WARN 日志');
  assert.match(bridge, /按 30 分钟租约强制解除/, '缺 30 分钟强制解除日志');
  assert.match(bridge, /SESSION-BUSY\.md/, '告警里必须指向文档（否则用户无从下手）');
  // disarm 必须同时清掉告警定时器，否则会话恢复后还会收到一条假告警
  assert.match(bridge, /function disarmPendingWakeLease[\s\S]{0,400}pendingWakeWarnTimers/, 'disarm 必须清告警定时器');
});

check('回合租约仍在（不能因为"简化"被删掉）', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /TURN_BUSY_LEASE_MS/, '缺回合租约常量');
});

// ── 4. 文档与锚点 ────────────────────────────────────────────────────────
check('SESSION-BUSY.md 覆盖：机制 / 逐行日志 / 正常vs卡住 / 处置 / 根因', () => {
  const p = path.join(root, 'docs', 'guides', 'SESSION-BUSY.md');
  assert.ok(fs.existsSync(p), '缺 docs/guides/SESSION-BUSY.md');
  const doc = fs.readFileSync(p, 'utf8');
  for (const needle of ['正常背压', '逐行', '处置', '根因', 'diag-session-busy.mjs', '30 分钟', '10 分钟']) {
    assert.ok(doc.includes(needle), `SESSION-BUSY.md 缺「${needle}」`);
  }
});

check('TROUBLESHOOTING 有 E.8，且指向 SESSION-BUSY.md', () => {
  const ts = read('TROUBLESHOOTING.md');
  assert.match(ts, /### E\.8 日志反复「会话繁忙，暂存唤醒原因」/, '缺 E.8 条目');
  assert.match(ts, /diag-session-busy\.mjs/, 'E.8 必须给出诊断命令');
  assert.match(ts, /SESSION-BUSY\.md/, 'E.8 必须指向详细文档');
});

check('索引都能找到这篇（docs/README、FRESH-INSTALL、COMPAT、FOLDER_MAP）', () => {
  assert.match(read('docs/README.md'), /SESSION-BUSY\.md/, 'docs/README 未登记');
  assert.match(read('docs/guides/FRESH-INSTALL.md'), /SESSION-BUSY\.md/, 'FRESH-INSTALL 未登记');
  assert.match(read('COMPAT.md'), /diag-session-busy\.mjs/, 'COMPAT 自检表未登记');
  assert.match(read('docs/FOLDER_MAP.md'), /SESSION-BUSY/, 'FOLDER_MAP 未登记');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
