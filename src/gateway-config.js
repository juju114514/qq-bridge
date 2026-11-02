// 网关（OneBot 实现）抽象（0.5.45）
//
// 背景：桥接原来假定网关 = SnowLuma（Windows 上把 hook 挂进 QQ 客户端进程）。
// 2026-11-02 研究 AstrBot 安卓方案后确认：**NapCat** 也是 OneBot v11 实现，
// 能在 Linux/Android（proot）上登个人号。要让桥接搬上手机，网关必须可替换。
//
// 但桥接内部到处在用 `cfg.snowluma.*`。一次性改完风险太大，所以这一层做**兼容归一化**：
//   · 配置可以写成新的 `gateway: { provider, httpUrl, wsUrl, token }`
//   · 桥接仍然读 `cfg.snowluma.*`（由这里把 gateway 映射过去）
//   · 老的 `snowluma.*` 配置继续有效
//
// 另外提供**能力矩阵**：不同网关支持的动作不一样，缺的那部分要显式降级，
// 而不是调用失败后让用户看到一句"未知错误"。

/** 已知网关的默认端点与能力 */
export const GATEWAY_PRESETS = {
  snowluma: {
    label: 'SnowLuma',
    httpUrl: 'http://127.0.0.1:3000',
    wsUrl: 'ws://127.0.0.1:3001',
    capabilities: {
      sendText: true,
      sendImage: true,
      voice: true,
      groupMembers: true,
      // SnowLuma 扩展：系统表情/收藏表情实体、QQ 空间
      faceEntity: true,
      stickers: true,
      qzone: true
    }
  },
  napcat: {
    label: 'NapCatQQ',
    httpUrl: 'http://127.0.0.1:6099',
    wsUrl: 'ws://127.0.0.1:6199',
    capabilities: {
      sendText: true,
      sendImage: true,
      voice: true,
      groupMembers: true,
      // NapCat 有自己的一套实现，这两个 SnowLuma 扩展在它上面不存在
      faceEntity: false,
      stickers: false,
      qzone: false
    }
  }
};

/** 从 URL 里取 host:port，用于写进配置提示 */
function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return String(url || ''); }
}

/**
 * 归一化网关配置。
 *
 * 优先级：`gateway.*`（新写法）> `snowluma.*`（老写法）> 预设默认值。
 *
 * @param {{gateway?:object, snowluma?:object, onebot?:object}} file config.json 原文
 * @returns {{provider:string, label:string, httpUrl:string, wsUrl:string, accessToken:string,
 *            httpToken:string, capabilities:object, legacy:boolean, unknownProvider:boolean}}
 */
export function normalizeGateway(file = {}) {
  const gw = file.gateway && typeof file.gateway === 'object' ? file.gateway : null;
  const legacy = file.snowluma && typeof file.snowluma === 'object' ? file.snowluma : null;
  const onebot = file.onebot && typeof file.onebot === 'object' ? file.onebot : null;

  // provider 判定：显式写 > 有 snowluma 配置就当 snowluma > 默认 snowluma
  const rawProvider = String(gw?.provider || (legacy ? 'snowluma' : 'snowluma')).trim().toLowerCase();
  const known = Object.prototype.hasOwnProperty.call(GATEWAY_PRESETS, rawProvider);
  const preset = GATEWAY_PRESETS[known ? rawProvider : 'snowluma'];

  const httpUrl = String(
    gw?.httpUrl || legacy?.httpUrl || onebot?.http || preset.httpUrl
  ).replace(/\/+$/, '');
  const wsUrl = String(
    gw?.wsUrl || legacy?.wsUrl || onebot?.ws || preset.wsUrl
  ).replace(/\/+$/, '');
  const accessToken = String(gw?.token || gw?.accessToken || legacy?.accessToken || onebot?.token || '');
  const httpToken = String(gw?.httpToken || legacy?.httpToken || onebot?.token || '');

  return {
    provider: known ? rawProvider : rawProvider,
    label: known ? preset.label : `未知网关（${rawProvider}）`,
    httpUrl,
    wsUrl,
    accessToken,
    httpToken,
    // 未知 provider 一律按"能力未知但基础动作可能可用"处理，避免直接禁用
    capabilities: { ...(known ? preset.capabilities : GATEWAY_PRESETS.snowluma.capabilities) },
    legacy: !gw && Boolean(legacy),
    unknownProvider: !known,
    host: hostOf(wsUrl)
  };
}

/**
 * 把归一化结果**映射回桥接现在读的老结构**（cfg.snowluma），保证桥接不用改。
 * @returns {{wsUrl:string, httpUrl:string, accessToken:string, httpToken:string, provider:string, capabilities:object}}
 */
export function toLegacySnowlumaShape(gateway) {
  const gw = gateway || normalizeGateway({});
  return {
    wsUrl: gw.wsUrl,
    httpUrl: gw.httpUrl,
    accessToken: gw.accessToken,
    httpToken: gw.httpToken,
    provider: gw.provider,
    capabilities: gw.capabilities
  };
}

/** 一句话说明哪些能力不可用（控制台/日志用） */
export function describeGatewayLimits(gateway) {
  const caps = gateway?.capabilities || {};
  const labels = {
    faceEntity: '系统表情实体（fetch_face_entity）',
    stickers: '收藏表情同步',
    qzone: 'QQ 空间'
  };
  const missing = Object.entries(labels).filter(([k]) => caps[k] === false).map(([, v]) => v);
  const head = `${gateway?.label || '网关'}（${gateway?.provider || '?'}）@ ${gateway?.host || '?'}`;
  return missing.length ? `${head}：不支持 ${missing.join('、')}` : `${head}：能力完整`;
}
