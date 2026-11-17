# dsh-bot-stack

个人自建的「DSH + DSCord 多 Bot 协作栈」索引仓库。

代码在各自的仓库里，**这里只放架构、部署链路和坑**。想搞清楚这套东西是怎么拼起来的，从这里进。

## 仓库索引

| 仓库 | 是什么 | 可见性 |
|---|---|---|
| [`dscord`](https://github.com/RitchieLeung/dscord) | DSCord 的自用 fork（Bot 层：DSH session + IM 身份、派工、记忆管线） | public |
| [`dsh-plugin-bot-issue`](https://github.com/RitchieLeung/dsh-plugin-bot-issue) | 事务面板：状态机、派工、验收/打回、评论、附件 | public |
| [`dsh-plugin-bot-knowledge`](https://github.com/RitchieLeung/dsh-plugin-bot-knowledge) | 知识库看板：每只 Bot 记了什么 + 每日工作日报 | public |
| `dsh-plugin-bot-ebook` | 电子书面板：书库 + 阅读器 | private（未完成） |
| `dsh-plugin-bot-restart` | 服务面板：软重载插件 / 真重启 | private（未接线） |
| `dsh-bot-stack` | 本仓库，纯文档 | public |

统一打 `dsh` / `cordis` / `dscord` / `dsh-plugin` topics，方便一搜全出来。

## 这套东西由什么组成

```
浏览器
  │ HTTPS（可选：Cloudflare Tunnel / 反向代理做 TLS 与登录）
  ▼
front proxy :3080          ← 固定端口的透传 + 兜底页 + 急救台
  │ HTTP
  ▼
dsh web :3082              ← DeepSeek Harness 本体，加载 profile
  │
  ├─ profile: ~/.dsh/profiles/web
  │    ├─ bundle: @deepseek-ai/dsh-base
  │    ├─ bundle: @deepseek-ai/dsh-web-app
  │    ├─ bundle: dscord                    ← fork，Bot 层与 IM 连接
  │    ├─ bundle: dsh-plugin-bot-knowledge
  │    ├─ bundle: dsh-plugin-bot-issue
  │    └─ bundle: dsh-plugin-bot-ebook
  │
  └─ DSCord Bot = 一个 DSH agent session + 一个 IM 身份
       每只 Bot 可以走不同模型路由（API 模型 / 本地 CLI agent / ACP agent）
```

急救台在 `:3099`（独立进程），能在面板起不来时停用插件、重启 dsh、抓登录链接。

## 部署链路（最重要的一节）

profile 是用**绝对路径**接线这些插件的：

```jsonc
// ~/.dsh/profiles/web/package.json
"dscord": "file:<workspace>/dscord-fork",
"dsh-plugin-bot-issue": "link:<workspace>/bot-issue",
"dsh-plugin-bot-knowledge": "link:<workspace>/bot-knowledge"
```

两个关键事实：

1. **`link:` / `file:` 装进 `node_modules` 的是快照，不是软链。**
   pnpm 把整个目录复制了一份。改完 workspace 里的代码，profile 里那份不会自动变。
2. **`dscord` 因为是 `file:` 且有自己的同步脚本，改完必须跑 `sync.sh`。**

因此生效分三层，按代价从小到大：

| 改动 | 生效方式 |
|---|---|
| 插件 host/client 代码 | 同步到 profile → HMR 重组（追加 `# hmr-nudge` 触发）或「重载插件」 |
| profile 的 `package.json` 依赖 | `pnpm install` → 重载插件 |
| 原生依赖 / 进程本身 | 重启 `dsh web` |

**推论：不要随便挪目录。** 挪一个插件目录 = 改 profile 里的绝对路径 + 重装 + 重载/重启。
仓库切分因此必须跟着本地目录走，而不是反过来。

## 数据都在哪

| 数据 | 位置 |
|---|---|
| DSCord Bot 与状态 | `~/.dsh/bot/state.json` |
| DSCord 聊天索引 / 用量 | `~/.dsh/bot/chat-index.sqlite`、`usage.sqlite` |
| 事务 | `~/.dsh/bot/issue/issue.sqlite` + `attachments/` |
| 记忆库 | `~/.dsh/bot/knowledge/knowledge.sqlite` |
| 电子书 | `~/.dsh/bot/ebook/ebook.sqlite` |
| DSH 会话 | `~/.dsh/sessions/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd` |

`~/.dsh/bot/` 下面还散着 `secrets.json`、`dscord-kernel.json`、`inflight.json` 等运行时文件——**都不是配置，别提交**。

## 已知边界

- **事务执行人由主 Bot 自己定**，宿主不替你选人。主 Bot 看 roster、看负载、看模型能力，再决定派给谁；派错了就闭环回来改派或拆子事务。宿主不做「能力匹配」硬编码。
- 事务的 `dispatched → in_review` **不绑定执行人 session id**。这是有意的：session 会漂移，绑定会把事务锁死。代价是理论上任何 bot 都能传 `待验收`，靠 skill 规则约束。
- dscord fork 基线是 `0.4.0-alpha.2`，上游已发到 `alpha.5`。升级要按 `FORK.md` 的清单手工重放（不是 `git merge`），因为 fork 是从 tgz 解包的，和上游没有共同祖先。
- `dscord-fork/` 目录嵌套在 `bot-knowledge/` 里面（历史遗留），挪它要动 profile 的 `file:` 依赖。
- `dsh-plugin-bot-restart` 写好了但**没接进 profile**。

## 上游

- [`MixGeekers/dscord`](https://github.com/MixGeekers/dscord) —— fork 来源，Apache-2.0，基线 `ds-group-v0.4.0-alpha.2`
- [`EricJiang0423/dsh-orchestrator`](https://github.com/EricJiang0423/dsh-orchestrator) —— 第三方编排插件，本地有一批补丁
- [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) —— 宿主本体

## 运行时

- dsh `0.2.2-rc.1`
- Node `v24.22.2`
