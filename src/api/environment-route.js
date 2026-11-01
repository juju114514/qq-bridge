// GET/POST /api/environment —— 环境感知（时间/天气）（0.4.103）
//
// GET  → { ok, line, config, weather }
// POST { action:'refresh' } | { enabled, city:{name,lat,lon}, tzOffsetMinutes } → 改配置并刷新
export async function handleEnvironmentRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!req || !url || url.pathname !== '/api/environment') return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});

  if (req.method === 'GET' && url.searchParams.get('q')) {
    const q = String(url.searchParams.get('q') || '').trim();
    try {
      const list = typeof d.searchCity === 'function' ? (await d.searchCity(q)) : [];
      sendJson({ ok: true, query: q, candidates: list });
    } catch (error) {
      sendJson({ ok: true, query: q, candidates: [], error: String(error?.message ?? error) });
    }
    return true;
  }

  if (req.method === 'GET') {
    let line = '';
    try { line = typeof d.getEnvironmentLine === 'function' ? String(d.getEnvironmentLine() || '') : ''; } catch { line = ''; }
    sendJson({ ok: true, line, config: (typeof d.getEnvConfig === 'function' ? d.getEnvConfig() : {}) || {} });
    return true;
  }

  if (req.method === 'POST') {
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
          patch.city = {
            name: String(body.city.name || '').trim(),
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
