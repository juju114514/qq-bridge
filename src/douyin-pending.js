// 「要不要下载这条抖音视频」的判断。
//
// 背景：群里贴抖音链接很常见，但下载是**风控高危动作** —— yt-dlp 一开就是几十上百 MB、
// 还可能触发平台风控。所以默认只附元数据（作者/标题/id），
// 只有群友**明确说要视频**（"发视频""放一下""下载这个"）才把上一条链接交给下载通道。
//
// 这里只做两件纯逻辑的事：
//   1 记住每个会话「最近一条抖音链接」（有 TTL，过期就当没提过）
//   2 判断一句话是不是在要视频
// 网络/下载仍由 bridge 原有的 videoLinkToModelParts 负责，本模块不碰。

/** 明确的「要视频」说法。刻意保守：宁可不下，也别把闲聊当成要视频。 */
const DOWNLOAD_PATTERNS = [
  /发(个|一下|个)?视频/,
  /发(过)?来(看看|看)?/,
  /放(一下|个|出来)?(视频|看看)/,
  /下(载|一下|个)(视频|这个|它)?/,
  /传(一下|个)?(视频|这个)?/,
  /我要看(这个|视频|一下)?/,
  /播(一下|放)?(视频|看看)/,
  /看看?(这个|这条)(视频|片子)/,
  /(这个|这条)视频(呢|发我|给我|下)/
];

/** 只是问信息、不该触发的（排除用）。 */
const NEGATIVE_PATTERNS = [
  /别(下|发|放)/,
  /不要(下|发|放)/,
  /不用(下|发|放)/
];

/**
 * 这句话是不是在要视频。
 * @param {string} text
 * @returns {boolean}
 */
export function matchDownloadRequest(text) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 60) return false;      // 太长的是正文，不是一句要求
  if (NEGATIVE_PATTERNS.some((re) => re.test(s))) return false;
  return DOWNLOAD_PATTERNS.some((re) => re.test(s));
}

/**
 * 每个会话记住最近一条抖音链接（默认 30 分钟有效）。
 * @param {number} ttlMs
 */
export function createDouyinPendingStore(ttlMs = 30 * 60 * 1000) {
  const store = new Map();
  return {
    remember(key, info) {
      const url = String(info?.url ?? '').trim();
      if (!url) return;
      store.set(String(key), {
        url,
        id: String(info?.id ?? ''),
        title: String(info?.title ?? '').slice(0, 40),
        at: Date.now()
      });
    },
    /** 过期/没有都返回 null。 */
    take(key) {
      const it = store.get(String(key));
      if (!it) return null;
      if (Date.now() - it.at > ttlMs) {
        store.delete(String(key));
        return null;
      }
      return it;
    },
    size() { return store.size; }
  };
}

/**
 * 群友要视频时，拼给模型看的一行（告诉它用哪条链接、用哪个 mode）。
 * @param {{url:string,title?:string,id?:string}} pending
 */
export function buildDownloadHint(pending) {
  const url = String(pending?.url ?? '').trim();
  if (!url) return '';
  const who = String(pending?.title ?? '').trim();
  const lines = [
    '【群友要视频】上一条抖音链接：' + url,
    who ? '（' + who + '）' : '',
    '后台已经在下载并发到群里了（只下前 180 秒），你不用自己调接口；只回一句自然的、别承诺"马上到"。'
  ];
  return lines.filter(Boolean).join('\n');
}

/** 贴新链接时提醒模型：默认别下。 */
export function buildNoAutoDownloadNote() {
  return '（这条视频默认只取元数据；群友明确说要视频时再下载）';
}
