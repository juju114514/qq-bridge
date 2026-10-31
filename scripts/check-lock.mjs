#!/usr/bin/env node
// 仓库锁一致性守卫（LOCK.md）。
//
// 锁的语义（2026-10-31 定）：**只锁 git 仓库对外的口径，不锁本地运行。**
// 官方通道（QQ 官方机器人）代码已修完审计缺口，但没过真机 e2e ——
// 在通过之前，仓库不能声明它可用。
//
// 本脚本只做「口径一致性」检查，不改任何运行期行为：
//   1. LOCK.md 存在且写着 LOCKED
//   2. config.example.json 的 official.enabled 必须为 false
//   3. README 顶部必须有 🔒 锁横幅（指向 LOCK.md）
// 解锁时把 LOCK.md 改成「已解锁」，并同步改这两处，脚本自然通过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const lock = read('LOCK.md');
// 状态行同时可能写成「🔒 仓库口径上锁 / 🧪 EXPERIMENTAL」或「✅ 已解锁」，
// 只认第一处状态行，避免正文里提到「解锁」就误判。
const statusLine = (lock.split('\n').find((l) => l.includes('状态：')) ?? '');
const locked = statusLine.includes('🔒') && !statusLine.includes('已解锁');

check('LOCK.md 存在并声明状态', () => {
  assert.ok(/LOCKED|已解锁/.test(lock), 'LOCK.md 里必须写明 LOCKED 或 已解锁');
});

if (locked) {
  check('上锁期间：config.example.json 的 official.enabled 必须为 false', () => {
    const j = JSON.parse(read('config.example.json'));
    assert.equal(j?.official?.enabled, false, '上锁期间不能把它示例化成 true');
    assert.ok(String(j?.official?._locked ?? '').includes('LOCK.md'), '要有 _locked 字段说明原因');
  });

  check('上锁期间：README 顶部要有 🔒 横幅并指向 LOCK.md', () => {
    const head = read('README.md').split('## ')[0];
    assert.ok(head.includes('🔒'), 'README 顶部缺 🔒 横幅');
    assert.ok(head.includes('LOCK.md'), '横幅要指向 LOCK.md');
  });

  check('上锁期间：审计文档要记录缺口与状态', () => {
    const audit = read('docs/audits/official-channel-audit-2026-10-31.md');
    assert.ok(audit.includes('缺口'), '审计文档要列缺口');
  });
  check('上锁期间：要写明「调试与维修 + 预计时间」', () => {
    assert.ok(/调试与维修|调试\s*\+\s*维修|正在调试/.test(lock), 'LOCK.md 要说明正在调试/维修');
    assert.ok(/预计.*天|预计.*\d{4}-\d{2}-\d{2}/.test(lock), 'LOCK.md 要给预计完成时间');
    const head = read('README.md').split('## ')[0];
    assert.ok(/调试与维修|正在调试/.test(head), 'README 横幅要写正在调试');
    assert.ok(/预计/.test(head), 'README 横幅要给预计时间');
  });

  check('上锁期间：免责声明必须在位（README + LOCK.md）', () => {
    const head = read('README.md').split('## ')[0];
    assert.ok(/风险自负|不承担/.test(head), 'README 横幅要写明风险自负');
    assert.ok(/免责声明/.test(lock), 'LOCK.md 必须有免责声明一节');
    assert.ok(/AS IS|现状/.test(lock), '免责声明要提到 AS IS / 现状提供');
  });
} else {
  // 反向一致性：解锁后不能还留着锁横幅（否则读者会困惑到底锁没锁）
  check('已解锁：README 顶部不能再有 🔒 锁横幅', () => {
    const head = read('README.md').split('## ')[0];
    assert.ok(!head.includes('🔒'), '解锁后要清掉 README 的 🔒 横幅');
  });
  check('已解锁：config.example.json 的 official.enabled 可以放开', () => {
    const j = JSON.parse(read('config.example.json'));
    assert.ok(j?.official !== undefined, 'official 段应仍然存在');
  });
}

console.log(`\n结果：${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed ? 1 : 0);