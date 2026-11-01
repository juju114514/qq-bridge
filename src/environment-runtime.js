// 环境感知（时间 + 天气）的取数、配置与注入（0.4.104）
//
// 单独成文件：天气要发网络请求、要缓存、要失败兜底，塞进 bridge 会撑爆行数棘轮。
// 对外：
//   getEnvironmentLine()          给提示词的一行
//   refreshWeather()              拉一次天气（30 分钟缓存）
//   searchCity(q)                 城市搜索（中国气象局 autocomplete）
//   config() / setConfig()        读/写环境配置（state/env-config.json）
//
// 数据源优先级：中国气象局（weather.cma.cn）→ open-meteo（经纬度）→ 只用时间。
import fs from 'node:fs';
import path from 'node:path';
import {
  environmentLine, readWeatherCache, writeWeatherCache, cacheFresh,
  cmaNowUrl, cmaDailyUrl, cmaSearchUrl, parseCmaNow, parseCmaDaily, parseCmaSearch, cmaWeatherLine,
  meteoUrl, parseOpenMeteo, WEATHER_TTL_MS
} from './environment.js';

const CMA_HEADERS = { referer: 'https://weather.cma.cn/', accept: 'application/json' };

export function createEnvironment({ cacheFile, configFile, getConfig, log = () => {} } = {}) {
  let inFlight = null;

  function readOwnConfig() {
    try {
      return JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')) || {};
    } catch {
      return {};
    }
  }

  function writeOwnConfig(next) {
    try {
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      const tmp = `${configFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      // guard-allow: renameSync 写 state/env-config.json，本文件刻意不引入 atomicWriteJson
      //（它要读取 config 才能工作，会形成启动期的循环依赖）
      fs.renameSync(tmp, configFile);
      return true;
    } catch {
      return false;
    }
  }

  function config() {
    const own = readOwnConfig();
    const src = (own && typeof own === 'object' && Object.keys(own).length) ? own : {};
    const city = src.city && typeof src.city === 'object' ? src.city : {};
    return {
      enabled: src.enabled !== false,
      stationId: String(src.stationId || '').trim(),
      cityName: String(city.name || src.cityName || '').trim(),
      lat: city.lat,
      lon: city.lon,
      tzOffsetMinutes: Number.isFinite(Number(src.tzOffsetMinutes)) ? Number(src.tzOffsetMinutes) : null
    };
  }

  function setConfig(patch) {
    const own = readOwnConfig();
    const next = { ...own, ...(patch || {}), city: { ...(own.city || {}), ...((patch && patch.city) || {}) } };
    writeOwnConfig(next);
    // 换了城市/源 → 丢掉旧缓存，否则会继续显示上一个地方的天气
    try { fs.rmSync(cacheFile, { force: true }); } catch { /* 没缓存就算了 */ }
    return config();
  }

  function cachedWeather() {
    return readWeatherCache(cacheFile) || null;
  }

  async function fetchJson(url, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: CMA_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchCma(stationId) {
    const nowUrl = cmaNowUrl(stationId);
    const dayUrl = cmaDailyUrl(stationId);
    if (!nowUrl) return null;
    const [nowJson, dayJson] = await Promise.all([
      fetchJson(nowUrl).catch(() => null),
      dayUrl ? fetchJson(dayUrl).catch(() => null) : null
    ]);
    const now = parseCmaNow(nowJson);
    const daily = parseCmaDaily(dayJson);
    if (!now && !daily) return null;
    return { source: 'cma', line: cmaWeatherLine(now, daily), now, daily, at: Date.now() };
  }

  async function fetchMeteo({ lat, lon }) {
    const url = meteoUrl({ lat, lon });
    if (!url) return null;
    const parsed = parseOpenMeteo(await fetchJson(url));
    if (!parsed) return null;
    return { source: 'open-meteo', ...parsed, at: Date.now() };
  }

  async function refreshWeather({ force = false } = {}) {
    const c = config();
    if (!c.enabled) return null;
    const hit = cachedWeather();
    if (!force && cacheFresh(hit, Date.now(), WEATHER_TTL_MS)) return hit;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        let weather = null;
        if (c.stationId) {
          try { weather = await fetchCma(c.stationId); } catch (e) { log(`[env] 气象局源失败：${e?.message ?? e}`); }
        }
        if (!weather && (c.lat != null || c.lon != null)) {
          try { weather = await fetchMeteo({ lat: c.lat, lon: c.lon }); } catch (e) { log(`[env] open-meteo 失败：${e?.message ?? e}`); }
        }
        if (weather) {
          writeWeatherCache(cacheFile, weather);
          return weather;
        }
        return cachedWeather();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function searchCity(query) {
    const url = cmaSearchUrl(query);
    if (!url) return [];
    try {
      return parseCmaSearch(await fetchJson(url));
    } catch (error) {
      log(`[env] 城市搜索失败：${error?.message ?? error}`);
      return [];
    }
  }

  async function getEnvironmentLine() {
    const c = config();
    if (!c.enabled) return '';
    let weather = cachedWeather();
    if (!cacheFresh(weather)) {
      const fresh = await refreshWeather();
      if (fresh) weather = fresh;
    }
    return environmentLine({ now: Date.now(), weather, tzOffsetMinutes: c.tzOffsetMinutes, cityName: c.cityName });
  }

  return { getEnvironmentLine, refreshWeather, searchCity, config, setConfig, cacheFile, configFile };
}
