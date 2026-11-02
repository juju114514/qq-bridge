// 内置工具（0.5.46 · C2）
//
// 目的：让桥接自带的 agent **直接操作自己的会话状态**，不再绕 MCP/DSH。
// AstrBot 的手机独立就是因为工具在它自己进程里（core/tools）；我们这里等价。
//
// 读：直接读 state/social-v2.json（与控制台同源，桥接每次变更都会落盘）
// 写：走注入进来的 sendToQQ（桥接已有的发送通道，含审计/限流/拦截）
import fs from 'node:fs';
import path from 'node:path';

const SAFE_KEY = /^(group|private):[A-Za-z0-9_-]{1,40}$/;

/** 读状态文件；坏文件当空对象，绝不让工具把 agent 拖崩 */
function readState(stateDir) {
  try {
    const raw = fs.readFileSync(path.join(stateDir, 'social-v2.json'), 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? (j.conversations || {}) : {};
  } catch { return {}; }
}

function summarizeMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const text = String(m.text ?? m.message ?? '').slice(0, 300);
  return { seq: m.seq ?? null, sender: String(m.sender ?? ''), text, at: Number(m.at) || 0 };
}

/**
 * @param {{stateDir:string, sendToQQ?:Function, log?:Function}} deps
 * @returns {Array<{name:string,description:string,parameters:object,run:Function}>}
 */
export function createSocialTools(deps = {}) {
  const { stateDir = 'state', sendToQQ = null, log = () => {}, defaultKey = '' } = deps;

  const tools = [
    {
      name: 'qq_get_context',
      description: '读取某个会话的最近消息与未读，用来理解当前在聊什么。参数 key 形如 group:123456 或 private:123456。',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: '会话 key' } },
        required: ['key']
      },
      async run(args = {}) {
        const key = String(args.key || '');
        if (!SAFE_KEY.test(key)) return { ok: false, error: 'key 格式不对（应形如 group:123 或 private:123）' };
        const st = readState(stateDir)[key];
        if (!st) return { ok: true, found: false, note: '这个会话还没有状态记录' };
        const recent = Array.isArray(st.recentMessages) ? st.recentMessages.slice(-12).map(summarizeMessage).filter(Boolean) : [];
        const unread = Array.isArray(st.unread) ? st.unread.slice(-8).map(summarizeMessage).filter(Boolean) : [];
        return {
          ok: true,
          found: true,
          key,
          wakeReason: String(st.lastWakeReason || ''),
          lastIncomingAt: Number(st.lastIncomingAt) || 0,
          recent,
          unread
        };
      }
    },
    {
      name: 'qq_memory_query',
      description: '查这个会话的轻量记忆：正在聊的话题、想说还没说的话、对群友的印象。',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: '会话 key' } },
        required: ['key']
      },
      async run(args = {}) {
        const key = String(args.key || '');
        if (!SAFE_KEY.test(key)) return { ok: false, error: 'key 格式不对' };
        const st = readState(stateDir)[key];
        if (!st) return { ok: true, found: false };
        const impressions = st.memberImpressions && typeof st.memberImpressions === 'object'
          ? Object.fromEntries(Object.entries(st.memberImpressions).slice(0, 10).map(([k, v]) => [k, {
            traits: Array.isArray(v?.traits) ? v.traits.slice(0, 6) : [],
            count: Number(v?.interactionCount) || 0
          }]))
          : {};
        return {
          ok: true,
          found: true,
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-5).map((t) => String(t?.text ?? t).slice(0, 200)) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-5).map((t) => String(t?.text ?? t).slice(0, 200)) : [],
          memberImpressions: impressions
        };
      }
    },
    {
      name: 'qq_send_message',
      description: '往指定会话发一条消息。真发出去，不可撤回。参数 key 与 text。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '会话 key' },
          text: { type: 'string', description: '消息正文，别超过 200 字' }
        },
        required: ['key', 'text']
      },
      async run(args = {}) {
        // 只允许发到"当前会话"：有 defaultKey 时忽略模型自己填的 key
        const key = defaultKey || String(args.key || '');
        const text = String(args.text || '').trim();
        if (!SAFE_KEY.test(key)) return { ok: false, error: 'key 格式不对' };
        if (!text) return { ok: false, error: 'text 不能为空' };
        if (typeof sendToQQ !== 'function') return { ok: false, error: '当前没有可用的发送通道' };
        try {
          await sendToQQ(key, text.slice(0, 1500));
          log(`[agent] 已发送 → ${key}（${text.length} 字）`);
          return { ok: true, sent: true, key, chars: text.length };
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
        }
      }
    }
  ];

  return tools;
}
