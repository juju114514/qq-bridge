// GET/POST /api/environment —— 环境感知（时间/天气）（0.4.103）
//
// GET  → { ok, line, config, weather }
// POST { action:'refresh' } | { enabled, city:{name,lat,lon}, tzOffsetMinutes } → 改配置并刷新
export async function handleEnvironmentRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!req || !url) return false;
  const isMain = url.pathname === '/api/environment';
  const isAreas = url.pathname === '/api/environment/areas';
  const isResolve = url.pathname === '/api/environment/resolve';
  const isDetect = url.pathname === '/api/environment/detect';
  if (!isMain && !isAreas && !isResolve && !isDetect) return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});


  // 按公网 IP 猜城市：只读、要人确认（代理/VPN 会误导）
  if (isDetect && req.method === 'GET') {
    try {
      const geo = typeof d.detectIpCity === 'function' ? await d.detectIpCity() : null;
      if (!geo || !geo.city) { sendJson({ ok: false, error: 'IP 定位没拿到城市' }); return true; }
      let station = null;
      try {
        const list = typeof d.searchCity === 'function' ? (await d.searchCity(geo.city)) : [];
        station = list.find((x) => x.name === geo.city) || list[0] || null;
      } catch { /* 没站点也能只显示城市 */ }
      sendJson({ ok: true, ...geo, station });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) });
    }
    return true;
  }

  // 三级行政区（省 → 地级市 → 区县）：?code= 为空取省列表
  if (isAreas && req.method === 'GET') {
    const code = String(url.searchParams.get('code') || '').trim();
    try {
      const items = typeof d.areaChildren === 'function' ? (await d.areaChildren(code)) : [];
      sendJson({ ok: true, code, level: code ? (code.length === 2 ? 2 : 3) : 1, items });
    } catch (error) {
      sendJson({ ok: true, code, items: [], error: String(error?.message ?? error) });
    }
    return true;
  }

  // 名字 → 气象局站点（选中区县后用名字解析站点号）
  if (isResolve && req.method === 'GET') {
    const name = String(url.searchParams.get('name') || '').trim();
    try {
      const list = typeof d.searchCity === 'function' ? (await d.searchCity(name)) : [];
      const exact = list.filter((x) => x.name === name);
      sendJson({ ok: true, name, station: (exact[0] || list[0] || null), candidates: list });
    } catch (error) {
      sendJson({ ok: true, name, station: null, candidates: [], error: String(error?.message ?? error) });
    }
    return true;
  }

  if (isMain && req.method === 'GET' && url.searchParams.get('q')) {
    const q = String(url.searchParams.get('q') || '').trim();
    try {
      const list = typeof d.searchCity === 'function' ? (await d.searchCity(q)) : [];
      sendJson({ ok: true, query: q, candidates: list });
    } catch (error) {
      sendJson({ ok: true, query: q, candidates: [], error: String(error?.message ?? error) });
    }
    return true;
  }

  if (isMain && req.method === 'GET') {
    let line = '';
    try { line = typeof d.getEnvironmentLine === 'function' ? String(d.getEnvironmentLine() || '') : ''; } catch { line = ''; }
    sendJson({ ok: true, line, config: (typeof d.getEnvConfig === 'function' ? d.getEnvConfig() : {}) || {} });
    return true;
  }

  if (isMain && req.method === 'POST') {
    const body = (await ctx.readBody?.()) || {};
    try {
      if (body.action === 'refresh') {
        if (typeof d.refreshEnvironment === 'function') await d.refreshEnvironment();
      } else {
        const patch = {};
        if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
        if (body.tzOffsetMinutes !== undefined && Number.isFinite(Number(body.tzOffsetMinutes))) patch.tzOffsetMinutes = Number(body.tzOffsetMinutes);
        if (body.stationId !== undefined) patch.stationId = String(body.stationId || '').trim();
        if (body.city && typeof body.city === 'object') {
          const name = String(body.city.name || '').trim();
          patch.city = {
            ...(name ? { name } : {}),
            lat: body.city.lat === '' || body.city.lat === null ? null : Number(body.city.lat),
            lon: body.city.lon === '' || body.city.lon === null ? null : Number(body.city.lon)
          };
        }
        if (typeof d.setEnvConfig === 'function') d.setEnvConfig(patch);
        if (typeof d.refreshEnvironment === 'function') await d.refreshEnvironment();
      }
      let line = '';
      try { line = typeof d.getEnvironmentLine === 'function' ? String(d.getEnvironmentLine() || '') : ''; } catch { line = ''; }
      sendJson({ ok: true, line, config: (typeof d.getEnvConfig === 'function' ? d.getEnvConfig() : {}) || {} });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
    }
    return true;
  }

  sendJson({ ok: false, error: '只支持 GET / POST' }, 405);
  return true;
}
