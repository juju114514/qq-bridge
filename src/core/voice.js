// 核心库 · 语音工具函数（纯函数，零 IO）
//
// 文件发现/路径校验这类必须碰盘，留在 voice-core.js；
// 这里只导"纯判断与格式化"。后续会把两者拆开。
export {
  AUDIO_EXTS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_SECONDS,
  isAudioFile,
  formatBytes,
  formatDuration,
  describeAudio,
  parseTargetKey,
  sanitizeUploadName,
  VOLUME_MIN,
  VOLUME_MAX,
  LOUDNESS_TARGETS,
  resolveAudioProcessing,
} from '../voice-core.js';