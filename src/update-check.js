// 版本更新检查（拿 GitHub Releases 的 latest，跟本地 package 版本比一下）。
//
// 为什么要一个独立小模块：
//   · 检查很便宜但**失败很常见**（GitHub 被墙 / 离线 / API 限流 403 / 返回 HTML），
//     所以它必须**永不抛异常**，只回一个带 error 的结果，让调用方决定要不要提示。
//   · 同一进程里可能被多处调用（启动时、控制台刷新）→ 带 TTL 的磁盘缓存，
//     避免反复打 GitHub（未认证 60 次/小时的配额很紧）。
//   · 不允许引第三方依赖：版本比较自己写（见 compareVersions），
//     parseRelease 是纯函数，方便离线测试。
//
// 设计取舍：
//   1. 缓存过期后**不做 stale-while-revalidate**：请求失败就是失败（ok:false），
//      不拿旧缓存冒充成功 —— 否则用户会看到一个"检查过但其实是三天前"的结论。
//   2. 缓存读不到/写不进一律静默降级：缓存只是省流量，不影响检查本身。
//   3. 版本比较只覆盖本仓库会遇到的形态（0.4.113 / v0.4.113 / 0.4.113-beta.1），
//      不是完整 semver 实现；预发布**小于**同号正式版（见 comparePrerelease）。
import fs from 'node:fs';
import { atomicWriteJson } from './atomic-write.js';

const TIMEOUT_MS = 8000;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const UA = 'qq-bridge-update-check';

/** 去掉前导 v/V 与首尾空白（只用于展示与缓存，不改变段数）。 */
function normalizeVersion(input) {
  let raw = String(input ?? '').trim();
  if (raw.startsWith('v') || raw.startsWith('V')) raw = raw.slice(1);
  return raw;
}

/** 拆成 { nums, pre }：nums 是数字段数组（缺失/脏段按 0），pre 是预发布后缀（无则空串）。 */
function parseVersion(input) {
  let raw = normalizeVersion(input);
  // 构建元数据（+20261101）不参与比较
  const plus = raw.indexOf('+');
  if (plus !== -1) raw = raw.slice(0, plus);
  const dash = raw.indexOf('-');
  const core = dash === -1 ? raw : raw.slice(0, dash);
  const pre = (dash === -1 ? '' : raw.slice(dash + 1)).trim();
  const nums = core.split('.').map((seg) => {
    const m = /^\d+/.exec(seg.trim());   // 容忍 '4beta' 这种脏数据
    return m ? Number(m[0]) : 0;
  });
  return { nums, pre };
}

function compareNumberSegments(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;   // 缺失段按 0：'0.4' === '0.4.0'
    const y = b[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 预发布比较（简化 semver）：
 *   · 没有预发布 > 有预发布（0.4.113 > 0.4.113-beta.1）
 *   · 逐标识符比：纯数字按数值，数字 < 字母数字，其余按 ASCII
 *   · 前缀相同则短的更小（beta.2 < beta.2.1）
 */
function comparePrerelease(a, b) {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  const xs = a.split('.');
  const ys = b.split('.');
  const len = Math.min(xs.length, ys.length);
  for (let i = 0; i < len; i += 1) {
    const x = xs[i];
    const y = ys[i];
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) > Number(y) ? 1 : -1;   // beta.10 > beta.2
    if (xNum !== yNum) return xNum ? -1 : 1;                   // 数字 < 字母数字
    return x > y ? 1 : -1;
  }
  if (xs.length === ys.length) return 0;
  return xs.length > ys.length ? 1 : -1;
}

/**
 * 比较两个版本号。
 * @param {string} a
 * @param {string} b
 * @returns {1|0|-1} a 比 b 新 / 相同 / 旧
 */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const core = compareNumberSegments(va.nums, vb.nums);
  if (core !== 0) return core;
  const pre = comparePrerelease(va.pre, vb.pre);
  return pre > 0 ? 1 : pre < 0 ? -1 : 0;
}

/**
 * 从 GitHub Releases API 响应体里解析版本信息（纯函数）。
 * 关键字段只有 tag_name：连它都没有（或不像版本号）就当解析不出来，返回 null。
 * @param {unknown} json
 * @returns {{ latest: string, url: string, publishedAt: string|null, body: string }|null}
 */
export function parseRelease(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const tag = normalizeVersion(json.tag_name);
  if (!tag || !/^\d/.test(tag)) return null;   // 只认以数字开头的 tag
  return {
    latest: tag,
    url: typeof json.html_url === 'string' ? json.html_url : '',
    publishedAt: typeof json.published_at === 'string' ? json.published_at : null,
    body: typeof json.body === 'string' ? json.body : ''
  };
}

/** 把 fetch 抛出的各种错误翻成一句人话（含可操作提示）。 */
function describeFetchError(error, timeoutMs) {
  const name = String(error?.name ?? '');
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `请求超时（${timeoutMs}ms）：GitHub 可能不可达，稍后重试`;
  }
  const code = error?.cause?.code ?? error?.code ?? '';
  const message = error?.message ? String(error.message) : 'unknown error';
  const hint = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT/i.test(message)
    ? '（网络不通或被墙，稍后重试）'
    : '';
  return code && !message.includes(String(code)) ? `${message} [${code}]${hint}` : `${message}${hint}`;
}

/**
 * 工厂：带磁盘缓存与 TTL 的更新检查器。
 * @param {{
 *   currentVersion: string,
 *   repo: string,
 *   fetchImpl?: typeof fetch,
 *   cacheFile?: string,
 *   ttlMs?: number,
 *   log?: (msg: string) => void,
 *   now?: () => number
 * }} opts
 * @returns {{ check: (o?: { force?: boolean }) => Promise<object> }}
 */
export function createUpdateChecker(opts = {}) {
  const {
    currentVersion = '0.0.0',
    repo = '',
    fetchImpl = globalThis.fetch,
    cacheFile = '',
    ttlMs = DEFAULT_TTL_MS,
    log = () => {},
    now = Date.now
  } = opts;

  const current = normalizeVersion(currentVersion) || '0.0.0';

  function readCache() {
    if (!cacheFile) return null;
    try {
      const raw = fs.readFileSync(cacheFile, 'utf8');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return null;
      const latest = normalizeVersion(data.latest);
      if (!latest) return null;
      if (!Number.isFinite(data.at)) return null;
      return {
        at: data.at,
        latest,
        url: typeof data.url === 'string' ? data.url : '',
        publishedAt: typeof data.publishedAt === 'string' ? data.publishedAt : null
      };
    } catch {
      return null;   // 文件不存在 / JSON 坏掉 / 权限问题：都当没缓存
    }
  }

  function writeCache(entry) {
    if (!cacheFile) return;
    try {
      atomicWriteJson(cacheFile, entry);
    } catch (error) {
      log(`[update-check] 缓存写入失败（忽略）：${error?.message ?? error}`);
    }
  }

  function result(patch) {
    return {
      ok: false,
      current,
      latest: null,
      hasUpdate: false,
      url: '',
      publishedAt: null,
      checkedAt: now(),
      cached: false,
      ...patch
    };
  }

  async function check(o = {}) {
    const force = o?.force === true;
    const startedAt = now();

    // 1) 缓存命中（force 时不看缓存）
    if (!force && cacheFile) {
      const hit = readCache();
      const age = hit ? startedAt - hit.at : Infinity;
      if (hit && age < ttlMs) {   // age < 0（时钟回拨）也当新鲜
        return {
          ok: true,
          current,
          latest: hit.latest,
          hasUpdate: compareVersions(hit.latest, current) > 0,
          url: hit.url,
          publishedAt: hit.publishedAt,
          checkedAt: hit.at,
          cached: true
        };
      }
    }

    // 2) 真去问 GitHub
    if (!repo || typeof repo !== 'string') {
      return result({ checkedAt: startedAt, error: '未配置 repo（形如 owner/repo），无法检查更新' });
    }
    if (typeof fetchImpl !== 'function') {
      return result({ checkedAt: startedAt, error: '当前运行环境没有可用的 fetch' });
    }

    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    let response;
    try {
      response = await fetchImpl(apiUrl, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': UA
        },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (error) {
      const message = describeFetchError(error, TIMEOUT_MS);
      log(`[update-check] 请求失败：${message}`);
      return result({ checkedAt: startedAt, error: message });
    }

    if (!response || response.ok !== true) {
      const status = response?.status;
      const error = status === 404
        ? `仓库或 release 不存在（HTTP 404）：${repo}`
        : `GitHub 返回 HTTP ${status ?? '?'}`;
      log(`[update-check] ${error}`);
      return result({ checkedAt: startedAt, error });
    }

    let json;
    try {
      json = await response.json();
    } catch (error) {
      const message = `release 响应不是合法 JSON：${error?.message ?? error}`;
      log(`[update-check] ${message}`);
      return result({ checkedAt: startedAt, error: message });
    }

    const release = parseRelease(json);
    if (!release) {
      log('[update-check] release 响应缺少 tag_name，跳过');
      return result({ checkedAt: startedAt, error: 'release 响应缺少可识别的 tag_name' });
    }

    // 3) 写缓存（失败不影响本次结果）
    writeCache({
      at: startedAt,
      latest: release.latest,
      url: release.url,
      publishedAt: release.publishedAt
    });

    return {
      ok: true,
      current,
      latest: release.latest,
      hasUpdate: compareVersions(release.latest, current) > 0,
      url: release.url,
      publishedAt: release.publishedAt,
      checkedAt: startedAt,
      cached: false
    };
  }

  return { check };
}
