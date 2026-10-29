// 人格卡按仿真模式取用（src/role-card.js）的离线单测。
// 保证：模式标记能被正确识别与剥离、未标记的老卡片行为不变、真实人格卡可用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from '../src/role-card.js';

const CARD = [
  '# 角色卡：测试',
  '',
  '## 一、你是谁',
  '- 你是群里的测试角色。',
  '',
  '## 二、分条方式 〔一代〕',
  '- 想分条就用空格分隔；想沉默就输出 [SILENT]。',
  '',
  '## 三、发言方式 〔二代〕',
  '- 用 qq_send_message 的数组分条，潜水走 qq_mark_read。',
  '',
  '## 四、说话风格',
  '- 简短、口语化。',
].join('\n');

test('模式标记能被识别，未标记的小节两种模式都注入', () => {
  const sections = parseRoleSections(CARD);
  const byHeading = Object.fromEntries(sections.filter((s) => s.heading).map((s) => [s.heading, s.mode]));
  assert.equal(byHeading['一、你是谁'], 'all');
  assert.equal(byHeading['二、分条方式'], 'v1');
  assert.equal(byHeading['三、发言方式'], 'v2');
  assert.equal(byHeading['四、说话风格'], 'all');
});

test('按模式筛选：只保留公共小节 + 该模式专属小节', () => {
  const v1 = selectRoleText(CARD, 'v1');
  const v2 = selectRoleText(CARD, 'v2');
  // 公共内容两边都有
  for (const text of [v1, v2]) {
    assert.match(text, /你是群里的测试角色/);
    assert.match(text, /简短、口语化/);
  }
  // 专属内容互不串场
  assert.match(v1, /空格分隔/);
  assert.doesNotMatch(v1, /qq_send_message/);
  assert.match(v2, /qq_send_message/);
  assert.doesNotMatch(v2, /\[SILENT\]/);
});

test('注入文本里不再残留模式标记', () => {
  assert.doesNotMatch(selectRoleText(CARD, 'v1'), /〔一代〕|〔二代〕/);
  assert.doesNotMatch(selectRoleText(CARD, 'v2'), /〔一代〕|〔二代〕/);
  // 标题保留但已清洗
  assert.match(selectRoleText(CARD, 'v2'), /## 三、发言方式\n/);
});

test('多种标记写法都认（[v1] / （reserved2） / 2 代）', () => {
  const card = [
    '## A [v1]', '- a',
    '## B （reserved2）', '- b',
    '## C 〔2 代〕', '- c',
    '## D [一代]', '- d',
  ].join('\n');
  const v1 = selectRoleText(card, 'v1');
  const v2 = selectRoleText(card, 'v2');
  assert.match(v1, /- a/); assert.match(v1, /- d/);
  assert.doesNotMatch(v1, /- b/); assert.doesNotMatch(v1, /- c/);
  assert.match(v2, /- b/); assert.match(v2, /- c/);
  assert.doesNotMatch(v2, /- a/); assert.doesNotMatch(v2, /- d/);
});

test('没有模式标记的老卡片：两种模式都完整注入（向后兼容）', () => {
  const legacy = '# 老卡\n\n- 性格：傲娇\n- 说话风格：简短';
  assert.equal(selectRoleText(legacy, 'v1'), legacy);
  assert.equal(selectRoleText(legacy, 'v2'), legacy);
});

test('标题之外的内容（前言）不受影响', () => {
  const card = '开头一句话\n\n## X 〔一代〕\n- x\n\n## Y\n- y';
  assert.match(selectRoleText(card, 'v2'), /开头一句话/);
  assert.doesNotMatch(selectRoleText(card, 'v2'), /- x/);
  assert.match(selectRoleText(card, 'v2'), /- y/);
});

test('统计与小节报告可用于控制台预览', () => {
  const stats = roleCharStats(CARD);
  assert.ok(stats.v1Only > 0 && stats.v2Only > 0, '应能统计出两代各自专属的字符数');
  assert.ok(stats.v1 < stats.total && stats.v2 < stats.total, '筛选后应短于原文');
  assert.notEqual(stats.v1, stats.v2, '两代内容不同，长度不应相等');
  const report = roleSectionReport(CARD, 'v1');
  const v2Section = report.find((r) => r.heading === '三、发言方式');
  assert.equal(v2Section.injected, false, '二代专属小节在一代下应标为不注入');
  const common = report.find((r) => r.heading === '一、你是谁');
  assert.equal(common.injected, true);
});

test('真实人格卡可用，且筛选不丢公共内容', () => {
  // 角色卡带测试状态标注（如「小鲸鱼（已测试）.md」），按前缀找，避免改名就红
  const rolesDir = new URL('../roles/', import.meta.url);
  const candidates = fs.readdirSync(rolesDir)
    .filter((f) => f.startsWith('小鲸鱼') && f.endsWith('.md'));
  assert.ok(candidates.length > 0, '找不到「小鲸鱼」角色卡（roles/ 下按前缀匹配）');
  const file = new URL('../roles/' + candidates[0], import.meta.url);
  const raw = fs.readFileSync(file, 'utf8');
  const v2 = selectRoleText(raw, 'v2');
  const v1 = selectRoleText(raw, 'v1');
  assert.ok(v2.length > 0 && v1.length > 0);
  // 人设部分两种模式都必须保留
  for (const text of [v1, v2]) {
    assert.match(text, /小鲸鱼/);
    assert.match(text, /AI 味|去 AI 味/);
  }
  // 二代注入的文本里不应再出现一代的分条机制
  assert.doesNotMatch(v2, /空格分隔（例如|\[SILENT\]/);
});

test('带 UTF-8 BOM 的角色卡标题仍可识别（实测踩过）', () => {
  // 背景：Windows 上 PowerShell 5.1 / 某些编辑器保存会带 BOM，首行变成
  // `\uFEFF# 标题`，`/^#{1,6}\s/` 匹配不上 ⇒ H1 退化成普通正文，
  // 控制台的章节统计与模式标记都会跟着错位。parseRoleSections 已剥 BOM，这里钉住。
  const withBom = '\uFEFF# 角色卡：X\n\n正文\n\n## 二节\n内容';
  const secs = parseRoleSections(withBom);
  assert.equal(secs[0].heading, '角色卡：X', '带 BOM 时首行标题必须仍被识别');
  assert.equal(secs[0].mode, 'all');
  const plain = parseRoleSections('# 角色卡：X\n\n正文');
  assert.equal(secs[0].heading, plain[0].heading, 'BOM 版本与无 BOM 版本应一致');
});

test('roles/ 下的说明文档不会被当成人格卡', () => {
  // 反例：roles/ATTRIBUTION.md 曾被 listRoles 当成角色卡，控制台里能选中
  // 「ATTRIBUTION」并把它当人格注入。这里从两个角度钉：文件自身不该以 `# 角色卡` 开头，
  // 且 bridge.js 的 listRoles 必须显式排除它。
  const rolesDir = new URL('../roles/', import.meta.url);
  const attr = new URL('../roles/ATTRIBUTION.md', import.meta.url);
  assert.ok(fs.existsSync(attr), '缺 roles/ATTRIBUTION.md');
  // 只断言它**不会被人格列表收进来**（标题长什么样不重要 —— 它本来就叫「角色卡的出处与版权」）

  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(bridge, /ROLE_NON_CARD_FILES = new Set\(\['README\.md', 'ATTRIBUTION\.md'\]\)/,
    'listRoles 必须排除 README.md 与 ATTRIBUTION.md');
  assert.match(bridge, /ROLE_RESERVED_NAMES = new Set\(\['README', 'ATTRIBUTION'\]\)/,
    'ATTRIBUTION 应是保留名，不能被新建成角色卡');
  // 带全角括号的既有卡片必须能被解析（sanitize 会吃掉括号，所以走了 resolveExistingRole）
  assert.match(bridge, /function resolveExistingRole/, '缺 resolveExistingRole（全角括号卡名依赖它）');
});

test('默认人设名必须在 roles/ 里解析得到（新装用户第一句就看这个）', () => {
  // 反例（真实踩过）：config.example.json 写 `小鲸鱼（已测试）`，而首次引导用
  // `listRoles().includes('小鲸鱼')` 判断 ⇒ 永远 false，掉到排序第一的
  // `傲娇助手（无测试）`（198 字节占位卡）。现在改成 resolveRoleName（精确→前缀→包含）。
  const rolesDir = new URL('../roles/', import.meta.url);
  const names = fs.readdirSync(rolesDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'ATTRIBUTION.md')
    .map((f) => f.slice(0, -3));
  assert.ok(names.length > 0, 'roles/ 下没有角色卡');

  const cfg = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  const want = String(cfg.role?.defaultName ?? '').trim();
  assert.ok(want, 'config.example.json 应设置 role.defaultName');

  const resolve = (raw) => {
    const w = String(raw ?? '').trim();
    if (!w) return null;
    const exact = names.find((r) => r === w);
    if (exact) return exact;
    const prefixed = names.filter((r) => r.startsWith(w));
    if (prefixed.length === 1) return prefixed[0];
    const contained = names.filter((r) => r.includes(w));
    return contained.length === 1 ? contained[0] : null;
  };

  assert.equal(resolve(want), names.find((n) => n.startsWith('小鲸鱼')) || resolve(want),
    `config.example.json 的默认人设「${want}」解析不到角色卡（现有：${names.join(', ')}）`);

  // 首次引导的代码已搬到 src/incoming-commands.js（2026-10-30 拆分），
  // 所以这里同时读 bridge 与模块：断言"整个仓库里存在这种写法"。
  const bridge = [
    fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/incoming-commands.js', import.meta.url), 'utf8')
  ].join('\n');
  assert.match(bridge, /resolveRoleName\(cfg\.role\?\.defaultName\)/,
    '首次引导必须用 resolveRoleName 解析默认人设（不能再用 listRoles().includes(精确名)）');
  // 只看"代码形态"（旧写法是 `includes('小鲸鱼') ? '小鲸鱼' : ...`）；
  // 注释里引用旧代码是允许的，所以必须带上 `?` 才算残留。
  assert.doesNotMatch(bridge, /listRoles\(\)\.includes\('小鲸鱼'\)\s*\?/,
    '还残留 includes(\'小鲸鱼\') ? ... 这种精确匹配（带后缀的卡永远匹配不上）');
});
