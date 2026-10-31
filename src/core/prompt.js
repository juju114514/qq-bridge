// 核心库 · 提示词与人格卡（纯函数，零 IO）
//
// 现在从 src/role-card.js 取实现（解析小节、按模式选文、统计字符）。
// 下一步会把 socialV2-prompt.js 里"组装字符串"的部分也搬进来，
// 让插件与 sidecar 用同一套 prompt 构建，保证两种模式逐字一致。
export {
  ROLE_INJECT_MODES,
  parseRoleSections,
  selectRoleText,
  roleSectionReport,
  roleCharStats,
  GEN1_ROLE_LINE_RE,
  parseRoleFrontMatter,
  buildRoleFrontMatter,
  slugifyRoleId,
  hashRoleId,
} from '../role-card.js';