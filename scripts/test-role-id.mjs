// 角色卡「id 在文件里」的回归测试（2026-10-27 改造）。
//
// 背景：身份曾经等于文件名，于是「带全角括号 / 改名 / 丢后缀 / 搬机器」会让
// `/role`、会话绑定、控制台一起失效 —— 同一类 bug 连踩三次。改造后：
//
//   roles/<任意文件名>.md
//     ---
//     id: xiaojingyu      ← 身份，state 只存它
//     name: 小鲸鱼（已测试）  ← 显示名，随便改
//     ---
//
// 这套测试钉住四件事：
//   1. front matter 解析/生成正确（含引号、缺键、无元数据、BOM）
//   2. id 与文件名解耦：改文件名不影响 id
//   3. 老文件（无元数据）得到确定性 id，不会因为跑一次就变
//   4. 仓库自带的卡片都加了元数据，且 id 唯一、ASCII

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRoleFrontMatter, hashRoleId, parseRoleFrontMatter, slugifyRoleId,
} from '../src/role-card.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const rolesDir = path.join(root, 'roles');

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

// ── 1. front matter 解析 ───────────────────────────────────────────────────
check('解析 id/name 并把正文剥出来', () => {
  const text = '---\nid: xiaojingyu\nname: 小鲸鱼（已测试）\n---\n\n# 角色卡\n正文';
  const meta = parseRoleFrontMatter(text);
  assert.equal(meta.id, 'xiaojingyu');
  assert.equal(meta.name, '小鲸鱼（已测试）');
  assert.equal(meta.hasMeta, true);
  assert.equal(meta.body, '# 角色卡\n正文', '正文应去掉 front matter 与前导空行');
});

check('没有 front matter 时整篇都是正文', () => {
  const meta = parseRoleFrontMatter('# 角色卡\n正文');
  assert.equal(meta.hasMeta, false);
  assert.equal(meta.id, null);
  assert.equal(meta.body, '# 角色卡\n正文');
});

check('容忍 BOM、引号包裹、缺 name、未闭合', () => {
  const withBom = parseRoleFrontMatter('\uFEFF---\nid: a\nname: "有 空格"\n---\nbody');
  assert.equal(withBom.id, 'a');
  assert.equal(withBom.name, '有 空格');

  const noName = parseRoleFrontMatter('---\nid: b\n---\nbody');
  assert.equal(noName.id, 'b');
  assert.equal(noName.name, null);

  const unclosed = parseRoleFrontMatter('---\nid: c\nbody');
  assert.equal(unclosed.hasMeta, false, '未闭合的 front matter 应视为无元数据（不吞正文）');
  assert.match(unclosed.body, /id: c/);
});

check('生成 front matter 时清掉换行（否则会写出坏文件）', () => {
  const head = buildRoleFrontMatter({ id: 'x', name: 'a\nb' });
  assert.equal(head, '---\nid: x\nname: a b\n---\n');
  assert.throws(() => buildRoleFrontMatter({ id: '' }), /缺 id/);
});

// ── 2. id 生成 ─────────────────────────────────────────────────────────────
check('ASCII 名字压成可读 slug，中文回退哈希', () => {
  assert.equal(slugifyRoleId('Tsundere Helper'), 'tsundere-helper');
  assert.equal(slugifyRoleId('小鲸鱼（已测试）'), null, '纯中文压不出 slug');
  assert.match(slugifyRoleId('3p'), /^r-/, '数字开头要加前缀');
  const h1 = hashRoleId('小鲸鱼（已测试）');
  const h2 = hashRoleId('小鲸鱼（已测试）');
  assert.equal(h1, h2, '同一文件名必须得到同一个 id');
  assert.match(h1, /^r-[a-z0-9]+$/);
  assert.notEqual(h1, hashRoleId('派蒙（无测试）'));
});

// ── 3. 关键性质：改文件名不影响 id ────────────────────────────────────────
check('改名/搬文件后 id 不变（这正是改造的目的）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-role-'));
  try {
    const text = buildRoleFrontMatter({ id: 'xiaojingyu', name: '小鲸鱼' }) + '\n# 卡\n正文';
    const a = path.join(dir, '随便什么名字.md');
    fs.writeFileSync(a, text, 'utf8');
    const before = parseRoleFrontMatter(fs.readFileSync(a, 'utf8'));
    // 模拟"改个名字/换个机器重新拷"：文件名完全变了
    const b = path.join(dir, 'renamed-any.md');
    fs.renameSync(a, b);
    const after = parseRoleFrontMatter(fs.readFileSync(b, 'utf8'));
    assert.equal(after.id, before.id, 'id 应存在文件里，不随文件名变化');
    assert.equal(after.name, '小鲸鱼');
    assert.equal(after.body, before.body);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. 仓库自带的卡片 ──────────────────────────────────────────────────────
check('仓库里每张卡都有 front matter，id 唯一且 ASCII', () => {
  const files = fs.readdirSync(rolesDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'ATTRIBUTION.md');
  assert.ok(files.length >= 4, `角色卡太少：${files.join(', ')}`);
  const ids = new Set();
  for (const file of files) {
    const text = fs.readFileSync(path.join(rolesDir, file), 'utf8');
    const meta = parseRoleFrontMatter(text);
    assert.equal(meta.hasMeta, true, `${file} 缺 front matter —— 跑 scripts/migrate-roles-to-ids.mjs`);
    assert.ok(meta.id, `${file} 缺 id`);
    assert.match(meta.id, /^[a-z][a-z0-9-]*$/, `${file} 的 id 必须是 ASCII 小写：${meta.id}`);
    assert.ok(meta.name, `${file} 缺 name`);
    assert.ok(!ids.has(meta.id), `id 冲突：${meta.id}（${file}）`);
    ids.add(meta.id);
  }
});

check('注入前的正文不含 front matter（否则会占预算、还可能被念出来）', () => {
  const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /parseRoleFrontMatter\(fs\.readFileSync\(roleFile, 'utf8'\)\)\.body/,
    '注入路径必须剥掉 front matter');
  // 注入路径不能再靠"拼文件名"，否则 id 化就没意义了
  assert.doesNotMatch(bridge, /const roleFile = path\.join\(ROLES_DIR, safeName \+ '\.md'\)/,
    '注入路径仍在拼文件名（应改为用索引里的 entry.file）');
});

check('state 里存的是 id，不是文件名', () => {
  const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  // roleEntry 必须能容错解析旧显示名（迁移前后都能跑）
  assert.match(bridge, /function roleEntry\(id\)[\s\S]{0,400}resolveRoleName\(key\)/,
    'roleEntry 应对旧显示名做一次容错解析');
  // 改名只改 front matter，不 rename 文件
  assert.match(bridge, /function renameRoleCard[\s\S]{0,600}buildRoleFrontMatter/,
    'renameRoleCard 应只重写 front matter');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}

check('POST /api/role 走解析器，且写入 state 的是 id（回归：控制台切人格曾经全废）', () => {
  // 实测过的 bug：该接口还在用 `sanitizeRoleName(body.role)` + 拼 `roles/<name>.md`。
  // 现有 4 张卡的名字全带全角括号，sanitize 会洗成 `小鲸鱼已测试` → 必然 400；
  // 就算碰巧命中，写进 state 的也是洗过的名字，注入时解析不到 → 人格静默失效。
  const rolesJs = fs.readFileSync(path.join(root, 'src', 'api', 'roles.js'), 'utf8');
  assert.match(rolesJs, /resolveExistingRole\(body\.role\)/, 'POST /api/role 必须用 resolveExistingRole 解析');
  assert.doesNotMatch(rolesJs, /sanitizeRoleName\(body\.role\)/, '不能再用 sanitizeRoleName 洗角色名');
  assert.match(rolesJs, /writeRoleState\(id, rs\.mode\)/, '写 state 的必须是 id');
});
