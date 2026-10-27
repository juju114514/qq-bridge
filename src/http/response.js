/**
 * HTTP 响应工具（控制台与智能体接口共用）。
 *
 * 为什么单独一层：这些字符串与头是**安全语义**的一部分（CSP、X-Frame-Options、no-store），
 * 散落在 bridge.js 的 11k 行里没人敢动。集中后再改就是改一处、测一处。
 *
 * 约束（审计 harness 会把本文件搬进 node:vm 执行）：
 *   · 不 import 任何东西（跨模块引用在 VM 里解析不到）
 *   · 无顶层 await
 */

/** 所有响应都带的硬化头。改这里等于改整个对外面，别顺手删。 */
export const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** JSON 响应（带硬化头）。缩进 2 空格是控制台 fixture 与手工 curl 都依赖的既有形状。
 *  命名用 writeJson 而不是 sendJson：bridge 里有个长期存在的局部 `sendJson(obj, status)`
 *  绑定在当前 res 上，两者同名会在 VM 注入后互相遮住。 */
export function writeJson(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  res.end(JSON.stringify(obj, null, 2));
}

/** HTML 响应（首页 / 401 提示页）。 */
export function writeHtml(res, html, status = 200) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(html);
}

/** 无正文响应（favicon 用 204，避免浏览器把它当 401 噪音）。 */
export function writeEmpty(res, status = 204) {
  res.writeHead(status, SECURITY_HEADERS);
  res.end();
}

/**
 * 把「一个拒绝动作」落到响应上。
 * prelude 只负责**判定**（返回 { status, json|html|empty }），落盘交给这里，
 * 这样判定逻辑可以在没有真实 res 的测试里跑。
 */
export function applyDenial(res, denial) {
  if (!denial) return;
  if (denial.json !== undefined) {
    writeJson(res, denial.json, denial.status ?? 200);
    return;
  }
  if (denial.html !== undefined) {
    writeHtml(res, denial.html, denial.status ?? 200);
    return;
  }
  writeEmpty(res, denial.status ?? 204);
}
