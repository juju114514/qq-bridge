// 公开命令模块（src/incoming-commands.js）：命令识别 + 首次人设引导。
//
// 这些命令是"桥接直接回、不经过模型"的，一旦认错就会把普通聊天当成命令吞掉，
// 所以重点测两件事：① 该认的认 ② 不该认的别乱认。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createIncomingCommands } = await import(new URL('../src/incoming-commands.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-cmds-'));

function makeDeps({ isOwner = false, pending = null, roles = ['小鲸鱼（已测试）'] } = {}) {
  const sent = [];
  const roleState = { role: null, mode: 'active' };
  const setupFile = path.join(tmp, `role-setup-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(setupFile, JSON.stringify({ done: pending === null, pending }), 'utf8');
  const deps = {
    log: () => {},
    fs, path,
    getCfg: () => ({ role: { firstRunChoice: true, defaultName: '小鲸鱼' } }),
    sendToQQ: async (key, text) => { sent.push(text); },
    sendGuideTemplate: async (key, game) => ({ ok: true, found: false, game }),
    SLANG_FILE: path.join(tmp, 'slang.json'),
    STATE_DIR: tmp,
    listRoles: () => roles,
    roleName: (n) => n,
    resolveRoleName: (n) => (String(n).startsWith('小鲸鱼') ? '小鲸鱼（已测试）' : null),
    sanitizeRoleName: (n) => String(n).replace(/[\\/:*?"<>|]/g, '').slice(0, 20),
    validateRoleContent: (c) => c,
    writeRoleContent: () => {},
    writeRoleState: () => {},
    readRoleState: () => roleState,
    readRoleStateForKey: () => roleState,
    writeRoleStateForKey: () => {},
    readJsonSafe: (file, fallback) => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
    },
    atomicWriteJson: (file, obj) => fs.writeFileSync(file, JSON.stringify(obj), 'utf8')
  };
  return { deps, sent, state: { setupFile } };
}

await check('/指令 → 回能力清单并返回 true', async () => {
  const { deps, sent } = makeDeps();
  const h = createIncomingCommands(deps);
  const handled = await h.handlePublic({ key: 'private:1', kind: 'private', isOwner: false, plainContent: '/指令' });
  assert.equal(handled, true);
  assert.ok(sent.length >= 1, '应该回一条');
  assert.match(sent[0], /小鲸鱼 · 指令/);
});

await check('普通聊天 → 不拦截（返回 false）', async () => {
  const { deps, sent } = makeDeps();
  const h = createIncomingCommands(deps);
  const handled = await h.handlePublic({ key: 'group:2', kind: 'group', isOwner: false, plainContent: '今天好热' });
  assert.equal(handled, false);
  assert.equal(sent.length, 0, '不该发任何东西');
});

await check('/role（无参数）→ 列出角色卡', async () => {
  const { deps, sent } = makeDeps();
  const h = createIncomingCommands(deps);
  const handled = await h.handlePublic({ key: 'private:1', kind: 'private', isOwner: true, plainContent: '/role' });
  assert.equal(handled, true);
  assert.match(sent[0], /可用角色卡/);
});

await check('/梗 无结果 → 提示没听过（不抛错）', async () => {
  const { deps, sent } = makeDeps();
  const h = createIncomingCommands(deps);
  const handled = await h.handlePublic({ key: 'group:2', kind: 'group', isOwner: false, plainContent: '/梗 丝竹' });
  assert.equal(handled, true);
  assert.match(sent[0], /没听过/);
});

await check('首次使用（非管理员）→ 不弹人设菜单', async () => {
  const { deps, sent } = makeDeps({ isOwner: false, pending: 'choose' });
  const h = createIncomingCommands(deps);
  const handled = await h.handlePublic({ key: 'group:2', kind: 'group', isOwner: false, plainContent: '随便说一句' });
  assert.equal(handled, false, '群友的消息不该被首次引导吞掉');
  assert.equal(sent.length, 0);
});

fs.rmSync(tmp, { recursive: true, force: true });


// 命令写法兼容（真机事故：用户发「/自检」但严格相等没匹配上，落到模型手里）
const SELFCHECK_RE = /^[\/／]?(自检|selfcheck)$/i;
await check('自检命令接受 /自检 自检 ／自检（全角）', async () => {
  for (const s of ['/自检', '自检', '／自检', '/selfcheck', ' SELFCHECK ']) {
    assert.equal(SELFCHECK_RE.test(String(s).trim()), true, `${s} 应该被识别`);
  }
});
await check('自检命令不该吞掉正常聊天', async () => {
  for (const s of ['自检一下', '帮我自检下系统', '自检报告']) {
    assert.equal(SELFCHECK_RE.test(String(s).trim()), false, `${s} 不该被当成命令`);
  }
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }