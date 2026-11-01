// 环境感知：时间 + 天气（0.4.104）
//
// 起因：刷到一个 DSH 同栈作品（抖音「番狗炒茄蛋」的"大肥鱼的家"），作者要接
// "窗外与我同步的实时天气"。我们一开始接的是 open-meteo（国外源），
// 用户随后要求换成**国内官方源**——"天气时间可以用国家的那种，方便准确"。
// 所以现在优先用 **中国气象局（weather.cma.cn）**：
//   · now 接口给实况温度/湿度/风
//   · view 接口给今天白天/夜间的天气文字与高低温
//   · autocomplete 给城市搜索（用户不用自己查站点号）
// 拿不到再退回 open-meteo（按经纬度），最后只留时间。
//
// 设计取舍：
//   · 天气会失败（断网/接口挂），**永远有兜底**：拿不到就只注入时间，不抛错、不编
//   · 缓存 30 分钟（天气没必要每条消息拉一次）
//   · 不猜城市、不做 IP 定位：城市由用户搜一次并保存
import fs from 'node:fs';
import path from 'node:path';

export const WEATHER_TTL_MS = 30 * 60 * 1000;
export const CMA_BASE = 'https://weather.cma.cn';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 一天里的口语化时段 */
export function dayPhase(hour) {
  const h = Number(hour);
  if (h < 5) return '凌晨';
  if (h < 9) return '早上';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 22) return '晚上';
  return '深夜';
}

/** 「现在是 11月1日 周日 21:30（晚上）」 */
export function timeLine(now = Date.now(), tzOffsetMinutes = null) {
  const d = new Date(Number(now) || Date.now());
  let hour = d.getHours();
  let minute = d.getMinutes();
  if (Number.isFinite(tzOffsetMinutes)) {
    const utc = d.getTime() + d.getTimezoneOffset() * 60000;
    const shifted = new Date(utc + Number(tzOffsetMinutes) * 60000);
    hour = shifted.getHours();
    minute = shifted.getMinutes();
  }
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const wd = WEEKDAYS[d.getDay()] || '';
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${month}月${day}日 ${wd} ${hh}:${mm}（${dayPhase(hour)}）`;
}

// ── 中国气象局（主源）──────────────────────────────────────────────

export function cmaNowUrl(stationId) {
  const id = String(stationId || '').trim();
  if (!/^[A-Za-z0-9]{3,8}$/.test(id)) return '';
  return `${CMA_BASE}/api/now/${id}`;
}

export function cmaDailyUrl(stationId) {
  const id = String(stationId || '').trim();
  if (!/^[A-Za-z0-9]{3,8}$/.test(id)) return '';
  return `${CMA_BASE}/api/weather/view?stationid=${id}`;
}

export function cmaSearchUrl(query) {
  const q = String(query || '').trim();
  if (!q) return '';
  return `${CMA_BASE}/api/autocomplete?q=${encodeURIComponent(q)}`;
}

/** now 接口 → 实况 */
export function parseCmaNow(json) {
  try {
    const now = json?.data?.now;
    if (!now) return null;
    const loc = json?.data?.location || {};
    return {
      temp: Number(now.temperature),
      humidity: Number(now.humidity),
      windDir: String(now.windDirection || ''),
      windScale: String(now.windScale || ''),
      precip: Number(now.precipitation),
      cityName: String(loc.name || ''),
      at: Date.now()
    };
  } catch {
    return null;
  }
}

/** view 接口 → 今天白天/夜间天气与高低温 */
export function parseCmaDaily(json) {
  try {
    const daily = json?.data?.daily;
    if (!Array.isArray(daily) || !daily.length) return null;
    const d0 = daily[0] || {};
    return {
      dayText: String(d0.dayText || ''),
      nightText: String(d0.nightText || ''),
      high: Number(d0.high),
      low: Number(d0.low),
      date: String(d0.date || '')
    };
  } catch {
    return null;
  }
}

/** autocomplete → [{id,name,en}]（每条形如 "58457|杭州|Hangzhou|中国"） */
export function parseCmaSearch(json) {
  try {
    const list = json?.data;
    if (!Array.isArray(list)) return [];
    return list.map((line) => {
      const [id, name, en] = String(line).split('|');
      return { id: String(id || ''), name: String(name || ''), en: String(en || '') };
    }).filter((x) => x.id && x.name);
  } catch {
    return [];
  }
}

/** 「外面 小雨 16℃（今天 15~28℃）」 */
export function cmaWeatherLine(now, daily) {
  if (!now && !daily) return '';
  const parts = [];
  const text = String(daily?.dayText || '').trim();
  const temp = Number(now?.temp);
  if (text) parts.push(text);
  if (Number.isFinite(temp)) parts.push(`${Math.round(temp)}℃`);
  let line = parts.length ? `外面 ${parts.join(' ')}` : '';
  const hi = Number(daily?.high);
  const lo = Number(daily?.low);
  if (Number.isFinite(hi) && Number.isFinite(lo)) {
    line += `${line ? '（' : '外面 '}今天 ${Math.round(lo)}~${Math.round(hi)}℃）`;
  }
  return line;
}

// ── open-meteo（退路，按经纬度）──────────────────────────────────────

/** WMO weather_code → 中文短句 */
export function weatherCodeToText(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return '';
  if (c === 0) return '晴';
  if (c === 1) return '晴间多云';
  if (c === 2) return '多云';
  if (c === 3) return '阴';
  if (c === 45 || c === 48) return '有雾';
  if (c >= 51 && c <= 57) return '毛毛雨';
  if (c >= 61 && c <= 67) return '下雨';
  if (c >= 71 && c <= 77) return '下雪';
  if (c >= 80 && c <= 82) return '阵雨';
  if (c >= 85 && c <= 86) return '阵雪';
  if (c >= 95) return '雷雨';
  return '';
}

/** 「外面 阴 18℃」——拿不到就返回空串（不塞假话） */
export function weatherLine(weather) {
  if (!weather || typeof weather !== 'object') return '';
  const desc = String(weather.desc || '') || weatherCodeToText(weather.code);
  const temp = Number(weather.temp);
  if (!desc && !Number.isFinite(temp)) return '';
  const parts = [];
  if (desc) parts.push(desc);
  if (Number.isFinite(temp)) parts.push(`${Math.round(temp)}℃`);
  return `外面 ${parts.join(' ')}`;
}

export function meteoUrl({ lat, lon }) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return '';
  return `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&current=temperature_2m,weather_code&timezone=auto`;
}

export function parseOpenMeteo(json) {
  try {
    const cur = json?.current;
    if (!cur) return null;
    return { temp: Number(cur.temperature_2m), code: Number(cur.weather_code), at: Date.now() };
  } catch {
    return null;
  }
}

// ── 合并与缓存 ────────────────────────────────────────────────────────

/** 最终注入提示词的那一句（没有天气就只给时间） */
export function environmentLine({ now = Date.now(), weather = null, tzOffsetMinutes = null, cityName = '' } = {}) {
  const t = timeLine(now, tzOffsetMinutes);
  const w = String(weather?.line || '') || weatherLine(weather);
  const city = String(cityName || weather?.cityName || '').trim();
  const head = `现在：${t}`;
  if (!w) return head;
  return `${head}；${city ? city + ' ' : ''}${w}`;
}

export function readWeatherCache(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

export function writeWeatherCache(file, weather, now = Date.now()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...weather, at: Number(now) }));
    return true;
  } catch {
    return false;
  }
}

export function cacheFresh(cache, now = Date.now(), ttlMs = WEATHER_TTL_MS) {
  if (!cache || typeof cache !== 'object') return false;
  const at = Number(cache.at || 0);
  if (!at) return false;
  return Math.abs(Number(now) - at) <= ttlMs;
}
