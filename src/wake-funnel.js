// 唤醒漏斗聚合：把决策链压成「卡在哪一步 + 为什么」。
// 单独成模块的原因：控制台诊断 handler 已经很长，而且这个是纯函数、最好单测。

/**
 * 从决策链聚合「唤醒漏斗」（纯函数，便于单测）。
 *
 * 为什么要这个：`/诊断` 现在给的是一串文本，回答"为什么没回"要人肉翻。
 * 漏斗把每条消息归到「卡在哪一步 + 为什么」，一屏就能看出主要流失点。
 *
 * 口径（与 decision-trace 的 stage/verdict 对齐）：
 *   收到       = 缓冲里所有记录
 *   过闸门     = 有 step 闸门/通过
 *   唤醒命中   = 有 step 唤醒/命中（未命中、已暂停都是流失）
 *   进模型     = 有 step 投递/进模型
 * 注意：缓冲只有最近 N 条（默认 80），所以这是"最近一窗"，不是全量。
 */
export function buildWakeFunnel(decisions = []) {
  const list = Array.isArray(decisions) ? decisions : [];
  // 脏数据（null / 缺 steps / steps 里夹 null）不能让诊断接口 500
  const stepsOf = (rec) => (rec && Array.isArray(rec.steps) ? rec.steps.filter(Boolean) : []);
  const stepOf = (rec, stage) => stepsOf(rec).find((s) => s.stage === stage) || null;

  const total = list.filter((r) => r && typeof r === 'object').length;
  let gatePassed = 0;
  let wakeHit = 0;
  let delivered = 0;
  const reasons = new Map();
  const bump = (text) => {
    const k = String(text || '未标注').trim() || '未标注';
    reasons.set(k, (reasons.get(k) || 0) + 1);
  };

  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    const gate = stepOf(rec, '闸门');
    const wake = stepOf(rec, '唤醒');
    const deliver = stepOf(rec, '投递');
    if (gate && gate.verdict === '通过') gatePassed += 1;
    else if (gate && gate.verdict === '拦截') bump(`闸门：${gate.detail || '拦截'}`);

    if (wake) {
      if (wake.verdict === '命中') wakeHit += 1;
      else if (wake.verdict === '未命中') bump(`唤醒未命中：${wake.detail || '条件未满足'}`);
      else if (wake.verdict === '已暂停') bump('唤醒：AI 已暂停');
    }
    if (deliver) delivered += 1;
    else if (gate && gate.verdict === '通过' && !wake) bump('闸门后未到唤醒（命令/引导类分支）');
  }

  const stages = [
    { stage: '收到', count: total },
    { stage: '过闸门', count: gatePassed },
    { stage: '唤醒命中', count: wakeHit },
    { stage: '进模型', count: delivered }
  ];
  const topReasons = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([text, count]) => ({ text, count }));
  return { total, stages, topReasons };
}
