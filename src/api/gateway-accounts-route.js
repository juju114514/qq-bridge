// GET/POST /api/gateway/accounts —— 网关多账号（0.4.106）
//
// GET  → { ok, accounts:[{uin,httpPort,wsPort,configured,online,nickname,error,active}], binding:{httpUrl,wsUrl}, gatewayDir }
// POST { action:'bind', uin } → 把桥接指向该账号（写 config.json，**重启后生效**）
import { readAccounts, probeAccount, bindAccountToConfig } from '../gateway-accounts.js';

export async function handleGatewayAccountsRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!req || !url || url.pathname !== '/api/gateway/accounts') return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  // 目录来源：deps → 环境变量 → 现读 config.json（cfg 是启动时加载的，可能不含后加字段）
  let gatewayDir = String(d.gatewayConfigDir || process.env.QQB_GATEWAY_CONFIG_DIR || '');
  if (!gatewayDir) {
    try {
      const rawCfg = typeof d.readFile === 'function' ? d.readFile(d.files?.config || '') : '';
      if (rawCfg) {
        const parsed = JSON.parse(String(rawCfg).replace(/^\uFEFF/, ''));
        gatewayDir = String(parsed?.gateway?.configDir || '');
      }
    } catch { /* 读不到就当没配 */ }
  }

  if (req.method === 'GET') {
    if (!gatewayDir) {
      sendJson({ ok: false, error: '未配置网关配置目录：在 config.json 里加 gateway.configDir，或设环境变量 QQB_GATEWAY_CONFIG_DIR', accounts: [] });
      return true;
    }
    const binding = typeof d.getGatewayBinding === 'function' ? (d.getGatewayBinding() || {}) : {};
    const raw = readAccounts(gatewayDir);
    const accounts = [];
    for (const a of raw) {
      const probed = await probeAccount(a);
      const active = Boolean(binding.httpUrl && probed.httpPort && String(binding.httpUrl).endsWith(':' + probed.httpPort));
      accounts.push({ ...probed, active });
    }
    sendJson({ ok: true, accounts, binding, gatewayDir });
    return true;
  }

  if (req.method === 'POST') {
    const body = (await ctx.readBody?.()) || {};
    if (body.action !== 'bind') { sendJson({ ok: false, error: "只支持 action:'bind'" }, 400); return true; }
    const uin = String(body.uin || '').trim();
    const raw = readAccounts(gatewayDir);
    const target = raw.find((a) => String(a.uin) === uin);
    if (!target) { sendJson({ ok: false, error: '没找到这个账号的配置' }, 404); return true; }
    if (!target.configured) { sendJson({ ok: false, error: '这个账号没配 OneBot 端口（在网关里先给它开 http/ws）' }, 400); return true; }
    const configFile = d.files?.config || '';
    if (!configFile) { sendJson({ ok: false, error: '找不到 config.json' }, 500); return true; }
    try {
      const next = bindAccountToConfig(configFile, target);
      sendJson({ ok: true, uin, binding: next, note: '已写入 config.json；**重启桥接后生效**（排错程序 → 停止 → 一键拉起）' });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
    }
    return true;
  }

  sendJson({ ok: false, error: '只支持 GET / POST' }, 405);
  return true;
}
