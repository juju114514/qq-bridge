// 原子写：**全仓唯一实现**。
//
// 为什么必须唯一（这是同源分叉 AI-group-friends 用一条守卫换来的结论）：
// 规矩写在注释里拦不住下一份抄写 —— 他们历史上先后有 6 处各自重抄了「写 tmp → rename」，
// 其中 2 处用的还是被注释点名禁止的**固定临时名**（并发/符号链接攻击面）。
// 所以除了这个文件，`scripts/check-atomic-write.mjs` 不允许其它地方出现 renameSync/写 .tmp。
//
// 三个细节都是踩出来的：
//   1. 临时名必须**唯一**（pid + 随机串）：固定名在并发写同一文件时会互相覆盖/删掉对方的临时文件
//   2. rename 覆盖"正被别的进程打开"的目标，在 Windows 上会抛 EPERM/EBUSY/EACCES
//      （Defender / 编辑器 / 资源管理器预览 / 云同步都可能在这窗口里碰它）→ 必须退避重试
//   3. 失败要把临时文件删掉，别在 state/ 里堆垃圾
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 原子替换：带退避重试，直到 EPERM/EBUSY/EACCES 消失或次数用尽。
 */
export function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      // 同步忙等一小会儿：调用点大多在启动/收尾路径，不值得为它改成异步。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

/** 先写唯一临时文件再 rename：进程中断也不会写坏目标文件。 */
export function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

/** 原子写文本文件（同上，内容原样写入）。 */
export function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}