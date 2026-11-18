# dsh-bot-stack

个人自建的 **DSH + DSCord 多 Bot 协作栈**。这个仓库把实际绑定使用的三部分放在一起：

| 目录 | 作用 |
|---|---|
| [`dscord/`](dscord/) | DSCord 自用 fork：Bot 会话、单聊/群聊、任务分发、记忆管线 |
| [`bot-issue/`](bot-issue/) | 事务插件：派单、执行人、评论/图片、验收/打回、闭环 |
| [`bot-knowledge/`](bot-knowledge/) | 知识库看板：查看各 Bot 的记忆与每日日报 |

三者的关系是：**事务给 Bot 派单，Bot 在 DSCord 里协作，知识库展示 Bot 的记忆与工作记录**；它们都运行在同一套 DSH/Cordis profile 中。

独立插件 [`dsh-plugin-bot-restart`](https://github.com/RitchieLeung/dsh-plugin-bot-restart) 单独维护。电子书仓库保持私有，不在本仓库中。

## 仓库性质：发布镜像，不是线上工作目录

本仓库在 `~/Documents/dsh-bot-stack` 合并、发布；**线上代码仍在 `~/.dsh/bot/workspace/`，合并时没有移动或修改它**。

| 本仓库目录 | 线上工作目录 |
|---|---|
| `dscord/` | `~/.dsh/bot/workspace/bot-knowledge/dscord-fork/` |
| `bot-issue/` | `~/.dsh/bot/workspace/bot-issue/` |
| `bot-knowledge/` | `~/.dsh/bot/workspace/bot-knowledge/`（不含其中嵌套的 `dscord-fork/`） |

这样拆分 GitHub 仓库不会改变 profile 的绝对路径依赖，也不需要重装或重启线上服务。各部分的完整 git 历史通过 `git subtree` 合并保留。

## 架构

```text
浏览器 / IM
    │
    ▼
DSCord：Bot = DSH agent session + IM 身份
    ├── 单聊、群聊、模型路由、记忆管线
    ├── bot-issue：主 Bot 派单，执行人闭环，主 Bot 验收
    └── bot-knowledge：只读知识库看板 + 每日日报
```

事务执行人由主 Bot 根据专才、负载和实际执行反馈决定，不在宿主里硬编码「哪个模型一定能看图」。图片会落到共享工作区，Bot 通过本地路径读取。

## 数据位置

| 数据 | 位置 |
|---|---|
| DSCord Bot 状态 | `~/.dsh/bot/state.json` |
| 事务 | `~/.dsh/bot/issue/issue.sqlite` + `attachments/` |
| 记忆库 | `~/.dsh/bot/knowledge/knowledge.sqlite` |
| DSH 会话 | `~/.dsh/sessions/<cwd-slug>/<sessionId>/` |

运行时数据库、密钥和会话文件都不进入仓库。

## 检查

```bash
npm --prefix bot-issue run check
npm --prefix bot-knowledge run check
```

根目录 CI 对这两个插件分别执行零依赖语法检查和完整测试。`dscord/` 当前没有随仓库提供的统一测试命令。

## 文档

- [部署与生效](docs/deploy.md)
- [DSCord fork 改动与上游升级](dscord/FORK.md)
- [事务插件说明](bot-issue/README.md)
- [知识库插件说明](bot-knowledge/README.md)

## 上游

- [`MixGeekers/dscord`](https://github.com/MixGeekers/dscord)：fork 来源，Apache-2.0，基线 `ds-group-v0.4.0-alpha.2`
- [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)：宿主本体

当前运行环境：dsh `0.2.2-rc.1`，Node `v24.22.2`。
