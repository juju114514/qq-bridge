// 登录网络环境探测（0.4.141）
//
// 为什么需要：网易云/QQ音乐的登录接口会对**出口 IP** 做风控。
// 实测（2026-11-02）：走日本机房出口时，扫码返回 8821、发短信直接回「您当前的网络环境存在安全风险」；
// 关掉代理走国内出口后，同一套代码扫码立刻 803 成功。
//
// 所以控制台里必须把"我现在从哪个国家/地区出去"显示出来 —— 否则用户只会看到一句
// 莫名其妙的"网络环境存在安全风险"，完全不知道该改什么。
const CACHE_MS = 5 * 60 * 1000;

let cache = { at: 0, value: null };

/**
 * @param {{fetchImpl?:Function, now?:Function, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, ip?:string, country?:string, city?:string, org?:string, cn?:boolean, error?:string}>}
 */
export async function probeEgress(opts = {}) {
  const { fetchImpl = (...a) => fetch(...a), now = () => Date.now(), timeoutMs = 6000 } = opts;
  if (cache.value && now() - cache.at < CACHE_MS) return cache.value;

  try {
    const res = await fetchImpl('https://ipinfo.io/json', {
      headers: { 'user-agent': 'qq-bridge/egress-probe' },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store'
    });
    const j = await res.json();
    const country = String(j?.country || '').toUpperCase();
    const value = {
      ok: Boolean(j?.ip),
      ip: String(j?.ip || ''),
      country,
      city: String(j?.city || ''),
      org: String(j?.org || ''),
      cn: country === 'CN',
      at: now()
    };
    cache = { at: now(), value };
    return value;
  } catch (error) {
    // 探测失败不是致命问题：不回缓存，下次再试
    return { ok: false, error: String(error?.message ?? error).slice(0, 120) };
  }
}

/** 给控制台的一句人话结论 */
export function describeEgress(e) {
  if (!e || !e.ok) return { level: 'warn', text: '探测不到出口 IP（不影响已登录状态）' };
  if (e.cn) {
    return { level: 'ok', text: `出口在中国大陆（${e.city || '未知城市'}），登录不受网络环境影响` };
  }
  return {
    level: 'error',
    text: `出口在 ${e.country || '境外'}${e.city ? '（' + e.city + '）' : ''} —— 网易云/QQ音乐会判定网络环境异常：`
      + '扫码大概率返回 8821，发短信会直接提示"网络环境存在安全风险"。请关闭代理/VPN，'
      + '或给 music.163.com、y.qq.com 加直连规则后重试'
  };
}

/** 测试用：清缓存 */
export function resetEgressCache() {
  cache = { at: 0, value: null };
}
