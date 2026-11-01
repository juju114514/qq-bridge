// 运行报告（0.4.74）—— 一条命令/一个按钮，把"它现在到底好不好"变成可以贴给别人的文本
//
// 为什么要有：
//   · 别人装完出问题，第一句话是"你那边什么情况"—— 我们要能一键给出一份**脱敏后的**报告
//   · 远程服务器更新前后，各存一份，就是最直接的前后对比证据
//   · 比"看日志"低门槛：每条检查都带 ✅/⚠️/❌ 和一句人话
//
// 纯函数：输入普通数据，输出 Markdown。便于单测，也便于以后导出成别的格式。

const DAY = 24 * 60 * 60 * 1000;

/** 脱敏：长数字（QQ 号/openid）、16 位以上十六进制、绝对路径、常见密钥形态 */
export function redact(text, { repoPath = '' } = {}) {
  let s = String(text ?? '');
  if (repoPath) {
    const esc = repoPath.replace(/[\\/]+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(esc, 'gi'), '<repo>');
  }
  s = s.replace(/\b\d{6,}\b/g, (m) => `${m.slice(0, 3)}****${m.slice(-2)}`);
  s = s.replace(/\b[0-9A-Fa-f]{16,}\b/g, (m) => `${m.slice(0, 4)}…(${m.length}位)`);
  s = s.replace(/\b(sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/g, '<token>');
  return s;
}

function fmtDur(ms) {
  const n = Math.max(0, Number(ms) || 0);
  const d = Math.floor(n / DAY);
  const h = Math.floor((n % DAY) / 3600000);
  const m = Math.floor((n % 3600000) / 60000);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * @param {object} p
 * @param {string} p.version
 * @param {string} p.buildId
 * @param {{pid:number, uptimeMs:number, rssMb:number, heapMb:number, startedAt?:number}} p.processInfo
 * @param {{dsh:string, gateway:string, official:string}} p.services
 * @param {{restarts24h:number, exits24h:number, lastExit?:{code:number,at:number}, watchdog24h:number, watchdogLatest?:{at:number,text:string}}} p.supervisor
 * @param {{disconnects?:number, lastRecoverAt?:number}} p.gatewayStats
 * @param {{runs:number, errors:number, lastError?:string}} p.messages
 * @param {{freeGb:number, totalGb:number, path:string}} p.disk
 * @param {{mode:string, ownerQQ:string, groups:number, privates:number, officialEnabled:boolean, officialProbe:boolean}} p.configSummary
 * @param {string} p.repoPath 用于脱敏
 * @param {number} p.now
 */
import { judgeRestarts } from './restart-classify.js';

export function buildReport({
  restartEvents = [],
  plannedRestarts = [],
  version = '',
  buildId = '',
  processInfo = {},
  services = {},
  supervisor = {},
  gatewayStats = {},
  messages = {},
  disk = null,
  bootWatch = null,
  configSummary = {},
  repoPath = '',
  now = Date.now()
} = {}) {
  // 默认参数只兜 undefined，不兜 null —— 这里统一归一化（脏数据不能把报告打挂）
  processInfo = processInfo || {};
  services = services || {};
  supervisor = supervisor || {};
  gatewayStats = gatewayStats || {};
  messages = messages || {};
  configSummary = configSummary || {};

  const checks = [];
  const add = (level, title, detail) => checks.push({ level, title, detail });

  // —— 判定规则（每条都对应一句"该怎么看"）——
  const uptimeMs = Number(processInfo.uptimeMs) || 0;
  const days = uptimeMs / DAY;
  if (days >= 7) add('ok', `连续运行 ${fmtDur(uptimeMs)}`, '超过 7 天，稳定性有实据');
  else if (days >= 3) add('ok', `连续运行 ${fmtDur(uptimeMs)}`, '超过 3 天；建议观察满 7 天再对外说"稳定"');
  else if (days >= 1) add('warn', `连续运行 ${fmtDur(uptimeMs)}`, '不足 3 天，暂时只能算"跑起来了"');
  else add('warn', `连续运行 ${fmtDur(uptimeMs)}`, '运行不足 1 天，只能说"跑起来了"，还谈不上稳定');

  // 重启（0.4.102）：先扣掉"计划内（部署/手动）"再判（判定逻辑在 restart-classify.js）
  const restarts = Number(supervisor.restarts24h) || 0;
  const restartVerdict = judgeRestarts(restarts, plannedRestarts, now);
  if (restartVerdict.level) add(restartVerdict.level, restartVerdict.title, restartVerdict.detail);

  const gw = String(services.gateway || 'unknown');
  if (gw === 'connected') add('ok', '网关已连接', 'QQ 侧收发正常');
  else add('bad', `网关 ${gw}`, '网关没连上 → 打开 5099 扫码；桥接会自动重连，不用重启');

  const dsh = String(services.dsh || 'unknown');
  if (dsh === 'connected') add('ok', 'DSH 已连接', 'AI 侧正常');
  else add('bad', `DSH ${dsh}`, '检查 DSH 是否在运行、是否登录');

  const wd = Number(supervisor.watchdog24h) || 0;
  if (wd === 0) add('ok', '看门狗 24h 无事件', '没有任何健康告警');
  else add('warn', `看门狗 24h ${wd} 条事件`, supervisor.watchdogLatest?.text ? `最近一条：${String(supervisor.watchdogLatest.text).slice(0, 80)}` : '看事件时间线');

  const rss = Number(processInfo.rssMb) || 0;
  if (rss > 0 && rss < 800) add('ok', `内存 ${rss} MB`, '正常水位');
  else if (rss < 1600) add('warn', `内存 ${rss} MB`, '偏高；观察是否持续增长（可能是泄漏）');
  else add('bad', `内存 ${rss} MB`, '过高，建议重启并抓一次 heap 快照');

  if (disk && Number.isFinite(disk.freeGb)) {
    if (disk.freeGb < 2) add('bad', `磁盘剩余 ${disk.freeGb} GB`, '空间不足会导致写日志/状态失败');
    else if (disk.freeGb < 5) add('warn', `磁盘剩余 ${disk.freeGb} GB`, '偏紧，建议清理');
    else add('ok', `磁盘剩余 ${disk.freeGb} GB`, '充足');
  }

  const errs = Number(messages.errors) || 0;
  if (errs === 0) add('ok', '近期无消息错误', '');
  else add('warn', `近期消息错误 ${errs} 条`, messages.lastError ? `最近一条：${String(messages.lastError).slice(0, 80)}` : '');

  // 断电 / 异常关机（0.4.84）：这一项专门解释"为什么刚启动却说没重启过"。
  // 断电时 runner 和看门狗都被一起干掉，24h 重启次数是 0 —— 只看那个数会误判。
  if (bootWatch) {
    const n7 = Number(bootWatch.incidents7d) || 0;
    if (bootWatch.uncleanThisBoot && bootWatch.thisBoot) {
      const desc = typeof bootWatch.describe === 'function' ? bootWatch.describe(bootWatch.thisBoot) : '';
      add('warn', '本次启动前是非正常关闭', desc || '断电 / 蓝屏 / 强杀都会这样（runner 来不及记录退出）');
    } else if (n7 >= 3) {
      add('bad', `近 7 天非正常关闭 ${n7} 次`, '频繁掉电或系统不稳，建议查供电/系统日志');
    } else if (n7 >= 1) {
      add('warn', `近 7 天非正常关闭 ${n7} 次`, '偶发；看下面「异常关机」小节的时间点');
    } else {
      add('ok', '近期没有异常关机', '每次退出都有干净标记');
    }
  }

  const overall = checks.some((c) => c.level === 'bad') ? 'FAIL'
    : checks.some((c) => c.level === 'warn') ? 'WARN' : 'PASS';
  const icon = { ok: '✅', warn: '⚠️', bad: '❌' };

  const L = [];
  L.push('# qq-bridge 运行报告');
  L.push('');
  L.push(`- 生成时间：${fmtTime(now)}`);
  L.push(`- 版本：${version || '?'}${buildId ? `（${buildId.slice(0, 24)}…）` : ''}`);
  L.push(`- 进程：pid ${processInfo.pid ?? '?'} · 已运行 ${fmtDur(uptimeMs)}（启动于 ${fmtTime((processInfo.startedAt || (now - uptimeMs)))}）`);
  L.push(`- 总体判定：**${overall}**`);
  L.push('');
  L.push('## 一、检查结论');
  L.push('');
  L.push('| | 检查 | 说明 |');
  L.push('| --- | --- | --- |');
  for (const c of checks) L.push(`| ${icon[c.level]} | ${c.title} | ${c.detail || '—'} |`);
  L.push('');

  L.push('## 二、通道');
  L.push('');
  L.push('| 通道 | 状态 |');
  L.push('| --- | --- |');
  L.push(`| DSH | ${dsh} |`);
  L.push(`| 网关（QQ） | ${gw}${gatewayStats.disconnects ? `（累计断开 ${gatewayStats.disconnects} 次，最近恢复 ${fmtTime(gatewayStats.lastRecoverAt)}）` : ''} |`);
  L.push(`| 官方通道 | ${services.official || 'unknown'} |`);
  L.push('');

  L.push('## 三、稳定性');
  L.push('');
  L.push(`- 24h 重启：${restarts} 次 / 退出：${Number(supervisor.exits24h) || 0} 次`);
  L.push(`- 最近一次退出：${supervisor.lastExit ? `code=${supervisor.lastExit.code}（${fmtTime(supervisor.lastExit.at)}）` : '无记录'}`);
  L.push(`- 看门狗事件（24h）：${wd} 条`);
  L.push(`- 内存：RSS ${rss} MB · heap ${Number(processInfo.heapMb) || 0} MB`);
  if (disk) L.push(`- 磁盘：${disk.freeGb} GB 可用 / ${disk.totalGb} GB 总计`);
  L.push('');

  if (bootWatch && (bootWatch.uncleanThisBoot || (Number(bootWatch.incidents7d) || 0) > 0)) {
    L.push('## 三·五、异常关机');
    L.push('');
    if (bootWatch.uncleanThisBoot && bootWatch.thisBoot) {
      const b = bootWatch.thisBoot;
      L.push(`- 本次启动前**非正常关闭**：最后一次心跳 ${fmtTime(b.lastSeenAt)}，断档约 ${Math.round((Number(b.gapMs) || 0) / 60000)} 分钟`);
      L.push('  （断电/蓝屏/强杀时会这样：runner 与看门狗一起被干掉，所以「24h 重启」不会记到这次）');
    }
    const recent = Array.isArray(bootWatch.recent) ? bootWatch.recent.slice(0, 5) : [];
    if (recent.length) {
      L.push(`- 近 7 天非正常关闭 **${Number(bootWatch.incidents7d) || 0}** 次，最近几次：`);
      for (const it of recent) {
        const desc = typeof bootWatch.describe === 'function' ? bootWatch.describe(it) : '';
        L.push(`  - ${fmtTime(it.at)}${desc ? ' —— ' + desc : ''}`);
      }
    }
    L.push('');
  }

  L.push('## 四、配置摘要（已脱敏）');
  L.push('');
  L.push(`- 运行模式：${configSummary.mode || '?'}`);
  L.push(`- 管理员：${configSummary.ownerQQ ? String(configSummary.ownerQQ).slice(0, 3) + '****' : '（未配置）'}`);
  L.push(`- 白名单：群 ${configSummary.groups ?? 0} 个 / 私聊 ${configSummary.privates ?? 0} 个`);
  L.push(`- 官方通道：${configSummary.officialEnabled ? '启用' : '未启用'} · 探针标记 ${configSummary.officialProbe ? '有' : '无'}`);
  L.push('');

  L.push('## 五、怎么用这份报告');
  L.push('');
  L.push('- 贴给别人排查前，先确认没有需要保密的内容（本报告已做基础脱敏）');
  L.push('- 更新前后各存一份，对比「版本 / 重启次数 / 通道状态」三项就够判断有没有回归');
  L.push('- 判定为 FAIL 时，优先看「通道」小节：多半是网关没登录或 DSH 没起来');
  L.push('');

  const markdown = redact(L.join('\n'), { repoPath });
  return { overall, checks, markdown };
}
