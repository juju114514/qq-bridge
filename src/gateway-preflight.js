// 网关启动自检（0.5.60）
//
// 真实事故（2026-11-04）：配置里 `gateway.provider=napcat`，机器上真正在跑的却是
// SnowLuma（3000/3001）。桥接于是每秒连一个不存在的端口，日志刷满「WS 断开」，
// 用户以为程序坏了 —— 其实只要跑一次 `node scripts/doctor-gateway.mjs --fix`。
//
// 这个模块只做一件事：启动时探一下端口，如果「配置指向的网关没在听、另一个在听」，
// 就往日志里写一句能直接照做的提示。不自动改配置（改配置这种事交给 doctor 命令）。
import net from 'node:net';

const PRESET_PORTS = {
  snowluma: { http: 3000, ws: 3001, webui: 5099 },
  napcat: { http: 6198, ws: 6199, webui: 6099 },
};

/** 单端口探测，失败不抛 */
export function probePort(port, host = '127.0.0.1', timeoutMs = 600) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, host);
  });
}

/**
 * 从配置里推断「配置指向谁」以及「实际谁在听」。
 * @param {{gateway?:object, snowluma?:object}} cfg
 * @returns {Promise<{configured:string, running:string[], configuredUp:boolean, hint:string}>}
 */
export async function checkGatewayPreflight(cfg = {}) {
  const gw = cfg.gateway || {};
  const legacy = cfg.snowluma || {};
  const configured = String(gw.provider || 'snowluma').toLowerCase();

  const running = [];
  for (const [provider, ports] of Object.entries(PRESET_PORTS)) {
    // 只看 ws 端口：它是桥接真正要连的那条
    if (await probePort(ports.ws)) running.push(provider);
  }

  const configuredUp = running.includes(configured);
  let hint = '';
  if (!running.length) {
    hint = '没有检测到任何 OneBot 网关（SnowLuma 3001 / NapCat 6199 都没在听）。先启动网关，再跑 node scripts/doctor-gateway.mjs 看具体原因。';
  } else if (!configuredUp) {
    hint = `配置写的网关是 ${configured}，但实际在听的是 ${running.join('/')}。`
      + `跑一次 node scripts/doctor-gateway.mjs --fix 可以自动改配置（会先备份），然后重启桥接。`;
  }
  return { configured, running, configuredUp, hint };
}

/** 启动时调用：只在有问题时写日志，正常就安静 */
export async function logGatewayPreflight(cfg, log = () => {}) {
  try {
    const r = await checkGatewayPreflight(cfg);
    if (r.hint) {
      log(`⚠️ 网关自检：${r.hint}`);
    }
    return r;
  } catch {
    return { configured: '', running: [], configuredUp: true, hint: '' };
  }
}
