// 定时任务引擎的**单例**入口。
//
// 为什么单独一个文件：引擎内部持有状态机与定时器，
//   · 控制台路由（/api/scheduler）要用它
//   · QQ 里的 /提醒 命令也要用它
// 两处必须拿到**同一个实例**，否则会出现"控制台建的任务，命令里看不到"。
//
// 依赖只在第一次调用时注入（之后的 deps 忽略），因为状态机只能初始化一次。

import { createScheduler } from './engine.js';

let instance = null;

export function getSchedulerInstance(getDeps) {
  if (instance) return instance;
  const deps = typeof getDeps === 'function' ? getDeps() : (getDeps || {});
  const {
    stateDir = '',
    getCfg = () => ({}),
    deliverPrompt = async () => {},
    allowed = () => false,
    log = () => {}
  } = deps;

  const cfgOf = () => getCfg() || {};
  const ownerKey = () => {
    const owner = String(cfgOf().ownerQQ ?? '').trim();
    return owner ? `private:${owner}` : '';
  };

  instance = createScheduler({
    file: `${stateDir}/scheduler.json`,
    ownerKey,
    log,
    // 引擎约定：返回**错误字符串**（空 = 通过）
    validateTarget(key) {
      const m = /^(group|private):(\d{5,12})$/.exec(String(key ?? ''));
      if (!m) return '发送对象格式应为 group:<群号> 或 private:<QQ号>';
      if (key === ownerKey()) return '';
      return allowed(m[1], Number(m[2]), cfgOf()) ? '' : '目标不在白名单内（定时任务不给陌生人发消息）';
    },
    // 引擎调用约定：deliver(task, target, meta)
    deliver: async (task, target) => {
      try {
        if (task?.kind === 'ai') {
          const instruction = String(task.instruction ?? '').trim();
          if (!instruction) return { ok: false, reason: 'empty' };
          await deliverPrompt(target, `【定时任务：${task.name || '提醒'}】\n${instruction}`);
          return { ok: true };
        }
        const text = String(task?.text ?? '').trim();
        if (!text) return { ok: false, reason: 'empty' };
        await deliverPrompt(target, text);
        return { ok: true };
      } catch (error) {
        log(`定时任务投递失败 ${target}：${error?.message ?? error}`);
        return { ok: false, reason: String(error?.message ?? error) };
      }
    }
  });
  return instance;
}

/** 测试用：清掉单例。 */
export function resetSchedulerInstance() { instance = null; }