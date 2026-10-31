// 空间相关的四个端点统一入口（0.4.82）
//
// 为什么单独一个文件：console-extra-routes 有行数棘轮，而空间这块还会继续长
// （草稿 / 上传 / 删除 / 以后的定时发）。把它们收在一个"空间域"入口里，
// 调用侧永远只有一行。
import { handleQzoneDraftRoute } from './qzone-draft-route.js';
import { handleQzoneUploadsRoute } from './qzone-uploads-route.js';
import { handleQzoneDeleteRoute } from './qzone-delete-route.js';

export async function handleQzoneEndpoints(ctx = {}) {
  const shared = { req: ctx.req, url: ctx.url, sendJson: ctx.sendJson, readBody: ctx.readBody, deps: ctx.deps };
  if (await handleQzoneDraftRoute(shared)) return true;
  if (await handleQzoneUploadsRoute(shared)) return true;
  if (await handleQzoneDeleteRoute(shared)) return true;
  return false;
}
