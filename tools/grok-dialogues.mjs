#!/usr/bin/env node
/**
 * 用 Grok 给人格卡生成「示例对话」（2~3 组），可直接写回角色卡。
 *
 * 为什么用脚本而不是手抄：角色卡里的示例对话会被 src/role-dialogues.js 解析成 few-shot，
 * 格式必须是 `## 示例对话` + `用户：…` / `我：…` 成对，手抄很容易多一行空行、少一个冒号，
 * 解析器就安静地少注入一组 —— 表现是"卡里写了嘴臭，实际不嘴臭"。
 *
 * 三种用法：
 *   1) 有 xAI key（最快）
 *        $env:XAI_API_KEY='xai-...'
 *        node tools/grok-dialogues.mjs --card "roles/小鲸鱼（已测试）.md" --level strong --apply
 *
 *   2) 没有 key，但能用 Grok 网页
 *        node tools/grok-dialogues.mjs --card "..." --level strong --print-prompt
 *        → 把打印出来的提示词贴进 Grok，把回复存成 dialogue.txt
 *        node tools/grok-dialogues.mjs --card "..." --from-file dialogue.txt --apply
 *
 *   3) 只想看看会发什么请求
 *        node tools/grok-dialogues.mjs --card "..." --level spicy --dry-run
 *
 * 说明：--level spicy 的「尺度」由你的提示词和 Grok 自己决定；这个脚本不发消息、不碰 QQ。
 */

import fs from 'node:fs';
import path from 'node:path';
import { addDraft } from '../src/role-dialogue-write.js';

const argv = process.argv.slice(2);
const arg = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d; };
const has = (k) => argv.includes(k);

const cardPath = arg('--card');
if (!cardPath) {
  console.error('用法：node tools/grok-dialogues.mjs --card "roles/<名字>.md" [--level mild|strong|spicy] [--apply] [--print-prompt] [--from-file x.txt] [--dry-run]');
  process.exit(2);
}
const level = String(arg('--level', 'strong')).toLowerCase();
const model = String(arg('--model', process.env.XAI_MODEL || 'grok-4'));
const apiBase = String(process.env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(/\/+$/, '');
const pairs = Math.max(1, Math.min(3, Number(arg('--pairs', '3')) || 3));

const file = path.resolve(cardPath);
if (!fs.existsSync(file)) { console.error(`卡片不存在：${file}`); process.exit(2); }
const raw = fs.readFileSync(file, 'utf8');
const cardName = (raw.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || path.basename(file, '.md');
const body = raw.replace(/^---[\s\S]*?---\s*/, '');

/** 尺度描述：只描述"说话方式"，不写具体露骨内容。 */
const LEVEL_TEXT = {
  mild: '嘴上不客气：吐槽、损人、翻白眼，但不带脏字。',
  strong: '真的会骂人：允许带脏字（如"他妈的""操""滚"），语气冲到脸上，但不针对对方的真实身份特征（地域、性别、身体、家人）。',
  spicy: '嘴臭 + 开黄腔：会骂人，也会接暧昧/荤段子，尺度到"暗示和调侃"为止；**不写露骨的性行为过程描写**。'
};

const prompt = `你在帮我写一张聊天机器人「人格卡」里的【示例对话】。示例对话比形容词管用：模型会照着它学语气。

角色：${cardName}

卡片正文（节选，供你把握人设）：
"""
${body.slice(0, 3000)}
"""

请写 ${pairs} 组对话，每组 2~4 句（一问一答算一组内的回合），格式**严格**如下，不要任何多余文字、不要编号、不要解释：

用户：<群友说的话>
我：<角色的回应>

要求：
1. 语气尺度：${LEVEL_TEXT[level] || LEVEL_TEXT.strong}
2. 覆盖不同场景：一组是日常闲聊，一组是有人挑事/嘴她，一组是有人想占便宜或撩她
3. 回应要短，像 QQ 群聊（1~2 句），不要写成文章
4. 不要出现真实人名、真实群号、真实联系方式
5. 不要写露骨的性行为描写（可以荤、可以脏，但不写器官与过程）
6. 只输出对话行，不要 markdown 代码块`;

async function callGrok(text) {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';
  if (!key) throw new Error('没有 XAI_API_KEY（先 $env:XAI_API_KEY=\'xai-...\'，或改用 --print-prompt）');
  const res = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: text }],
      temperature: 0.9,
      max_tokens: 800
    }),
    signal: AbortSignal.timeout(120000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`xAI 返回 ${res.status}：${JSON.stringify(data?.error || data).slice(0, 200)}`);
  return String(data?.choices?.[0]?.message?.content ?? '').trim();
}

/** 只保留「用户：/我：」行，清掉代码块和多余说明。 */
function sanitize(text) {
  return String(text || '')
    .replace(/```[a-z]*\n?/gi, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(用户|对方|user|我|助手|assistant)\s*[:：]\s*\S/.test(l))
    .map((l) => l.replace(/^用户\s*[:：]/, '用户：').replace(/^(我|助手|assistant)\s*[:：]/, '我：'))
    .join('\n');
}

/** 把示例写进卡片：替换已有的 `## 示例对话` 小节；没有就追加到末尾。 */
function applyToCard(block) {
  const section = `## 示例对话\n${block}\n`;
  const re = /^#{1,6}\s*(示例对话|示例|对话样例|examples?)\s*$[\s\S]*?(?=^#{1,6}\s|\s*$)/im;
  let next;
  if (re.test(raw)) next = raw.replace(re, section);
  else next = raw.trimEnd() + `\n\n${section}`;
  fs.writeFileSync(file, next.endsWith('\n') ? next : next + '\n', 'utf8');
  return next;
}

const dry = has('--dry-run');
if (has('--print-prompt') || dry) {
  console.log('── 发给 Grok 的提示词 ─────────────────────────────');
  console.log(prompt);
  console.log('───────────────────────────────────────────────');
  if (has('--print-prompt')) {
    console.log('\n把这整段贴进 Grok，把回复存成 txt，然后：');
    console.log(`  node tools/grok-dialogues.mjs --card "${cardPath}" --from-file 回复.txt --apply`);
    process.exit(0);
  }
}

let generated = '';
const fromFile = arg('--from-file');
try {
  if (fromFile) {
    generated = sanitize(fs.readFileSync(path.resolve(fromFile), 'utf8'));
  } else if (!dry) {
    console.log(`→ 调 ${apiBase}（model=${model}，level=${level}）…`);
    generated = sanitize(await callGrok(prompt));
  }
} catch (e) {
  console.error(`✗ ${e?.message ?? e}`);
  console.error('  没有 key 的话：加 --print-prompt，把提示词贴到 Grok 网页，再用 --from-file 回填。');
  process.exit(1);
}

if (!generated) { console.error('✗ 没解析出任何「用户：/我：」行'); process.exit(1); }

console.log('── 生成的示例对话 ───────────────────────────────');
console.log(generated);
console.log('───────────────────────────────────────────────');

if (has('--queue')) {
  // 只进草稿箱：控制台「示例对话草稿」里人看、人改、人点「应用」才写卡
  const stateDir = path.resolve(process.cwd(), 'state');
  const draft = addDraft(stateDir, { card: path.basename(file), level, text: generated, source: 'grok' });
  console.log(`✓ 已进草稿箱：${draft.id}（${draft.pairs} 组）`);
  console.log('  打开控制台 → 人格与角色 → 示例对话草稿 → 改完点「应用到卡片」');
  process.exit(0);
}

if (has('--apply')) {
  applyToCard(generated);
  console.log(`✓ 已写入 ${cardPath} 的「## 示例对话」小节（${generated.split('\n').length} 行）`);
  console.log('  提醒：卡片改动即时生效（下一轮注入就是新示例）；别让它在卡尾被 maxInjectChars 截掉。');
} else {
  console.log('（未写盘。确认没问题后加 --apply）');
}
