// 交接包（0.5.54 · P2）
//
// 换脑最大的坑：新大脑不知道刚才聊了什么。
// 长期记忆能兜住"事实"，但兜不住"刚才这半小时的对话"。
//
// 做法：切换发生时，从 state/social-v2.json 里现成的东西拼一小段交接文本：
//   最近 N 条消息 + 进行中的话题 + 还没说出口的话
// 成本几乎为零（都是已经存着的），但能让接手的大脑"续得上"。
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'brain-handoff.json';
const MAX_CHARS = 1200;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

/** 交接包落盘（记住"上一轮是谁在跑"，下次比对就知道该不该给包） */
export function readHandoff(stateDir) {
  return readJson(path.join(stateDir, FILE), { lastBrain: '', pending: {} });
}

export function writeHandoff(stateDir, data) {
  const file = path.join(stateDir, FILE);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch { /* 交接包写不进去不该影响回复 */ }
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 从会话状态里拼交接文本。
 * @param {{stateDir:string, key:string, from:string, to:string, now?:number}} input
 * @returns {string} 没有内容时返回空串（别塞一堆"暂无"）
 */
export function buildHandoffBrief(input = {}) {
  const { stateDir = 'state', key = '', from = '', to = '', now = Date.now() } = input;
  let st = null;
  try {
    const disk = readJson(path.join(stateDir, 'social-v2.json'), {});
    st = disk?.conversations?.[key] || null;
  } catch { st = null; }
  if (!st) return '';

  const lines = [];
  const recent = Array.isArray(st.recentMessages) ? st.recentMessages.slice(-10) : [];
  if (recent.length) {
    const mins = recent[0]?.at ? Math.max(1, Math.round((now - Number(recent[0].at)) / 60000)) : 0;
    lines.push(`最近${mins ? ` ${mins} 分钟` : ''}的对话（旧→新）：`);
    for (const m of recent) {
      const who = String(m?.sender || '对方');
      lines.push(`· ${who}：${clip(m?.text, 90)}`);
    }
  }

  const topics = Array.isArray(st.activeTopics) ? st.activeTopics.slice(-3) : [];
  if (topics.length) {
    lines.push('正在聊的话题：');
    for (const t of topics) lines.push(`· ${clip(t?.text ?? t, 80)}`);
  }

  const pending = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-2) : [];
  if (pending.length) {
    lines.push('你之前想说但还没说的：');
    for (const t of pending) lines.push(`· ${clip(t?.text ?? t, 80)}`);
  }

  // 兜底：有些路径（外部注入、DSH 内部回合）不会填 recentMessages，
  // 这时至少把长期记忆带上，别让交接包变成空串。
  if (!lines.length) {
    const atoms = Array.isArray(st.longTermMemories) ? st.longTermMemories.slice(-4) : [];
    if (atoms.length) {
      lines.push('你记得的事：');
      for (const a of atoms) lines.push('· ' + clip(a?.text, 80));
    }
  }
  if (!lines.length) return '';
  const head = `【交接】你刚从 ${from} 切到 ${to}，下面是这期间发生的，别重复已经说过的内容：`;
  const body = lines.join('\n');
  const text = `${head}\n${body}`;
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
}
