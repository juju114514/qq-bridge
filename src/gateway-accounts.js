// 网关多账号（0.4.106）
//
// 用户发现：SnowLuma 可以同时注入两个号，问"控制台要不要适配，识别当前已注入账号，然后选择查看每个账号"。
//
// 事实（本机实测）：
//   · SnowLuma 每个账号一个配置文件 `config/onebot_<uin>.json`
//   · 每个账号可以有自己的 httpServers / wsServers（端口、token）
//   · 目前只有 3976372760 配了端口（3000/3001），1599683156 那份 networks 是空的
//
// 我们能做的是"**看见并选择**"，不是"同时驱动"：
//   · 看：枚举 config/onebot_*.json，逐个打 get_login_info 确认在线与昵称
//   · 选：把桥接的 snowluma.httpUrl/wsUrl 指向某个账号（**需要重启桥接才生效**）
//   · 不做的：一个桥接进程同时接两个账号 —— 状态/会话/主人都是单份的，混在一起会串台
import fs from 'node:fs';
import path from 'node:path';

/** 从 onebot_<uin>.json 里解析出账号与端口 */
export function parseOnebotConfig(json, fileName = '') {
  const uinFromName = (String(fileName).match(/onebot_(\d{5,})/) || [])[1] || '';
  const j = json && typeof json === 'object' ? json : {};
  const nets = j.networks && typeof j.networks === 'object' ? j.networks : {};
  const httpServers = Array.isArray(nets.httpServers) ? nets.httpServers : [];
  const wsServers = Array.isArray(nets.wsServers) ? nets.wsServers : [];
  const http = httpServers[0] || null;
  const ws = wsServers[0] || null;
  return {
    uin: uinFromName,
    httpPort: http ? Number(http.port) : null,
    wsPort: ws ? Number(ws.port) : null,
    httpToken: http ? String(http.accessToken || '') : '',
    configured: Boolean(http || ws)
  };
}

/** 列出所有账号配置（不联网） */
export function readAccounts(configDir) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(configDir).filter((n) => /^onebot_\d+\.json$/.test(n));
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8').replace(/^\uFEFF/, ''));
      out.push({ ...parseOnebotConfig(json, name), file: name });
    } catch {
      out.push({ uin: (name.match(/onebot_(\d+)/) || [])[1] || '', configured: false, file: name, broken: true });
    }
  }
  return out.sort((a, b) => String(a.uin).localeCompare(String(b.uin)));
}

/** 探一个账号：POST get_login_info（同时证明 端口通 + token 对 + 已登录） */
export async function probeAccount(account, { timeoutMs = 4000 } = {}) {
  if (!account || !account.httpPort) return { ...account, online: false, error: '未配置端口' };
  const url = `http://127.0.0.1:${account.httpPort}/get_login_info`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        ...(account.httpToken ? { authorization: `Bearer ${account.httpToken}` } : {})
      },
      body: '{}'
    });
    if (!res.ok) return { ...account, online: false, error: `HTTP ${res.status}` };
    const j = await res.json();
    const data = j && j.data ? j.data : {};
    return {
      ...account,
      online: true,
      uin: String(data.user_id || account.uin),
      nickname: String(data.nickname || '')
    };
  } catch (error) {
    return { ...account, online: false, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/** 把桥接 config.json 的 snowluma 指向某个账号（写盘，重启生效） */
export function bindAccountToConfig(configFile, account) {
  const raw = fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '');
  const cfg = JSON.parse(raw);
  const host = '127.0.0.1';
  cfg.snowluma = cfg.snowluma && typeof cfg.snowluma === 'object' ? cfg.snowluma : {};
  if (account.httpPort) cfg.snowluma.httpUrl = `http://${host}:${account.httpPort}`;
  if (account.wsPort) cfg.snowluma.wsUrl = `ws://${host}:${account.wsPort}`;
  const tmp = `${configFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  // 写 config.json 沿用既有的 tmp+rename 约定；本模块刻意不引入 atomicWriteJson
  // guard-allow: renameSync 目标就是 config.json，与其它配置写入保持同一套做法
  fs.renameSync(tmp, configFile);
  return { httpUrl: cfg.snowluma.httpUrl, wsUrl: cfg.snowluma.wsUrl };
}
