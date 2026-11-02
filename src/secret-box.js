// 密钥保护（0.5.49）
//
// 借来的原则（arcdream-hub，只学思路不抄代码）：**Key 不落明文**。
//   · Windows 上用 DPAPI（`ProtectedData.Protect(..., CurrentUser)`）—— 只有当前用户能解开
//   · 其它平台退化成「本地 AES-256-GCM + 一把权限 600 的密钥文件」
//
// 为什么不自己造密码学：DPAPI 已经把「换机器/换用户就解不开」这件事做对了；
// 非 Windows 上退一步，保证至少不是明文裸奔。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const WIN_PS = `param([string]$mode,[string]$in,[string]$out)
Add-Type -AssemblyName System.Security
$b = [IO.File]::ReadAllBytes($in)
if ($mode -eq 'protect') {
  $p = [Security.Cryptography.ProtectedData]::Protect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
  $p = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
}
[IO.File]::WriteAllBytes($out, $p)`;

/**
 * @param {{platform?:string, keyFile?:string, tmpDir?:string}} [opts]
 */
export function createSecretBox(opts = {}) {
  const platform = opts.platform || process.platform;
  const keyFile = opts.keyFile || path.join(os.homedir(), '.qq-bridge', 'secret.key');
  const tmpDir = opts.tmpDir || os.tmpdir();
  const cache = new Map();

  function aesKey() {
    try {
      const raw = fs.readFileSync(keyFile);
      if (raw.length === 32) return raw;
    } catch { /* 还没生成 */ }
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    try { fs.chmodSync(keyFile, 0o600); } catch { /* Windows 上可能无效，不致命 */ }
    return key;
  }

  function dpapi(mode, text) {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'qqb-sec-'));
    const inF = path.join(dir, 'in.bin');
    const outF = path.join(dir, 'out.bin');
    const psF = path.join(dir, 'sec.ps1');
    try {
      fs.writeFileSync(inF, mode === 'protect' ? Buffer.from(text, 'utf8') : Buffer.from(text, 'base64'));
      fs.writeFileSync(psF, WIN_PS, 'utf8');
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psF, mode, inF, outF], { timeout: 15000, windowsHide: true, stdio: 'ignore' });
      const out = fs.readFileSync(outF);
      return mode === 'protect' ? out.toString('base64') : out.toString('utf8');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /** 加密成可落盘的字符串（带前缀，解开时据此选算法） */
  function protect(text) {
    const s = String(text ?? '');
    if (!s) return '';
    if (platform === 'win32') {
      try { return 'dpapi:' + dpapi('protect', s); } catch { /* 落到本地 AES */ }
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
    const enc = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'local:' + Buffer.concat([iv, tag, enc]).toString('base64');
  }

  /** 解开；解不开返回空串（调用方当成"没配"，而不是崩） */
  function unprotect(blob) {
    const s = String(blob ?? '');
    if (!s) return '';
    if (cache.has(s)) return cache.get(s);
    let out = '';
    try {
      if (s.startsWith('dpapi:')) out = dpapi('unprotect', s.slice(6));
      else if (s.startsWith('local:')) {
        const buf = Buffer.from(s.slice(6), 'base64');
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const data = buf.subarray(28);
        const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), iv);
        d.setAuthTag(tag);
        out = Buffer.concat([d.update(data), d.final()]).toString('utf8');
      } else {
        out = s;   // 兼容：没前缀就当明文（便于平滑迁移）
      }
    } catch { out = ''; }
    cache.set(s, out);
    return out;
  }

  return { protect, unprotect, keyFile };
}

/**
 * 从 agent 配置里取 API key：优先密文，其次明文，最后环境变量。
 * @param {{apiKey?:string, apiKeyEnc?:string}} agentCfg
 * @param {{env?:object, box?:object}} [opts]
 */
export function resolveApiKey(agentCfg = {}, opts = {}) {
  const env = opts.env || process.env;
  const box = opts.box || createSecretBox();
  const enc = String(agentCfg.apiKeyEnc || '');
  if (enc) {
    const v = box.unprotect(enc);
    if (v) return v;
  }
  const plain = String(agentCfg.apiKey || '');
  if (plain) return plain;
  return String(env.DEEPSEEK_API_KEY || '');
}
