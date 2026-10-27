/**
 * 角色卡 id 化改造（2026-10-27）。
 *
 * 现状：`roles/<名字>.md`，文件名兼任身份。于是「名字带全角括号 / 改个名 / 丢个后缀」
 * 就会让 `/role`、会话绑定、控制台全部失效（同一类 bug 已经踩过三次）。
 *
 * 改造后：身份在文件里。
 *   roles/<任意文件名>.md
 *     ---
 *     id: xiaojingyu
 *     name: 小鲸鱼（已测试）
 *     ---
 *     # 角色卡…
 *
 * 本脚本做两件事（幂等，可重复跑）：
 *   1. 给还没有 front matter 的角色卡补上 `id` / `name`
 *   2. 把 state 里以「旧名字」记录的人格绑定改写成 id
 *        · state/role-state.json   { role: '小鲸鱼（已测试）' }  → { role: 'xiaojingyu' }
 *        · state/roles-by-key.json { 'group:123': '派蒙（无测试）' } → { 'group:123': 'paimon' }
 *
 * 用法：
 *   node scripts/migrate-roles-to-ids.mjs --dry-run      # 只看会改什么
 *   node scripts/migrate-roles-to-ids.mjs --apply        # 真写
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoleFrontMatter, hashRoleId, parseRoleFrontMatter, slugifyRoleId } from '../src/role-card.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROLES_DIR = path.join(ROOT, 'roles');
const STATE_DIR = path.join(ROOT, 'state');
const dryRun = !process.argv.includes('--apply');

// 已知卡片给可读 id（中文名压不出 ASCII slug，靠这张表补；不在表里的用 r-<hash>）
const KNOWN_IDS = new Map([
  ['小鲸鱼（已测试）', 'xiaojingyu'],
  ['派蒙（无测试）', 'paimon'],
  ['樱羽艾玛（无测试）', 'emma'],
  ['傲娇助手（无测试）', 'tsundere'],
]);

const NON_CARD = new Set(['README.md', 'ATTRIBUTION.md']);
const log = (s) => console.log(dryRun ? `  [dry] ${s}` : `  ${s}`);

function listCardFiles() {
  return fs.readdirSync(ROLES_DIR)
    .filter((f) => f.endsWith('.md') && !NON_CARD.has(f) && !f.startsWith('.') && !f.startsWith('_'))
    .sort();
}

function uniqueId(base, used) {
  let id = base;
  let n = 2;
  while (used.has(id)) { id = `${base}-${n}`; n += 1; }
  used.add(id);
  return id;
}

// ── 1. 补 front matter ─────────────────────────────────────────────────────
const used = new Set();
const byLegacyName = new Map(); // 旧名字（文件名） → id
const cards = [];

for (const file of listCardFiles()) {
  const full = path.join(ROLES_DIR, file);
  const raw = fs.readFileSync(full, 'utf8');
  const meta = parseRoleFrontMatter(raw);
  const stem = file.slice(0, -3);

  if (meta.hasMeta && meta.id) {
    used.add(meta.id);
    byLegacyName.set(stem, meta.id);
    cards.push({ file, id: meta.id, name: meta.name || stem, changed: false });
    continue;
  }

  // 没有元数据：按已知表 → slug → 哈希 的顺序生成 id
  const base = KNOWN_IDS.get(stem) || slugifyRoleId(stem) || hashRoleId(stem);
  const id = uniqueId(base, used);
  const name = stem;
  byLegacyName.set(stem, id);
  cards.push({ file, id, name, changed: true });

  if (dryRun) {
    log(`${file} → 补 front matter（id: ${id}, name: ${name}）`);
  } else {
    const body = raw.replace(/^\uFEFF/, '');
    fs.writeFileSync(full, buildRoleFrontMatter({ id, name }) + '\n' + body, 'utf8');
    log(`${file} → 已补 front matter（id: ${id}）`);
  }
}

// ── 2. state 里的旧名字 → id ───────────────────────────────────────────────
//
// 两个文件的形状不一样，实测确认过：
//   · state/current-role.json  { role: '小鲸鱼（已测试）', mode: 'active' }        ← 扁平
//   · state/roles-by-key.json  { 'group:123': { role: '…', mode: 'active' } }     ← 每键一个对象
// 所以这里必须分别处理，不能当字符串数组扫（第一版就写错过：只改扁平的那种，
// 每会话的绑定会悄悄留在旧名字上，表现为「切了角色但群里还是旧人格」）。
const mapName = (value) => (typeof value === 'string' && value ? byLegacyName.get(value) ?? value : value);

function rewriteCurrentRole(apply) {
  const full = path.join(STATE_DIR, 'current-role.json');
  if (!fs.existsSync(full)) return;
  let data;
  try { data = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { log('current-role.json 解析失败，跳过'); return; }
  const next = mapName(data.role);
  if (next === data.role) return;
  if (apply) fs.writeFileSync(full, JSON.stringify({ ...data, role: next }, null, 2) + '\n', 'utf8');
  log(`current-role.json → ${data.role} ⇒ ${next}`);
}

function rewriteRolesByKey(apply) {
  const full = path.join(STATE_DIR, 'roles-by-key.json');
  if (!fs.existsSync(full)) return;
  let data;
  try { data = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { log('roles-by-key.json 解析失败，跳过'); return; }
  let changed = 0;
  for (const key of Object.keys(data)) {
    const item = data[key];
    if (item && typeof item === 'object' && typeof item.role === 'string') {
      const next = mapName(item.role);
      if (next !== item.role) { item.role = next; changed += 1; }
    } else if (typeof item === 'string') {
      const next = mapName(item);
      if (next !== item) { data[key] = next; changed += 1; }
    }
  }
  if (!changed) return;
  if (apply) fs.writeFileSync(full, JSON.stringify(data, null, 2) + '\n', 'utf8');
  log(`roles-by-key.json → ${changed} 条会话绑定改写成 id`);
}

rewriteCurrentRole(!dryRun);
rewriteRolesByKey(!dryRun);

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log('');
console.log(`  角色卡 ${cards.length} 张，其中需要补元数据 ${cards.filter((c) => c.changed).length} 张`);
for (const c of cards) {
  console.log(`    ${c.id.padEnd(14)} ${c.name.padEnd(18)} ${c.file}`);
}
if (dryRun) {
  console.log('');
  console.log('  这是 dry-run。确认无误后加 --apply 真写。');
}
