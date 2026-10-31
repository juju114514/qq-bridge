// 语音 · 纯判断与格式化（零 IO）
// 从 src/voice-core.js 拆出：扩展名判断、字节/时长格式化、目标 key 解析、
// 上传名清洗、音量/响度档位。找文件与 ffmpeg 调用留在 voice-core.js。

export const AUDIO_EXTS = [
  '.mp3', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.flac',
  '.amr', '.silk', '.slk', '.wma', '.spx'
];

/** 已经是 QQ 原生 SILK 的扩展名：跳过探测。 */
export const SILK_EXTS = new Set(['.silk', '.slk']);

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_SECONDS = 300;

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}分${String(r).padStart(2, '0')}秒` : `${r}秒`;
}

/** 递归列出语音库里的音频（按相对路径排序，结果稳定）。 */
export function describeAudio(info) {
  const b = [];
  if (info?.duration) b.push(formatDuration(info.duration));
  if (info?.size) b.push(formatBytes(info.size));
  if (info?.codec) b.push(info.codec);
  if (info?.sampleRate) b.push(`${(info.sampleRate / 1000).toFixed(1)}kHz`);
  if (info?.channels) b.push(info.channels === 1 ? '单声道' : `${info.channels}声道`);
  return b.join(' · ') || '未知音频';
}

/**
 * 目标 key 解析：group:123 / private:123。
 *
 * 号码必须是**正整数**（不以 0 开头）：QQ 号与群号都不可能是 0，
 * 放 `group:0` 过去只会让一个必然失败的请求走到网关。
 * 非零开头同时也挡住了 `group:007` 这种写法。
 */
export function parseTargetKey(key) {
  const m = /^(group|private):([1-9]\d*)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  return { kind: m[1], id: m[2], key: `${m[1]}:${m[2]}` };
}

/** 上传文件名净化：去掉路径、控制字符、Windows 保留字符，保留中文。 */
export const VOLUME_MIN = 0.1;
export const VOLUME_MAX = 4;
/** 智能音量（loudnorm）的目标响度，单位 LUFS。 */
export const LOUDNESS_TARGETS = { quiet: -20, normal: -16, loud: -13 };

/** 解析语音处理选项；返回 { volume, loudness }（两者互斥，loudness 优先）。 */
export function resolveAudioProcessing({ volume = 1, normalize = false, loudness = 'normal' } = {}) {
  if (normalize === true) {
    // 允许两种写法：档位名（quiet/normal/loud）或直接的 LUFS 数字。
    // 注意顺序：**先判数字**再查档位表 —— 否则 -18 这种数字会被当成"未知档位"拒掉。
    if (typeof loudness === 'number') {
      if (!Number.isFinite(loudness) || loudness < -40 || loudness > -5) {
        throw new Error(`目标响度需在 -40 ~ -5 LUFS 之间，收到 ${loudness}`);
      }
      return { volume: 1, loudness, loudnessKey: String(loudness) };
    }
    const key = String(loudness ?? 'normal');
    if (!Object.hasOwn(LOUDNESS_TARGETS, key)) {
      throw new Error(`未知的响度档位「${key}」（可选：${Object.keys(LOUDNESS_TARGETS).join(' / ')}，或直接给 -40~-5 的 LUFS 数字）`);
    }
    return { volume: 1, loudness: LOUDNESS_TARGETS[key], loudnessKey: key };
  }
  const v = Number(volume);
  if (!Number.isFinite(v)) throw new Error(`音量必须是数字，收到「${volume}」`);
  if (v < VOLUME_MIN || v > VOLUME_MAX) {
    throw new Error(`音量倍数需在 ${VOLUME_MIN}~${VOLUME_MAX} 之间（1.0 = 原样），收到 ${v}`);
  }
  return { volume: v, loudness: null, loudnessKey: null };
}

/**
 * 定位 ffmpeg：显式参数 → 环境变量 → PATH。
 *
 * 优先级按**实现**写文档：config.json 的 socialV2.voice.ffmpegPath 是"这台机器上 ffmpeg 在哪"的
 * 显式配置，比环境变量更具体，所以参数优先（旧注释写成"环境变量 → 参数"，与代码相反，
 * 照着注释去改代码就会把用户的显式配置降级成环境变量兜底）。
 *
 * 只返回**确实存在**的文件路径。两个候选都没 stat 成功时返回裸命令名 'ffmpeg'，交给 spawn 按 PATH
 * 解析；旧实现在这种情况下返回 `candidates[0]`，哪怕那个路径根本不存在 —— 调用方于是拿到一句
 * 无信息量的"启动失败"，而不是 ENOENT 分支里那句"请设置 FFMPEG_PATH 或在 config.json 里指定"。
 */