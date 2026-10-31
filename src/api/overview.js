// 总览仪表盘端点（GET /api/overview）：只负责接线，纯函数在 src/overview-build.js。
import { buildOverview } from '../overview-build.js';

export function createOverviewHandler(deps = {}) {
  const { sendJson, log = () => {} } = deps;
  return {
    async handle() {
      try {
        sendJson(buildOverview(deps));
      } catch (error) {
        log(`[overview] 组装失败：${error?.message ?? error}`);
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return true;
    }
  };
}
