// 中国行政区三级树（省 → 地级市 → 县级市/区）（0.4.105）
//
// 用户："搜索城市、选择站点改成选择，如 省——地级市——县级市，搜索用于辅助"
//
// 数据来源：中国天气网的静态区域表（稳定、无需 key）：
//   city.xml          → 省     01|北京
//   city<省>.xml      → 地级市 0101|北京
//   city<省><市>.xml  → 区县   010101|北京,010102|海淀…
// 天气数据仍走中国气象局（更准），两者用「名字」对上：选定区县后再用
// 气象局的 autocomplete 把名字解析成站点号。
//
// 缓存：内存 + state/area-cache.json（7 天）。取不到就返回空数组，界面自己降级。
import fs from 'node:fs';
import path from 'node:path';

export const AREA_TTL_MS = 7 * 24 * 3600 * 1000;
const BASE = 'http://www.weather.com.cn/data/list3';
const HEADERS = { 'user-agent': 'Mozilla/5.0', referer: 'http://www.weather.com.cn/' };

/** "01|北京,02|上海" → [{code:'01', name:'北京'}, …] */
export function parseAreaList(text) {
  if (!text || typeof text !== 'string') return [];
  return text.split(',')
    .map((chunk) => {
      const [code, name] = chunk.trim().split('|');
      if (!code || !name) return null;
      if (!/^\d{2,6}$/.test(code)) return null;
      return { code, name: name.trim() };
    })
    .filter(Boolean);
}

/** 按 code 长度判断这一层要请求哪个文件 */
export function areaUrl(code) {
  const c = String(code || '').trim();
  if (!c) return `${BASE}/city.xml`;
  if (!/^\d{2,4}$/.test(c)) return '';
  return `${BASE}/city${c}.xml`;
}

export function areaLevel(code) {
  const c = String(code || '').trim();
  if (!c) return 1;
  if (c.length === 2) return 2;
  if (c.length === 4) return 3;
  return 0;
}

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

function writeCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function createAreaTree({ cacheFile, log = () => {}, ttlMs = AREA_TTL_MS } = {}) {
  const memory = new Map();

  function fromDisk(code) {
    try {
      const all = readCache(cacheFile);
      const hit = all[code || 'root'];
      if (!hit || !Array.isArray(hit.items)) return null;
      if (Math.abs(Date.now() - Number(hit.at || 0)) > ttlMs) return null;
      return hit.items;
    } catch {
      return null;
    }
  }

  async function fetchList(code) {
    const url = areaUrl(code);
    if (!url) return [];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // 这个接口有时 utf-8、有时 gbk；先按 utf-8 解，出现替换字符再用 gbk
      let text = buf.toString('utf8');
      if (text.includes('\uFFFD')) {
        try { text = new TextDecoder('gbk').decode(buf); } catch { /* 保持 utf8 结果 */ }
      }
      return parseAreaList(text);
    } finally {
      clearTimeout(timer);
    }
  }

  async function children(code = '') {
    const key = code || 'root';
    if (memory.has(key)) return memory.get(key);
    const disk = fromDisk(code);
    if (disk) { memory.set(key, disk); return disk; }
    try {
      const items = await fetchList(code);
      if (items.length) {
        memory.set(key, items);
        const all = readCache(cacheFile);
        all[code || 'root'] = { at: Date.now(), items };
        writeCache(cacheFile, all);
      }
      return items;
    } catch (error) {
      log(`[area] 取 ${code || '省列表'} 失败：${error?.message ?? error}`);
      return [];
    }
  }

  /** 在整棵树里按名字找路径（搜索辅助用）：返回 {code, name} 链路，找不到返回 [] */
  async function findPath(name) {
    const target = String(name || '').trim();
    if (!target) return [];
    const provinces = await children('');
    for (const p of provinces) {
      if (p.name === target) return [p];
      const cities = await children(p.code);
      for (const c of cities) {
        if (c.name === target) return [p, c];
        const counties = await children(c.code);
        const hit = counties.find((x) => x.name === target);
        if (hit) return [p, c, hit];
      }
    }
    return [];
  }

  return { children, findPath };
}
