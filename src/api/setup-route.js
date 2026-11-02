// 新手向导（0.4.124）
//
// 为什么单独一页：控制台现在有 20+ 个页面，新人进来不知道点哪。
// 这一页只做一件事：把这台机器当前"能不能跑"逐条列出来，并给出下一步该点哪。
//
// 数据全部只读：不写配置、不启动服务、不发消息。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LEVEL = { ok: 'ok', warn: 'warn', fail: 'fail' };

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/**
 * @param {{stateDir:string, configPath:string, version:string, services?:object, t2iCdp?:string}} opts
 */
async function collectSetupStatus(opts = {}) {
  const {
    stateDir = 'state',
    configPath = 'config.json',
    version = '',
    services = {},
    t2iCdp = 'http://127.0.0.1:9222'
  } = opts;

  const checks = [];
  const push = (id, level, title, detail, hint = '') => checks.push({ id, level, title, detail, hint });

  // 1) Node 版本
  const major = Number(String(process.versions.node).split('.')[0]);
  if (major >= 20) push('node', LEVEL.ok, 'Node 运行时', `v${process.versions.node}`);
  else push('node', LEVEL.fail, 'Node 太旧', `v${process.versions.node}（需要 ≥ 20）`, '升级 Node，或换用绿色整合包（自带运行时）');

  // 2) 配置文件
  const cfg = readJson(configPath);
  if (!cfg) {
    push('config', LEVEL.fail, '没有 config.json', `找不到或解析失败：${configPath}`,
      '点「生成配置」从 config.example.json 复制一份，或在绿色包里双击「启动.cmd」让它自己建');
  } else {
    const missing = [];
    if (!cfg.dsh || !Object.keys(cfg.dsh || {}).length) missing.push('dsh');
    if (!cfg.snowluma) missing.push('snowluma');
    const hasTokenFile = exists(path.join(stateDir, 'console-token'));
    if (!cfg.consoleToken && !hasTokenFile) {
      push('consoleToken', LEVEL.warn, '控制台令牌', '还没生成（首次启动会自动写 state/console-token）', '启动一次桥接即可');
    }
    push('config', missing.length ? LEVEL.warn : LEVEL.ok, '配置文件',
      missing.length ? `config.json 存在，但缺：${missing.join(' / ')}` : 'config.json 正常',
      missing.length ? '在控制台「调试与运维」里补齐，或参考 config.example.json' : '');
  }

  // 3) state 目录
  const tokenFile = path.join(stateDir, 'console-token');
  if (exists(tokenFile)) {
    push('state', LEVEL.ok, '本地数据', `state/ 就绪（令牌文件在）`);
  } else {
    push('state', LEVEL.warn, '还没启动过', 'state/ 里没有 console-token —— 说明桥接还没成功跑过一次',
      '双击「排错程序.exe」→「一键拉起」，或跑 start-bridge.ps1');
  }

  // 4) DSH / 网关（来自桥接自身状态）
  push('dsh', services.dsh ? LEVEL.ok : LEVEL.fail, 'DeepSeek Harness',
    services.dsh ? String(services.dsh) : '未连接',
    services.dsh ? '' : '确认 DSH 已启动并登录；桥接会自动探测端口');
  push('snowluma', services.snowluma ? LEVEL.ok : LEVEL.warn, 'QQ 网关（SnowLuma）',
    services.snowluma ? String(services.snowluma) : '未连接',
    services.snowluma ? '' : '只要官方通道或网关其中一个通，就能收发消息');

  // 5) 官方通道（可选）
  const official = cfg?.official?.enabled ? String(services.official || 'enabled') : '未启用';
  push('official', cfg?.official?.enabled ? LEVEL.ok : LEVEL.warn, '官方机器人通道', official,
    cfg?.official?.enabled ? '' : '可选：想用官方机器人就填 AppID/Secret，或扫码绑定');

  // 6) 渲染侧车（可选）
  let cdpOk = false;
  try {
    const res = await fetch(`${t2iCdp.replace(/\/+$/, '')}/json/version`, { signal: AbortSignal.timeout(800) });
    cdpOk = res.ok;
  } catch { cdpOk = false; }
  push('t2i', cdpOk ? LEVEL.ok : LEVEL.warn, '长文本转图侧车',
    cdpOk ? '已就绪（CDP :9222）' : '未运行',
    cdpOk ? '' : '可选：跑 scripts/t2i-sidecar.ps1 后，长回复才会转成卡片图');

  // 7) 平台说明
  push('platform', LEVEL.ok, '运行环境', `${process.platform} ${os.release()}`, '');

  const failing = checks.filter((c) => c.level === LEVEL.fail).length;
  const warning = checks.filter((c) => c.level === LEVEL.warn).length;
  return {
    ok: failing === 0,
    version,
    firstRun: !exists(tokenFile),
    summary: failing ? `${failing} 项必须先解决` : (warning ? `${warning} 项可选` : '全部就绪'),
    checks
  };
}

/** GET /api/setup/status */
export async function handleSetupStatusRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!url || url.pathname !== '/api/setup/status' || req.method !== 'GET') return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const data = await collectSetupStatus({
    stateDir: d.stateDir || path.join(process.cwd(), 'state'),
    configPath: d.configPath || path.join(process.cwd(), 'config.json'),
    version: d.version || '',
    services: {
      dsh: d.isDshReady ? (d.isDshReady() ? 'ready' : 'connecting') : '',
      snowluma: d.getGatewayState ? String(d.getGatewayState() ?? '') : '',
      official: d.getOfficialStatus ? String(d.getOfficialStatus() ?? '') : ''
    }
  });
  sendJson(data);
  return true;
}
