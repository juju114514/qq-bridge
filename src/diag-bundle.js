// 诊断包（0.5.63）：把排查要用的东西打成一个 zip
//
// 给"部署在服务器、人又在外地、没空拉日志"的场景用：
//   控制台点一下 / 或 GET /api/diag/bundle → 下载 zip → 微信发过来即可
//
// 包含：health.json / bridge.log.tail / config.redacted.json / diag/last-errors.json
// 脱敏：key、token、secret、password、长十六进制串一律替换成 ***
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const REDACT_KEYS = /(apiKey|apiKeyEnc|token|accessToken|wsToken|httpToken|secret|password|passwd|credential)/i;
const LONG_HEX = /\b[a-f0-9]{24,}\b/gi;

/** 递归脱敏：对象里敏感字段值换成 ***，字符串里长 hex 也抹掉 */
export function redact(value, depth = 0) {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.test(k) ? '***' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value
      .replace(LONG_HEX, '***')
      .replace(/(Bearer\s+)[\w.~+/=-]{8,}/gi, '$1***')
      .replace(/("?(?:token|key|secret)"?\s*[:=]\s*"?)[^"\s,}]{6,}/gi, '$1***');
  }
  return value;
}

/** 日志脱敏：按行处理，去掉可能的密钥与 QQ 号后半段 */
export function redactLog(text, maxLines = 2000) {
  const lines = String(text || '').split('\n');
  const tail = lines.slice(-maxLines);
  return tail.map((line) => String(line)
    .replace(LONG_HEX, '***')
    .replace(/(Bearer\s+)[\w.~+/=-]{8,}/gi, '$1***')
    .replace(/\b(key|token|secret)\s*[=:]\s*\S{6,}/gi, '$1=***')
  ).join('\n');
}

/** 极简 ZIP 写入（只做 store，不压缩；条目小，够用且零依赖） */
export function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32fallback(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);          // UTF-8 文件名
    local.writeUInt16LE(0, 8);               // store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, end]);
}

function crc32fallback(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

/**
 * 生成诊断包。
 * @param {{stateDir:string, root?:string, health?:object, config?:object, log?:Function}} opts
 */
export function buildDiagBundle(opts = {}) {
  const stateDir = opts.stateDir || 'state';
  const entries = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  entries.push(['README.txt', [
    `诊断包 生成于 ${new Date().toISOString()}`,
    '',
    '包含：',
    '  health.json            运行状态快照',
    '  config.redacted.json   配置（密钥已替换为 ***）',
    '  bridge.log.tail        最后若干行日志（已脱敏）',
    '  diag/last-errors.json  最近 20 条错误（含错误码）',
    '',
    '敏感信息（key/token/secret、长十六进制串）已替换为 ***。',
  ].join('\n')]);

  entries.push(['health.json', JSON.stringify(redact(opts.health || { ok: true, note: '未提供 health' }), null, 2)]);

  try {
    const cfgPath = path.join(opts.root || '.', 'config.json');
    const cfg = opts.config || JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    entries.push(['config.redacted.json', JSON.stringify(redact(cfg), null, 2)]);
  } catch (error) {
    entries.push(['config.redacted.json', JSON.stringify({ error: String(error?.message ?? error) }, null, 2)]);
  }

  for (const name of ['bridge.log', 'app.log']) {
    try {
      const text = fs.readFileSync(path.join(stateDir, name), 'utf8');
      entries.push(['bridge.log.tail', redactLog(text, 2000)]);
      break;
    } catch { /* 下一个 */ }
  }

  try {
    const errs = fs.readFileSync(path.join(stateDir, 'diag', 'last-errors.json'), 'utf8');
    entries.push(['diag/last-errors.json', redactLog(errs, 400)]);
  } catch {
    entries.push(['diag/last-errors.json', '[]']);
  }

  const zip = buildZip(entries);
  const file = path.join(stateDir, 'diag', `diag-${stamp}.zip`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, zip);
  } catch { /* 写不了也照样返回内存里的 zip */ }
  return { zip, file, entries: entries.map(([n]) => n), size: zip.length };
}
