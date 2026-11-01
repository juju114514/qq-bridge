// 环境感知（0.4.103）：时间桶 / 天气码 / 缓存新鲜度 / 兜底不抛
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import(new URL('../src/environment.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('时段：凌晨 / 早上 / 上午 / 中午 / 下午 / 晚上 / 深夜', () => {
  assert.equal(m.dayPhase(3), '凌晨');
  assert.equal(m.dayPhase(7), '早上');
  assert.equal(m.dayPhase(10), '上午');
  assert.equal(m.dayPhase(12), '中午');
  assert.equal(m.dayPhase(15), '下午');
  assert.equal(m.dayPhase(20), '晚上');
  assert.equal(m.dayPhase(23), '深夜');
});

check('时间行：含月日 / 星期 / 时分 / 时段', () => {
  const line = m.timeLine(Date.parse('2026-11-01T21:30:00+08:00'));
  assert.match(line, /11月1日/);
  assert.match(line, /周[日一二三四五六]/);
  assert.match(line, /（(晚上|深夜)）/);
});

check('天气码翻译（open-meteo 的 WMO 码）', () => {
  assert.equal(m.weatherCodeToText(0), '晴');
  assert.equal(m.weatherCodeToText(3), '阴');
  assert.equal(m.weatherCodeToText(63), '下雨');
  assert.equal(m.weatherCodeToText(95), '雷雨');
  assert.equal(m.weatherCodeToText('x'), '');
});

check('天气行：有描述有温度；空数据返回空串（不塞假话）', () => {
  assert.equal(m.weatherLine({ desc: '阴', temp: 18.4 }), '外面 阴 18℃');
  assert.equal(m.weatherLine({ code: 0, temp: 25 }), '外面 晴 25℃');
  assert.equal(m.weatherLine(null), '');
  assert.equal(m.weatherLine({}), '');
});

check('合并行：没天气只给时间', () => {
  const withW = m.environmentLine({ now: Date.parse('2026-11-01T21:30:00+08:00'), weather: { desc: '小雨', temp: 16 }, cityName: '杭州' });
  assert.match(withW, /^现在：/);
  assert.match(withW, /杭州 外面 小雨 16℃/);
  const noW = m.environmentLine({ now: Date.parse('2026-11-01T21:30:00+08:00') });
  assert.match(noW, /^现在：/);
  assert.ok(!noW.includes('外面'));
});

check('缓存：写入 → 读回 → 判断新鲜度', () => {
  const f = path.join(os.tmpdir(), `wx-${process.pid}-${Date.now()}.json`);
  const now = Date.parse('2026-11-01T21:30:00+08:00');
  assert.equal(m.writeWeatherCache(f, { temp: 20, code: 3 }, now), true);
  const c = m.readWeatherCache(f);
  assert.equal(c.temp, 20);
  assert.equal(m.cacheFresh(c, now + 10 * 60000), true);
  assert.equal(m.cacheFresh(c, now + 40 * 60000), false);
  fs.rmSync(f, { force: true });
  assert.equal(m.readWeatherCache(f), null);
  assert.equal(m.cacheFresh(null), false);
});

check('解析 open-meteo 响应 + 拼 URL', () => {
  const parsed = m.parseOpenMeteo({ current: { temperature_2m: 17.6, weather_code: 61 } });
  assert.equal(Math.round(parsed.temp), 18);
  assert.equal(parsed.code, 61);
  assert.equal(m.parseOpenMeteo({}), null);
  assert.match(m.meteoUrl({ lat: 30.27, lon: 120.15 }), /latitude=30\.27&longitude=120\.15/);
  assert.equal(m.meteoUrl({}), '');
});

check('脏数据不炸', () => {
  assert.deepEqual(m.readWeatherCache(path.join(os.tmpdir(), 'nope-not-here.json')), null);
  assert.equal(m.weatherLine({ temp: 'abc' }), '');
  assert.match(m.timeLine(NaN), /^现在|月/);
});

check('中国气象局：now 解析（实况温度/湿度/风）', () => {
  const j = { data: { location: { name: '杭州' }, now: { temperature: 15.6, humidity: 94, windDirection: '东北风', windScale: '微风', precipitation: 1.4 } } };
  const r = m.parseCmaNow(j);
  assert.equal(r.temp, 15.6);
  assert.equal(r.cityName, '杭州');
  assert.equal(r.windScale, '微风');
  assert.equal(m.parseCmaNow({}), null);
});

check('中国气象局：daily 解析（今天白天文字 + 高低温）', () => {
  const j = { data: { daily: [{ date: '2026/11/01', dayText: '小雨', nightText: '小雨', high: 28, low: 15 }] } };
  const r = m.parseCmaDaily(j);
  assert.equal(r.dayText, '小雨');
  assert.equal(r.high, 28);
  assert.equal(m.parseCmaDaily({ data: { daily: [] } }), null);
});

check('中国气象局：天气行「外面 小雨 16℃（今天 15~28℃）」', () => {
  const line = m.cmaWeatherLine({ temp: 15.6 }, { dayText: '小雨', high: 28, low: 15 });
  assert.equal(line, '外面 小雨 16℃（今天 15~28℃）');
  assert.equal(m.cmaWeatherLine(null, { dayText: '晴' }), '外面 晴');
  assert.equal(m.cmaWeatherLine(null, null), '');
});

check('中国气象局：城市搜索解析（"58457|杭州|Hangzhou|中国"）', () => {
  const list = m.parseCmaSearch({ data: ['58457|杭州|Hangzhou|中国', 'bad'] });
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { id: '58457', name: '杭州', en: 'Hangzhou' });
  assert.deepEqual(m.parseCmaSearch({}), []);
});

check('中国气象局：URL 拼装 + 站点号校验', () => {
  assert.match(m.cmaNowUrl('58457'), /\/api\/now\/58457$/);
  assert.match(m.cmaDailyUrl('58457'), /stationid=58457/);
  assert.match(m.cmaSearchUrl('杭州'), /q=%E6%9D%AD%E5%B7%9E/);
  assert.equal(m.cmaNowUrl('bad id'), '');
  assert.equal(m.cmaSearchUrl(''), '');
});

check('环境行：优先用源给的 line（气象局）而不是 code 翻译', () => {
  const line = m.environmentLine({ now: Date.parse('2026-11-01T21:30:00+08:00'), weather: { line: '外面 小雨 16℃（今天 15~28℃）', cityName: '杭州' } });
  assert.match(line, /杭州 外面 小雨 16℃/);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
