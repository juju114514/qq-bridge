# DSH 插件 API 速查（从真实插件反推，2026-10-31）

> 来源：把 `dsh-onebot`（BSD-3，144 文件）和 `dsh-im`（MIT）的源码读了一遍。
> 只记我们写 `plugin/` 需要的部分，全部带出处行号，方便回查。

## 1. 插件的四个约定

```js
export const name = 'dsh-onebot'                 // 插件 id（与 dsh.plugin.json 的 id 一致）
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions',
                       'agentDefaultModel', 'agentPresets', ...]   // 依赖的宿主服务
export const Config = z.object({ /* schemastery */ })              // 配置 schema + 默认值
export function apply(ctx, config) { ... }                          // 挂载入口
```

出处：`dsh-onebot/src/index.ts` L94-95、L210、L391。

**`inject` 是契约**：宿主只会把声明的服务放进 `ctx`；少声明一个，运行时就是 `undefined`。

## 2. 宿主暴露的服务（我们实测需要的）

| 服务 | 用途 | 出处 |
| --- | --- | --- |
| `ctx.tools` | 注册 `qq_*` 工具（进程内，**不走 MCP**） | `index.ts` L104 |
| `ctx.agents` | 每会话一个 Agent：`create()` / 取回 | `registry.ts` L394 |
| `ctx.sessions` | 会话存储（历史、持久化） | `index.ts` L95 |
| `ctx.systemPrompt` | 注入系统提示片段 | 同上 |
| `ctx.agentDefaultModel` | 读/存默认模型选择 | 同上 |
| `ctx.agentPresets` | 挂 preset（工具集、prompt） | 同上 |

## 3. 注册工具

```js
import { defineTool } from '@deepseek-ai/dsh-tools';

const dispose = ctx.tools.register(defineTool({
  name: 'qq_send_image',
  description: '……给模型看的说明（写清什么时候用、什么时候别用）',
  parameters: {
    sources: { type: 'array', items: { type: 'string' }, required: true, description: '……' },
    chat_id: { type: 'string', description: '格式 private:<QQ号> 或 group:<群号>' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: '已发送（message_id=…）' }],
  },
  isConcurrencySafe: () => true,
  execute: async (args, exec) => { /* exec 里带会话上下文 */ },
}));
```

要点：
- `parameters` 是**扁平的对象**，不是 JSON Schema 顶层 `properties`（宿主自己包）
- `output.render` 决定控制台/UI 里怎么显示，返回 `[{type:'text',text}]`
- `register()` **返回 disposer**，卸载时必须调用（否则热重载后工具重复注册）
- `isConcurrencySafe` 影响宿主能否并发调用；发消息类工具应为 `true`

## 4. 创建/驱动 Agent

```js
const handle = await ctx.agents.create({
  sessionId,            // 我们自己生成的稳定 id（如 qqbot:group:123）
  meta,                 // 元数据（含 agentPreset）
  agentOptions,         // 模型、工作目录等
  setup,                // 首次挂载时的初始化
});
// handle.agent.session.id / handle.agent.whenIdle() / handle.dispose()

// 把一条用户消息喂给该 Agent：
chat.agent.followup(createUserMessage({ /* role:'user', content:[...] */ }));
```

出处：`registry.ts` L394-420、`bridge.ts` L619。

注意两件事：
1. **`create` 可能因 id 冲突失败**（旧的持久化会话占了同一个 id）→ 参考实现的做法是换一个带后缀的新 id 重试（`registry.ts` L400-413）
2. **`whenIdle()` 要等**：create 之后先 `await handle.agent.whenIdle()` 再开始喂消息，否则可能与初始化竞争

## 5. 插件清单 `dsh.plugin.json`

```json
{
  "id": "dsh-onebot",
  "version": "0.9.8",
  "main": "./lib/index.js",
  "engines": { "dsh": ">=0.2.1-0 <0.3.0-0" },
  "contributes": { "tools": ["qq_send_image", "qq_send_voice", "…"], "skills": [] }
}
```

- `engines.dsh` 是**版本区间**，宿主据此决定装不装
- `contributes.tools` **必须列出**所有工具名，否则宿主不把它们暴露给模型
- `main` 指向**构建产物**（TS 插件都有这一步）；我们直接用 ESM 源码，省掉构建

## 6. 对我们 `plugin/` 的结论

| 事项 | 决定 | 理由 |
| --- | --- | --- |
| 语言 | **纯 ESM JS**（不引入 TS 构建） | 多一道构建就多一处"源码与产物不一致"；dsh-onebot 的 `lib/` 就是踩过这个坑 |
| 依赖 | 只 `inject = ['tools']`（P1 阶段） | 能少依赖就少依赖；接 OneBot 后再加 `agents`/`sessions` |
| 工具 | 先注册 `qq_ping` 自检 | 用来验证"插件真被加载 + 工具进程内可用" |
| 卸载 | `apply` 返回 disposer | 宿主热重载会调用；不返回就泄漏 |
| 失败策略 | 缺 `ctx.tools.register` → **抛错** | 静默挂载会让用户以为装上了 |

## 7. 还没确认的两点（P1 收尾时补）

1. `plugin add <本地路径>` 在临时 profile 里的行为（会不会要求 `pnpm build`）
2. `createUserMessage` 的确切导入路径与字段（`role` / `content` 的形状）