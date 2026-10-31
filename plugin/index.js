/**
 * qq-bridge · DSH 插件（薄插件形态）
 *
 * 目标（docs/design/plugin-mode-2026-10-31.md）：
 *   把「消息通路」搬进 DSH 进程（随宿主生命周期），
 *   把「记忆 / 记账 / 控制台 / 定时器」留在 sidecar，
 *   中间用 src/core/* 的纯函数 + sidecar 的 HTTP 契约连接。
 *
 * 本文件是 P1 骨架：**只做挂载自检**，不接 QQ。
 *   · 声明 name / inject / Config / apply（DSH 插件的四个约定）
 *   · 注册一个 qq_ping 工具，用来验证"插件确实被加载且工具进程内可用"
 *   · 探一次 sidecar 的 /health，把降级状态记下来（5.5 节的降级语义）
 *
 * 为什么用纯 JS 而不是 TS：插件要在 DSH 里被直接 import，
 * 多一道构建就多一处"源码与产物不一致"的可能（参考 dsh-onebot 的 lib/ 坑）。
 */

import { sessionIdFor as sessionIdOf } from './agent-driver.js';
import { createTools } from './tools.js';
import fs from 'node:fs';
import path from 'node:path';
import { createChatLog } from './chat-log.js';
import { mdToPlain } from './vendor/md-to-plain.js';

// 宿主用 defineTool() 把「参数说明」编译成 JSON Schema；直接把裸对象丢给
// ctx.tools.register 的话，register 不会编译 —— 供应商侧看到的是 `type: null`，
// 每一轮都报 "Invalid schema for function ...: got 'type: null'"（真机踩过）。
// 这里用顶层 await 动态取：拿不到（离线测试）就退回裸对象，不影响挂载。
let defineToolImpl = null;
try {
  const mod = await import('@deepseek-ai/dsh-tools');
  defineToolImpl = typeof mod.defineTool === 'function' ? mod.defineTool : null;
} catch { defineToolImpl = null; }

export const name = 'qq-bridge';

/** 给离线测试用的别名（对外 API 只有 name/inject/apply） */
export const normalizeConfigForTest = (raw) => normalizeConfig(raw);

/** DSH 插件依赖的服务。少一个都不挂载（fail-loud，不静默降级）。 */
// 'agents' 必须声明：宿主只把声明过的服务放进 ctx，没声明时访问 ctx.agents 会抛
// "cannot get property \"agents\" without inject"（真机踩过）。
export const inject = ['tools', 'agents'];

/** 配置默认值。真正的 schema 校验交给 DSH 的 schemastery（见 Config 导出）。 */
const DEFAULTS = {
  // 默认 false：装上插件不等于立刻连 QQ。要真接 QQ 必须显式打开，
  // 否则"顺手装个插件"就把用户的号接进来了。
  enabled: false,
  onebotUrl: 'ws://127.0.0.1:3001',
  accessToken: '',
  sidecarUrl: 'http://127.0.0.1:3110',
  requireMention: true,
  sidecarToken: '',
  // 必须和 sidecar 的 state/ 是同一个目录：通道认领文件要写在那里才起互斥作用
  stateDir: './state',
  allowGroups: [],
  // 建 agent 时用的 DSH preset：它带 persona（角色卡）+ QQ 场景规则 + 工具面。
  // 不指定的话 agent 就是通用助手，群里说话完全不像"小鲸鱼"（真机发现）。
  agentPreset: 'qq-chat-v2',
};

export function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS, ...(raw ?? {}) };
  return {
    enabled: cfg.enabled === true,
    onebotUrl: String(cfg.onebotUrl || DEFAULTS.onebotUrl),
    accessToken: String(cfg.accessToken || ''),
    sidecarUrl: String(cfg.sidecarUrl || DEFAULTS.sidecarUrl).replace(/\/+$/, ''),
    requireMention: cfg.requireMention !== false,
    sidecarToken: String(cfg.sidecarToken || ''),
    stateDir: String(cfg.stateDir || './state'),
    // 注意：Number(null) === 0 且是有限数 —— 只 .filter(Number.isFinite) 会把 null 变成群号 0。
    agentPreset: String(cfg.agentPreset ?? 'qq-chat-v2'),
    allowGroups: Array.isArray(cfg.allowGroups)
      ? cfg.allowGroups
          .filter((x) => x !== null && x !== undefined && String(x).trim() !== '')
          .map((x) => Number(x))
          .filter((x) => Number.isFinite(x) && x > 0)
      : [],
  };
}

/** 探 sidecar 是否在。失败不算错 —— 只是降级（被动回复仍可用）。 */
export async function probeSidecar(sidecarUrl, { timeoutMs = 1500 } = {}) {
  const url = String(sidecarUrl || '').replace(/\/+$/, '') + '/health';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const body = res.ok ? await res.json().catch(() => ({})) : {};
    return { ok: res.ok, mode: body?.mode ?? null, version: body?.version ?? null };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  // 日志同时写文件：插件跑在 DSH 进程里，桌面版的 stdout 用户看不到 ——
  // 出问题时只能靠 `<stateDir>/plugin.log` 还原现场（今天排查全靠猜，够了）。
  let logFile = null;
  try { logFile = path.join(config.stateDir, 'plugin.log'); } catch { logFile = null; }
  const log = (msg) => {
    const line = '[qq-plugin] ' + msg;
    console.log(line);
    if (!logFile) return;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      // 简单截断：超过 512KB 就轮转一份，避免无限长
      try {
        if (fs.statSync(logFile).size > 512 * 1024) fs.renameSync(logFile, logFile + '.1');
      } catch { /* 文件还不存在 */ }
      fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n', 'utf8');
    } catch { /* 写日志失败不能影响主流程 */ }
  };

  const disposers = [];
  const state = { startedAt: Date.now(), config, sidecar: { ok: null } };
  // 工具在挂载时注册（宿主只给一次机会），通道稍后才启动 —— 所以用可变 holder。
  // 注意：必须在 createTools() 之前声明，否则 getter 会踩 TDZ（Cannot access before initialization）。
  const toolRuntime = { channel: null, sidecar: null };
  // 会话语料缓冲：入站/出站都记，供 qq_get_recent / unread / wait 使用（重启即丢，持久化归 sidecar）
  const chatLog = createChatLog();
  // sidecar 客户端在挂载时就建好：即使不 enabled（不连 QQ），工具也能读快照/写意图。
  // 用动态 import 是为了让"没装 sidecar 也能加载插件"这条降级路径成立。
  let sidecarClient = null;
  import('./sidecar.js')
    .then(({ createSidecarClient }) => {
      // token 空时自动取 sidecar 的 console-token（同一台机器、同一个 state 目录）：
      // 否则 /snapshot 与 /intents 都会 401 —— 真机上表现为"工具说拿不到快照"。
      let sidecarToken = config.sidecarToken;
      if (!sidecarToken) {
        try {
          const f = path.join(config.stateDir, 'console-token');
          if (fs.existsSync(f)) sidecarToken = fs.readFileSync(f, 'utf8').trim();
        } catch { /* 读不到就不带 token，交给服务端 401 */ }
      }
      sidecarClient = createSidecarClient({
        baseUrl: config.sidecarUrl,
        token: sidecarToken,
        log: (m) => log(m),
      });
      toolRuntime.sidecar = sidecarClient;
      log('sidecar 客户端就绪：' + config.sidecarUrl);
    })
    .catch((e) => log('sidecar 客户端创建失败：' + (e?.message ?? e)));

  // ── 工具：进程内注册（D7 的 D2：不再走 MCP，少一跳）────────────────
  const ping = {
    name: 'qqb_ping',
    description: '检查 qq-bridge 插件是否已加载、sidecar 是否在线。用于安装自检，不发送任何 QQ 消息。',
    parameters: {},
    // 宿主实测要求：output 必须同时有 schema **和** render
    // （真机报错：tool "qq_ping" must declare output { schema, render, presentationMeta? }）
    output: {
      // 宿主实测：SCHEMA_TYPES 只有 object/array/string/number/integer/boolean/null，
      // 没有 'json'（dsh-onebot 用 json 是因为它适配的是更新的宿主）。
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        const sidecar = v.sidecar?.ok ? '在线' : '离线（降级）';
        return [{ type: 'text', text: `qq-bridge 插件存活；sidecar ${sidecar}` }];
      },
    },
    isConcurrencySafe: () => true,
    execute: async () => {
      const sidecar = await probeSidecar(config.sidecarUrl);
      state.sidecar = sidecar;
      return {
        ok: true,
        plugin: name,
        uptimeMs: Date.now() - state.startedAt,
        sidecar,
        degraded: !sidecar.ok,
        note: sidecar.ok
          ? 'sidecar 在线：记忆/记账/控制台/主动消息可用'
          : 'sidecar 不在：被动回复可用；记忆写入、记账、控制台、主动消息不可用',
      };
    },
  };

  // 同名工具已经存在（例：桌面版还挂着 mcp-snowluma，那边也有 qq_get_prompt）时**跳过**。
  // 真机事故（2026-10-31 12:02）：两个同名工具并存，供应商侧收到的函数 schema 变成
  // `type: null` → 每一轮都报 "Invalid schema for function 'qq_get_prompt'"，整轮失败。
  const toolExists = (n) => {
    try { return typeof ctx.tools.get === 'function' && !!ctx.tools.get(n); } catch { return false; }
  };
  const registerTool = (tool) => {
    if (toolExists(tool.name)) {
      log(`工具 ${tool.name} 已存在（多半是同名 MCP 工具），跳过注册 —— 该功能请走 MCP 那份`);
      return;
    }
    try {
      disposers.push(ctx.tools.register(defineToolImpl ? defineToolImpl(tool) : tool));
    } catch (e) {
      log(`工具 ${tool.name} 注册失败：` + (e?.message ?? e));
    }
  };

  if (typeof ctx?.tools?.register === 'function') {
    registerTool(ping);
    // N1 第一批：发送 / 引用回复 / 标记已读（进程内工具，不走 MCP）
    const toolDeps = {
      get channel() { return toolRuntime.channel; },
      get sidecar() { return toolRuntime.sidecar; },
      chatLog,
      log: (m) => log(m),
    };
    for (const tool of createTools(toolDeps)) registerTool(tool);
  } else {
    throw new Error('[qq-plugin] 挂载失败：ctx.tools.register 不可用（DSH 版本不匹配？）');
  }

  // ── 通道（只有 enabled=true 才连 QQ）──────────────────────────────
  let channel = null;
  let driver = null;
  let channelGuard = null;
  if (config.enabled) {
    (async () => {
      try {
        const [{ OneBotWsClient }, { createInboundGate }, { createChannel }, { createAgentDriver }, { createChannelModeStore }] = await Promise.all([
          import('./vendor/onebot-ws.js'),
          import('./inbound.js'),
          import('./channel.js'),
          import('./agent-driver.js'),
          // 通道模式闸：插件和常驻 bridge 只能有一个在收 QQ 消息
          import('./vendor/channel-mode-store.js').catch(() => ({ createChannelModeStore: null })),
        ]);
        if (!ctx.agents?.create) throw new Error('ctx.agents.create 不可用（inject 里要声明 agents）');

        // 通道模式闸（N3）：bridge 正在收消息时不重复接，否则群里会看到两条回复。
        try {
          const mod = await import('./vendor/channel-mode-store.js');
          const store = mod.createChannelModeStore({ fs: await import('node:fs'), path: await import('node:path'), stateDir: config.stateDir });
          let claim = store.claim('plugin', { pid: process.pid, note: 'DSH 插件通道' });
          if (!claim.ok) {
            // 真机事故（2026-10-31 13:02）：DSH 重启后旧插件的认领还在 60s 心跳窗口内，
            // 新插件被判"通道被占用"→ 干脆不连 QQ，群里 @ 它毫无反应。
            // 死了的持有者不该拦人：这里按 pid 存活性自己做一次抢占。
            const holderPid = Number(claim?.holder?.pid ?? 0);
            let holderAlive = false;
            try { if (holderPid > 0) { process.kill(holderPid, 0); holderAlive = true; } } catch { holderAlive = false; }
            if (holderPid > 0 && !holderAlive) {
              try { fs.rmSync(store.file, { force: true }); } catch { /* ignore */ }
              log('通道持有者 pid ' + holderPid + ' 已退出，接管通道');
              claim = store.claim('plugin', { pid: process.pid, note: 'DSH 插件通道' });
            }
          }
          if (!claim.ok) {
            log('⚠️ 通道被占用：' + store.describe() + ' —— 插件不连接 QQ（要切到插件模式，请先停掉 bridge）。');
            return;
          }
          log('通道模式：plugin（' + claim.reason + '）');
          const timer = setInterval(() => store.heartbeat('plugin', { pid: process.pid, note: 'DSH 插件通道' }), 20_000);
          timer.unref?.();
          channelGuard = { store, stop: () => { clearInterval(timer); store.release('plugin', { pid: process.pid }); } };
        } catch (e) {
          log('通道模式闸不可用（继续启动）：' + (e?.message ?? e));
        }
        // 拿宿主默认模型：不装的话 agent 不会跑（没有 provider/model → 无 turn、无报错）
        let selection = null;
        let installSelection = null;
        try {
          const svc = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null;
          if (svc && typeof svc.currentSelection === 'function') selection = svc.currentSelection();
          const agentMod = await import('@deepseek-ai/dsh-agent');
          installSelection = typeof agentMod.installModelSelection === 'function' ? agentMod.installModelSelection : null;
        } catch (e) {
          log('取默认模型失败（agent 可能不跑）：' + (e?.message ?? e));
        }
        if (selection) log(`默认模型：${selection.provider}/${selection.model}`);
        else log('⚠️ 没取到默认模型：agent 可能起不了 turn');

        driver = createAgentDriver({
          agents: ctx.agents,
          agentPreset: config.agentPreset,
          fsForCwd: fs, pathForCwd: path,
          // ⚠️ Windows 不允许文件名里有 ':' —— 保留它会让 mkdir 直接 ENOENT（真机踩过）
          cwdOf: (chatKey) => path.join(config.stateDir, 'agents', String(chatKey).replace(/[^a-zA-Z0-9_-]/g, '_')),
          agentOptions: selection ? { provider: selection.provider, model: selection.model } : {},
          setup: (agentCtx) => {
            try {
              if (selection && installSelection) installSelection(agentCtx, { current: selection, assembled: undefined });
            } catch (e) { log('installModelSelection 失败：' + (e?.message ?? e)); }
            // 插件会把 assistant 文本自动转发到 QQ —— 模型不需要（也不该）再调发送工具。
            // 真机教训：它会先试 qqb_send_message / qq_send_message，报错后再绕一圈，白烧 30+ 步。
            // 🔒 安全边界：QQ 会话来自**陌生人**，绝不能拿到本地工具。
            // 真机事故（2026-10-31）：群友让 agent 做"管理员级操作"，它照做了 ——
            // 因为插件建的 agent 默认带全部工具（bash/read/write/edit…），权限就是用户本人。
            // 这里用**白名单**（allow）而不是黑名单：新增工具默认不可用。
            // 与桥接 preset 的 guard 白名单对齐：只有 QQ 工具 + 两个无害模型侧工具。
            // 注意：宿主里 web 搜索是 MCP 命名空间工具（mcp__web-search-safe__*），
            // 名字带前缀，这里按**精确名**拿不到 —— 宁可让 QQ 侧没有联网，也不要留本地能力。
            const ALLOW = [
              'qqb_ping', 'qqb_get_prompt', 'qqb_mark_read',
              'qqb_get_recent_messages', 'qqb_get_unread_messages', 'qqb_wait_for_messages',
              'qqb_send_message', 'qqb_reply',
              'todo_write', 'ask_user_question',
            ];
            try {
              agentCtx?.tools?.restrict?.({ allow: ALLOW });
              log('已对 agent 应用工具白名单（' + ALLOW.length + ' 个；本地工具全部不可见）');
            } catch (e) {
              log('⚠️ 工具白名单应用失败（危险，请检查）：' + (e?.message ?? e));
            }
          },
          loadCreateUserMessage: async () => (await import('@deepseek-ai/dsh-llm')).createUserMessage,
          log: (m) => log(m),
          meta: { plugin: name },
        });
        const gate = createInboundGate(config);
        const bySession = new Map(); // sessionId -> chatKey

        // 助手回复 → QQ（DSH 的会话事件总线）
        // Agent 侧的错误以前完全看不到 —— 加一条监听，直接落进 plugin.log
        if (typeof ctx.on === 'function') {
          disposers.push(ctx.on('agent/error', ({ agent: subject, error } = {}) => {
            log('❌ agent 错误：' + (error?.message ?? String(error)));
          }));
        }
        if (typeof ctx.on === 'function') {
          disposers.push(ctx.on('session/event', (session, event) => {
            if (bySession.has(session?.id)) log(`会话事件：${event?.type ?? '?'}`);
            const chatKey = bySession.get(session?.id);
            if (!chatKey) return;
            if (event?.type !== 'assistant/message') return;
            const blocks = event?.data?.message?.content ?? [];
            const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('');
            if (!text.trim()) return;
            // QQ 不渲染 Markdown：先把 ```/`**` 之类去掉，否则群友看到一堆符号
            let outgoing = text;
            try { outgoing = mdToPlain(text); } catch { /* 转换失败就发原文 */ }
            log(`助手回复 → ${chatKey}（${String(text).length} 字，转纯文本 ${String(outgoing).length} 字）`);
            // OneBotWsClient.call() 返回的就是 response.data
            channel?.send(chatKey, outgoing)
              .then((r) => log(`发送成功 ${chatKey} message_id=${r?.message_id ?? r?.data?.message_id ?? JSON.stringify(r ?? null).slice(0, 60)}`))
              .catch((e) => log(`❌ 发送失败 ${chatKey}：` + (e?.message ?? e)));
          }));
        }

        channel = createChannel({
          Client: OneBotWsClient,
          clientOptions: { url: config.onebotUrl, accessToken: config.accessToken || undefined },
          log: (m) => log(m),
          onInbound: (event) => {
            // 先进缓冲再判定：没唤醒的消息也要能被 qq_get_recent_messages 看到，
            // 否则模型会以为群里很安静（这是"潜水观察"的前提）。
            const key = String(event?.group_id ? 'group:' + event.group_id : (event?.user_id ? 'private:' + event.user_id : ''));
            const text = Array.isArray(event?.message)
              ? event.message.filter((s) => s?.type === 'text').map((s) => s.data?.text ?? '').join('')
              : String(event?.message ?? '');
            if (key && event?.post_type === 'message' && text.trim()) {
              chatLog.append(key, { text, userId: String(event.user_id ?? ''), self: String(event.user_id) === String(event.self_id) });
            }
            const r = gate(event, { selfId: state.selfId ?? event?.self_id });
            if (!r.handle) {
              // 静默丢弃是今天最大的坑：至少留一行痕迹
              if (r.reason !== 'self' && r.reason !== 'not-message') {
                log(`入站丢弃（${r.reason}）key=${event?.group_id ? 'group:' + event.group_id : 'private:' + event?.user_id} uid=${event?.user_id}`);
              }
              return;
            }
            log(`入站投递 ${r.key} uid=${r.userId}`);
            // ⚠️ 必须等 deliver 返回**真实**的 sessionId：会话 id 撞车时 driver 会用 fallback，
            // 这时用原始 id 建映射，assistant/message 永远匹配不上（真机踩过）。
            driver.deliver(r.key, r.text)
              .then((entry) => {
                bySession.set(entry.sessionId, r.key);
                const a = entry.agent;
                log(`会话映射建立 session=${entry.sessionId} → ${r.key}`);
                log(`agent 初始：status=${a?.status ?? '?'} seq=${a?.session?.seq ?? '?'} agentId=${a?.id ?? '?'}`);
                // 3 秒后再看一次：seq 不动 = agent loop 没跑；动了但没 assistant = 模型侧问题
                setTimeout(() => {
                  try {
                    log(`agent 3s 后：status=${a?.status ?? '?'} seq=${a?.session?.seq ?? '?'}`);
                  } catch (e) { log('agent 状态读取失败：' + (e?.message ?? e)); }
                }, 3000).unref?.();
              })
              .catch((e) => log('投递给 Agent 失败：' + (e?.message ?? e)));
          },
        });
        await channel.start();
        toolRuntime.channel = channel;
        toolRuntime.sidecar = sidecarClient;
        // 真机事故（2026-10-31 13:0x）：SnowLuma 推送的事件**不带 self_id**，
        // 于是「@我了吗」永远判 false —— 群里 @ 它完全没反应，也不报错。
        // 这里主动问一次网关要自己的 QQ 号，之后所有 @ 判定都用它。
        try {
          const info = await channel.call('get_login_info', {});
          const selfId = info?.data?.user_id ?? info?.user_id ?? null;
          if (selfId) {
            state.selfId = String(selfId);
            log('自身 QQ = ' + state.selfId + '（用于 @ 判定）');
          } else {
            log('⚠️ 没取到自身 QQ（get_login_info 无 user_id），@ 判定可能失效');
          }
        } catch (e) {
          log('⚠️ get_login_info 失败（@ 判定可能失效）：' + (e?.message ?? e));
        }
        log('QQ 通道已启动');
      } catch (e) {
        log('QQ 通道启动失败（插件仍可用，只是不连 QQ）：' + (e?.message ?? e));
      }
    })();
  }

  // ── 降级检查：启动时探一次，把结论打出来（5.5 节要求）──────────────
  probeSidecar(config.sidecarUrl, { timeoutMs: 5000 })
    .then((res) => {
      state.sidecar = res;
      if (!res.ok) {
        // 把原因也打出来：宿主启动期 1.5s 超时会造成"明明开着却说没连上"的误判
        log(`sidecar 未连接（${config.sidecarUrl}，原因：${res.error ?? 'unknown'}）：`
            + '主动消息、记忆写入、记账、控制台均不可用（被动回复正常）');
      } else {
        log(`已挂载；sidecar 在线（mode=${res.mode ?? '?'}）`);
      }
    })
    .catch(() => {});

  log(`插件已挂载：onebot=${config.onebotUrl} sidecar=${config.sidecarUrl} requireMention=${config.requireMention}`);

  // DSH 卸载插件时会调用返回的 dispose（Cordis 约定：apply 返回清理函数也合法）
  return () => {
    try { channel?.close(); } catch { /* ignore */ }
    try { channelGuard?.stop?.(); } catch { /* ignore */ }
    try { driver?.disposeAll?.(); } catch { /* ignore */ }
    for (const d of disposers) {
      try { d(); } catch { /* 卸载失败不该影响宿主 */ }
    }
  };
}