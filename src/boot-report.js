// 结构化启动/关闭摘要（0.4.42）。
//
// 由来：启动原来是 11 行散日志，出问题只能靠肉眼拼时间线。
// 现在每个阶段记一条 {name, status, durationMs}，最后打一行机器可读 JSON：
//   {"event":"startup.summary", bootId, version, buildId, sourceCommit, process, channel, services, live, ready, startupDurationMs, stages}
//
// 两条硬规则：
//   1. **启动中途失败也要留证**：打印 startup.failed / startup.incomplete，而不是"没走到摘要所以没日志"
//   2. **绝不打印凭证**：只记 buildId / ownerId / epoch 这类标识，不碰 token / secret / cookie
import crypto from 'node:crypto';

export function createBootReport({ log = () => {}, version = '', buildId = '', sourceCommit = '' } = {}) {
  const bootId = crypto.randomBytes(4).toString('hex');
  const startedAt = Date.now();
  /** @type {Array<{name: string, status: string, durationMs: number, detail?: string}>} */
  const stages = [];
  const stageStart = new Map();
  let open = false;

  function begin(name) {
    if (!name) return;
    stageStart.set(name, Date.now());
    open = true;
  }

  function end(name, status = 'ok', detail = '') {
    const t0 = stageStart.get(name) ?? Date.now();
    stages.push({ name, status, durationMs: Math.max(0, Date.now() - t0), ...(detail ? { detail } : {}) });
    stageStart.delete(name);
  }

  /** 一步到位：自动计时。失败时 status 传 failed 并带 detail。 */
  function step(name, fn) {
    begin(name);
    try {
      const out = fn();
      end(name, 'ok');
      return out;
    } catch (error) {
      end(name, 'failed', String(error?.message ?? error).slice(0, 120));
      throw error;
    }
  }

  let meta = { version, buildId, sourceCommit };
  let summarized = false;

  /** 指纹算出来之后回填（version/buildId 在创建时还拿不到）。 */
  function setMeta(next = {}) {
    meta = { ...meta, ...next };
  }

  function snapshot(extra = {}) {
    const now = Date.now();
    return {
      event: 'startup.summary',
      bootId,
      version: meta.version || '',
      buildId: meta.buildId || '',
      sourceCommit: meta.sourceCommit || '',
      startupDurationMs: Math.max(0, now - startedAt),
      ...extra,
    };
  }

  /** 成功摘要：调用方给 process/channel/services/live/ready。 */
  function summary(extra = {}) {
    if (summarized) return null;
    summarized = true;
    const payload = snapshot(extra);
    payload.stages = stages.slice();
    log('启动摘要：' + JSON.stringify(payload));
    return payload;
  }

  /** 失败/不完整摘要：**即使没走到最后也要留证**。 */
  function incomplete(reason, extra = {}) {
    const payload = snapshot({
      event: 'startup.incomplete',
      reason: String(reason ?? '').slice(0, 200),
      ...extra,
    });
    payload.stages = stages.slice();
    // 对未结束的阶段补一条 aborted，避免"卡在哪一步"看不出来
    for (const name of stageStart.keys()) {
      payload.stages.push({ name, status: 'aborted', durationMs: Math.max(0, Date.now() - (stageStart.get(name) ?? Date.now())) });
    }
    log('启动不完整：' + JSON.stringify(payload));
    return payload;
  }

  function shutdown(extra = {}) {
    const payload = snapshot({ event: 'shutdown.summary', ...extra });
    log('关闭摘要：' + JSON.stringify(payload));
    return payload;
  }

  return { bootId, begin, end, step, setMeta, summary, incomplete, shutdown, stages, get summarized() { return summarized; }, get open() { return open; } };
}
