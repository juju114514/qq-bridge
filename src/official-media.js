// 官方 QQ 机器人：富媒体（图片/语音/视频）的请求构造helper。
//
// 为什么单独一个模块：
//   官方 API 发多媒体是**两步**（先上传拿 file_info，再发 msg_type=7 的消息），
//   而且字段名很容易记错。把纯构造逻辑抽出来，可以离线测试，不必真连 QQ。
//
// 协议要点（依据官方文档 2026-10 版，两条链接已核对）：
//   · 富媒体概述：先上传拿 file_info → 发消息 msg_type=7 + media.file_info
//     https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html
//   · 群聊上传接口：POST /v2/groups/{group_openid}/files
//     https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html
//
//   1) POST /v2/groups/{group_openid}/files   （单聊用 /v2/users/{user_openid}/files）
//      body: { file_type, url? , file_data?, srv_send_msg: false }
//        file_type: 1=图片 2=视频 3=语音 4=文件
//        用 file_data 传 base64（本地文件走这条），用 url 传可公网访问的地址
//      → 返回 { file_uuid, file_info, ttl }
//   2) POST /v2/groups/{group_openid}/messages
//      body: { msg_type: 7, media: { file_info }, msg_id?, msg_seq? }
//
// 注意：被动回复（msg_id）仍然受"5 分钟 / 最多 5 条"限制；
//       主动发多媒体同样要过配额，所以调用方仍需走 QuotaBook。

export const OFFICIAL_FILE_TYPE = Object.freeze({ image: 1, video: 2, voice: 3, file: 4 });
export const OFFICIAL_MSG_TYPE_MEDIA = 7;
// 二进制直传（file_data）上限：文档明确 **5MB 以内**，超过要走 URL 或分片上传。
export const DIRECT_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
// 图片软限制 20MB / 硬限制 200MB（URL 上传或分片上传时适用）。
export const IMAGE_SOFT_LIMIT_BYTES = 20 * 1024 * 1024;
export const IMAGE_HARD_LIMIT_BYTES = 200 * 1024 * 1024;
// 兼容旧名
export const DEFAULT_MEDIA_MAX_BYTES = DIRECT_UPLOAD_MAX_BYTES;

/** 从魔数猜图片 mime（官方只接受常见格式，猜错会被拒）。 */
export function sniffImageMime(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return '';
}

/**
 * 构造上传体。用 buffer 时走 file_data（base64）；用 url 时直接给 url。
 * 两者必须二选一 —— 同时给会被官方拒绝。
 */
export function buildUploadBody({ fileType, buffer = null, url = '', fileName = '', srSendMsg = false } = {}) {
  const type = Number(fileType);
  if (!Object.values(OFFICIAL_FILE_TYPE).includes(type)) {
    throw new Error(`file_type 非法：${fileType}`);
  }
  const hasBuffer = Buffer.isBuffer(buffer) && buffer.length > 0;
  const hasUrl = String(url ?? '').trim() !== '';
  if (hasBuffer === hasUrl) throw new Error('buffer / url 必须二选一');

  const body = { file_type: type, srv_send_msg: srSendMsg === true };
  if (hasBuffer) {
    // 官方：二进制上传时 file_name 必填（分片合并同样必填）
    const name = String(fileName ?? '').trim();
    if (!name) throw new Error('二进制上传必须给 fileName（官方要求 file_name）');
    body.file_name = name;
    body.file_data = buffer.toString('base64');
  } else {
    body.url = String(url).trim();
  }
  return body;
}

/** 构造发送体：msg_type=7 + media.file_info；被动回复带 msg_id/msg_seq。 */
export function buildMediaMessage({ fileInfo, msgId = '', msgSeq = 0, content = '' } = {}) {
  if (!fileInfo) throw new Error('fileInfo 不能为空');
  const body = { msg_type: OFFICIAL_MSG_TYPE_MEDIA, media: { file_info: String(fileInfo) } };
  // 文本可作为附言一起发（官方允许 content 与 media 并存）
  if (String(content ?? '').trim()) body.content = String(content);
  if (msgId) { body.msg_id = String(msgId); body.msg_seq = Number(msgSeq) || 1; }
  return body;
}

/**
 * 官方对图片格式的说法**前后不一致**：
 *   · 富媒体概述页写「jpg/png/gif/webp/bmp，发送后直接展示」
 *   · 上传接口页与限制表只写「png / jpg」
 * 保守策略：png/jpg 直接发；gif/webp 标记 risky（可能 850019 不支持格式），
 * 调用方可选择先转成 png 再发。
 */
export const OFFICIAL_SAFE_IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg']);
export const OFFICIAL_RISKY_IMAGE_MIMES = Object.freeze(['image/gif', 'image/webp']);

/** 体积/格式闸门：不合格就返回原因，让调用方降级成文本。 */
export function checkImageForOfficial(buffer, { maxBytes = DEFAULT_MEDIA_MAX_BYTES } = {}) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (!b.length) return { ok: false, reason: 'empty' };
  if (b.length > maxBytes) return { ok: false, reason: `too-large:${b.length}>${maxBytes}` };
  const mime = sniffImageMime(b);
  if (!mime) return { ok: false, reason: 'unsupported-format' };
  const risky = OFFICIAL_RISKY_IMAGE_MIMES.includes(mime);
  return { ok: true, mime, bytes: b.length, risky, hint: risky ? 'gif/webp 在官方接口上可能被拒（850019），建议转 png' : '' };
}

/** 从上传响应里取 file_info —— 官方不同版本字段位置略有差异，这里做兼容。 */
export function pickFileInfo(res) {
  if (!res || typeof res !== 'object') return '';
  return String(res.file_info ?? res.fileInfo ?? res?.data?.file_info ?? '');
}
