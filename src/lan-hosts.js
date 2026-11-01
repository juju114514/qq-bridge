// 局域网访问的白名单（0.4.109）
//
// 为什么需要：控制台默认只监听 127.0.0.1，而 prelude 的 Host 头校验只放行回环 ——
// 手机/模拟器用 `192.168.1.2:3100` 访问会被 403（"Host 头不被允许"）。
// 要支持手机，必须两件事一起做：
//   1) 监听改成 0.0.0.0（config.consoleHost）
//   2) Host 白名单加上本机所有私有 IPv4 + 用户配置的额外 host
//
// 安全边界不变：**仍然必须带控制台令牌**。这里只解决"能不能连上"。
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];

/** 判断是否私有网段（10/8、172.16/12、192.168/16、100.64/10 也放进来给 Tailscale 用） */
export function isPrivateIPv4(ip) {
  const s = String(ip || '');
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;   // Tailscale / CGNAT
  return false;
}

/** 从 os.networkInterfaces() 的结果里挑出私有 IPv4 */
export function privateIPv4s(interfaces = {}, { includeLoopback = false } = {}) {
  const out = [];
  for (const list of Object.values(interfaces || {})) {
    for (const info of Array.isArray(list) ? list : []) {
      if (!info || info.internal) continue;
      const family = info.family === 'IPv4' || info.family === 4;
      if (!family) continue;
      const ip = String(info.address || '');
      if (!includeLoopback && !isPrivateIPv4(ip)) continue;
      if (!out.includes(ip)) out.push(ip);
    }
  }
  return out;
}

/** 组装 Host 白名单：回环 + 私有 IP + 额外配置，统一带端口、统一小写 */
export function hostAllowList({ port, interfaces = {}, extra = [] } = {}) {
  const hosts = [...LOOPBACK];
  for (const ip of privateIPv4s(interfaces)) hosts.push(ip);
  for (const h of Array.isArray(extra) ? extra : []) {
    const v = String(h || '').trim();
    if (v) hosts.push(v);
  }
  return hosts
    .map((h) => h.toLowerCase())
    .map((h) => (h.includes(']') ? `${h}:${port}` : (h.includes(':') ? h : `${h}:${port}`)))
    .filter((v, i, arr) => arr.indexOf(v) === i);
}
