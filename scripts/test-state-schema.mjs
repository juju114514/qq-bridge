// state/ schema 迁移（src/state-schema.js）的契约测试：全离线，用临时目录。
//
// 这条东西的价值全在"别把老数据搞坏"，所以测的是：备份存在、版本号推进、幂等、
// 降级不猜、失败不写版本。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const m = await import(new URL('../src/state-schema.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `qqb-schema-${tag}-`));

check('全新 state：直接写版本号，不产生备份目录', () => {
  const dir = tmp('fresh');
  const r = m.ensureStateSchema({ stateDir: dir, now: new Date('2026-10-29T00:00:00Z') });
  assert.equal(r.migrated, true);
  assert.equal(m.readSchemaVersion(dir), m.SCHEMA_VERSION);
  assert.ok(!fs.existsSync(path.join(dir, 'backups')), '空 state 不该备份');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('老 state：先备份再迁移，版本推进到当前', () => {
  const dir = tmp('old');
  fs.writeFileSync(path.join(dir, 'social-v2.json'), JSON.stringify({ conversations: { 'group:1': { recentMessages: [] } } }));
  const r = m.ensureStateSchema({ stateDir: dir });
  assert.equal(r.migrated, true);
  assert.equal(r.from, 1, '无版本号视为 v1');
  assert.ok(r.backup && fs.existsSync(r.backup), '必须留下备份');
  assert.ok(fs.existsSync(path.join(r.backup, 'social-v2.json')), '备份里要有原文件');
  assert.equal(m.readSchemaVersion(dir), m.SCHEMA_VERSION);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('v2 迁移：给已有会话补 longTermMemories: []（不改其它字段）', () => {
  const dir = tmp('v2');
  fs.writeFileSync(path.join(dir, 'social-v2.json'), JSON.stringify({
    conversations: { 'group:1': { recentMessages: [{ text: 'hi' }] }, 'group:2': { longTermMemories: ['keep'] } }
  }));
  m.ensureStateSchema({ stateDir: dir });
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'social-v2.json'), 'utf8'));
  assert.deepEqual(out.conversations['group:1'].longTermMemories, []);
  assert.deepEqual(out.conversations['group:2'].longTermMemories, ['keep'], '已有的不能被覆盖');
  assert.equal(out.conversations['group:1'].recentMessages[0].text, 'hi');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('幂等：连跑两次，第二次不再迁移、不再备份', () => {
  const dir = tmp('idem');
  fs.writeFileSync(path.join(dir, 'a.json'), '{}');
  m.ensureStateSchema({ stateDir: dir });
  const backups1 = fs.readdirSync(path.join(dir, 'backups')).length;
  const r2 = m.ensureStateSchema({ stateDir: dir });
  assert.equal(r2.migrated, false);
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, backups1, '第二次不该新增备份');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('降级保护：版本比程序新时只告警、不动文件', () => {
  const dir = tmp('future');
  fs.writeFileSync(path.join(dir, 'a.json'), '{"x":1}');
  m.writeSchemaVersion(dir, m.SCHEMA_VERSION + 5);
  const before = fs.readFileSync(path.join(dir, 'a.json'), 'utf8');
  const r = m.ensureStateSchema({ stateDir: dir });
  assert.equal(r.migrated, false);
  assert.match(r.warning, /比程序支持/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), before, '文件不能被改');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('迁移失败：不写版本号（下次还会重试），备份已在', () => {
  const dir = tmp('fail');
  fs.writeFileSync(path.join(dir, 'a.json'), '{}');
  const saved = m.MIGRATIONS[m.SCHEMA_VERSION];
  m.MIGRATIONS[m.SCHEMA_VERSION] = () => { throw new Error('boom'); };
  try {
    assert.throws(() => m.ensureStateSchema({ stateDir: dir }), /boom/);
    assert.equal(m.readSchemaVersion(dir), 0, '失败时版本号必须保持旧值');
    assert.ok(fs.existsSync(path.join(dir, 'backups')), '失败也要留备份');
  } finally {
    m.MIGRATIONS[m.SCHEMA_VERSION] = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('接线：bridge 启动时调用 ensureStateSchema；Docker 资产齐全', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /ensureStateSchema/, '启动必须做 schema 迁移');
  assert.ok(fs.existsSync(path.join(root, 'Dockerfile')), '要有 Dockerfile');
  assert.ok(fs.existsSync(path.join(root, 'docker-compose.yml')), '要有 compose');
  assert.ok(fs.existsSync(path.join(root, '.dockerignore')), '要有 .dockerignore');
  const docker = read('Dockerfile');
  assert.match(docker, /HEALTHCHECK/, '要有健康检查');
  assert.match(docker, /node:22/, 'Node 版本要满足 >=22.13');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
