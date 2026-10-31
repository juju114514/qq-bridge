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

## 7. 已确认：`createUserMessage`（对照 `@deepseek-ai/dsh-llm@0.0.1-rc.1`）

**导入路径**：`import { createUserMessage } from '@deepseek-ai/dsh-llm'`
（不是 `dsh-session` —— dsh-onebot 的 `bridge.ts` L12 是这么引的，我们下载包核对过）

**类型定义**（`lib/types/message.d.ts`）：

```ts
interface UserMessage extends Message { readonly role: 'user' }
interface Message {
  readonly id: MessageId
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: ContentBlock[]      // ← 数组，不是字符串
  readonly source: MessageSource
}
type NewUserMessage = Omit<UserMessage, 'id' | 'role'>   // 只留 content + source

declare function createUserMessage<T extends NewUserMessage>(
  input: T & { readonly id?: never; readonly role?: never },
): T & Pick<UserMessage, 'id' | 'role'>
```

- **不能自己传 `id` / `role`**：类型层是 `readonly id?: never`，传了就编译不过（运行时也会被冻结逻辑覆盖）
- **`role` 由它固定成 `'user'`**

**`ContentBlock` 五种**（`lib/types/types.d.ts` L25-75）：

| type | 字段 |
| --- | --- |
| `text` | `{ type:'text', text: string }` |
| `reasoning` | `{ type:'reasoning', text: string }` |
| `image` | `{ type:'image', attachment: ImageAttachmentRef }` |
| `tool-call` | `{ type:'tool-call', id, name, arguments }` |
| `tool-result` | `{ type:'tool-result', toolCallId, content, isError? }` |

**`source` 的 user 形态**：`{ kind: 'user' }`（`MessageSourceMap` 是 merge-extensible 的 sum type）

**我们的封装**：`plugin/user-message.js`

```js
buildUserMessage('你好')
// → { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }
```

为什么不直接调 `createUserMessage`：离线测试与宿主版本不匹配时，插件仍要能构造消息。
所以先产出**纯数据**，`assertNewUserMessage()` 做形状校验，真正调用库函数的地方再加一层。

## 8. 仍未确认（下一步）

`plugin add <本地路径>` 在临时 profile 里会不会要求 `pnpm build` —— P1 收尾装一次就知道了。

## 9. 真机装了一次之后学到的（2026-10-31，dsh 0.2.1-rc.5）

在 `~/.dsh/profiles/qqtest` 这个**临时 profile** 里真装了一次（不碰 desktop）：

```powershell
dsh plugin --profile qqtest add <repo>\plugin        # 需要 pnpm 在 PATH 上
# 还要把包名加进 profile package.json 的 dsh.profile.bundles：
#   "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@juju114514/qq-bridge-plugin"
dsh --profile qqtest --dump-config                     # 能看到 - id: qq-bridge 即成功
dsh --profile qqtest                                   # 启动，看挂载日志
```

三个只在真机上才暴露的事实：

| # | 现象 | 正确做法 |
| --- | --- | --- |
| 1 | `dsh plugin ... add` 报 `'pnpm' is not recognized` | **它 shell 出去调 pnpm**：得把 pnpm 放进 PATH（我做了个 `pnpm.cmd` 垫片指向 `pnpm.mjs`） |
| 2 | `tool "qq_ping" must declare output { schema, render, presentationMeta? }` | `output` **必须同时给 `schema` 和 `render`**，只给 schema 会在注册时抛错 |
| 3 | `unsupported JSON schema: schema.type must be one of object/array/string/...` | **`type: 'json'` 不被支持**（dsh-onebot 用 json 是它适配的宿主版本更新）。对象输出写 `{ type: 'object', additionalProperties: true }` |

还有一条：只放 `dsh.plugin.json` 不够 —— 宿主认的是 **`package.json` 的 `dsh.bundle.patch`**，
指向包内的 `cordis.patch.yml`（顶层 YAML 数组，`- insert: [{ id, name }]`），
否则只装成普通依赖并提示 `declares no dsh.bundle`。

成功的样子：

```
[qq-plugin] 插件已挂载：onebot=ws://127.0.0.1:3001 sidecar=http://127.0.0.1:3110 requireMention=true
[qq-plugin] sidecar 未连接（http://127.0.0.1:3110）：主动消息、记忆写入、记账、控制台均不可用（被动回复正常）
dsh web: http://127.0.0.1:3080/?token=...
```

## 10. ⚠️ 教训：临时 profile 一定要用独立的 `DSH_HOME`

我第一次验证时把 profile 建在了真实的 `~/.dsh/profiles/qqtest`，然后启动它 ——
结果**同时有两个 DSH 宿主在写同一个 `~/.dsh`**（共享 `storages/`、`.dshw-*.json`、`sessions/`），
桌面上那个本体随后弹了「暂时无法保存确认状态，请重试」。

不是必然冲突，但**没有任何理由冒这个险**。正确做法：

```powershell
$env:DSH_HOME = 'D:\QQBot\temp\dsh-home'    # 宿主会用它下面的 profiles/
node <dsh-cli>\lib\bin.js --from-default-profile web --profile qqtest --dump-config
node <dsh-cli>\lib\bin.js plugin --profile qqtest add <repo>\plugin
node <dsh-cli>\lib\bin.js --profile qqtest
```

`--help` 里写的是「the profile under `$DSH_HOME/profiles`」—— 也就是说**这条路是被支持的**，
我之前没用它纯属偷懒。

判断有没有踩坑：
- `~/.dsh/profiles/` 下出现非 `desktop`/`web` 的目录
- `~/.dsh/storages/` 或 `~/.dsh/.dshw-*.json` 的修改时间与临时实例启动时间重合

清理：删掉那个临时 profile 目录即可（本次已删）。
