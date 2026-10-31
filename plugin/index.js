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

export const name = 'qq-bridge';

/** 给离线测试用的别名（对外 API 只有 name/inject/apply） */
export const normalizeConfigForTest = (raw) => normalizeConfig(raw);

/** DSH 插件依赖的服务。少一个都不挂载（fail-loud，不静默降级）。 */
export const inject = ['tools'];

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
  allowGroups: [],
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
    // 注意：Number(null) === 0 且是有限数 —— 只 .filter(Number.isFinite) 会把 null 变成群号 0。
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
  const log = (msg) => console.log('[qq-plugin] ' + msg);

  const disposers = [];
  const state = { startedAt: Date.now(), config, sidecar: { ok: null } };
  // 工具在挂载时注册（宿主只给一次机会），通道稍后才启动 —— 所以用可变 holder。
  // 注意：必须在 createTools() 之前声明，否则 getter 会踩 TDZ（Cannot access before initialization）。
  const toolRuntime = { channel: null, sidecar: null };
  // sidecar 客户端在挂载时就建好：即使不 enabled（不连 QQ），工具也能读快照/写意图。
  // 用动态 import 是为了让"没装 sidecar 也能加载插件"这条降级路径成立。
  let sidecarClient = null;
  import('./sidecar.js')
    .then(({ createSidecarClient }) => {
      sidecarClient = createSidecarClient({
        baseUrl: config.sidecarUrl,
        token: config.sidecarToken,
        log: (m) => log(m),
      });
      toolRuntime.sidecar = sidecarClient;
      log('sidecar 客户端就绪：' + config.sidecarUrl);
    })
    .catch((e) => log('sidecar 客户端创建失败：' + (e?.message ?? e)));

  // ── 工具：进程内注册（D7 的 D2：不再走 MCP，少一跳）────────────────
  const ping = {
    name: 'qq_ping',
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

  if (typeof ctx?.tools?.register === 'function') {
    disposers.push(ctx.tools.register(ping));
    // N1 第一批：发送 / 引用回复 / 标记已读（进程内工具，不走 MCP）
    const toolDeps = {
      get channel() { return toolRuntime.channel; },
      get sidecar() { return toolRuntime.sidecar; },
      log: (m) => log(m),
    };
    for (const tool of createTools(toolDeps)) {
      disposers.push(ctx.tools.register(tool));
    }
  } else {
    throw new Error('[qq-plugin] 挂载失败：ctx.tools.register 不可用（DSH 版本不匹配？）');
  }

  // ── 通道（只有 enabled=true 才连 QQ）──────────────────────────────
  let channel = null;
  let driver = null;
  if (config.enabled) {
    (async () => {
      try {
        const [{ OneBotWsClient }, { createInboundGate }, { createChannel }, { createAgentDriver }] = await Promise.all([
          import('../src/onebot-ws.js'),
          import('./inbound.js'),
          import('./channel.js'),
          import('./agent-driver.js'),
        ]);
        if (!ctx.agents?.create) throw new Error('ctx.agents.create 不可用（inject 里要声明 agents）');
        driver = createAgentDriver({
          agents: ctx.agents,
          loadCreateUserMessage: async () => (await import('@deepseek-ai/dsh-llm')).createUserMessage,
          log: (m) => log(m),
          meta: { plugin: name },
        });
        const gate = createInboundGate(config);
        const bySession = new Map(); // sessionId -> chatKey

        // 助手回复 → QQ（DSH 的会话事件总线）
        if (typeof ctx.on === 'function') {
          disposers.push(ctx.on('session/event', (session, event) => {
            const chatKey = bySession.get(session?.id);
            if (!chatKey) return;
            if (event?.type !== 'assistant/message') return;
            const blocks = event?.data?.message?.content ?? [];
            const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('');
            if (!text.trim()) return;
            channel?.send(chatKey, text).catch((e) => log('发送失败：' + (e?.message ?? e)));
          }));
        }

        channel = createChannel({
          Client: OneBotWsClient,
          clientOptions: { url: config.onebotUrl, accessToken: config.accessToken || undefined },
          log: (m) => log(m),
          onInbound: (event) => {
            const r = gate(event, { selfId: event?.self_id });
            if (!r.handle) return;
            bySession.set(sessionIdOf(r.key), r.key);
            driver.deliver(r.key, r.text).catch((e) => log('投递给 Agent 失败：' + (e?.message ?? e)));
          },
        });
        await channel.start();
        toolRuntime.channel = channel;
        toolRuntime.sidecar = sidecarClient;
        log('QQ 通道已启动');
      } catch (e) {
        log('QQ 通道启动失败（插件仍可用，只是不连 QQ）：' + (e?.message ?? e));
      }
    })();
  }

  // ── 降级检查：启动时探一次，把结论打出来（5.5 节要求）──────────────
  probeSidecar(config.sidecarUrl)
    .then((res) => {
      state.sidecar = res;
      if (!res.ok) {
        log(`sidecar 未连接（${config.sidecarUrl}）：主动消息、记忆写入、记账、控制台均不可用（被动回复正常）`);
      } else {
        log(`已挂载；sidecar 在线（mode=${res.mode ?? '?'}）`);
      }
    })
    .catch(() => {});

  log(`插件已挂载：onebot=${config.onebotUrl} sidecar=${config.sidecarUrl} requireMention=${config.requireMention}`);

  // DSH 卸载插件时会调用返回的 dispose（Cordis 约定：apply 返回清理函数也合法）
  return () => {
    try { channel?.close(); } catch { /* ignore */ }
    try { driver?.disposeAll?.(); } catch { /* ignore */ }
    for (const d of disposers) {
      try { d(); } catch { /* 卸载失败不该影响宿主 */ }
    }
  };
}