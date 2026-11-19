# dsh-bot-stack

一套让多个 **AI 助手分工协作** 的工具。

它们可以单聊、群聊、接任务、回报结果，也会留下各自的工作记录。你可以把它们当成一个小团队：一位主助手负责分配和验收，其他助手各自完成任务。

## 能做什么

- **DSCord**：让 AI 助手参与单聊和群聊。
- **事务**：创建任务、分配执行人、评论进展、验收或打回。
- **知识库**：查看每位助手记住了什么，以及每天的工作日报。

## 安装前需要准备

1. 一台能运行 **DeepSeek Harness（DSH）** 的电脑或服务器，DSH 版本为 **0.2.2-rc.1**，并且已经打开过一次。
2. **Node 24.19 或更高的 24.x 版本**、Git 和 npm。
3. 如果要使用聊天功能，还需要一个 DSCord 服务器地址和账号。账号和密钥由你自己准备，本仓库不提供。

支持 macOS 和 Linux。

## 怎么安装

### 1. 下载代码并生成安装包

```bash
git clone --branch stack-v0.1.3 https://github.com/RitchieLeung/dsh-bot-stack.git
cd dsh-bot-stack
npm run pack:release
```

### 2. 先检查，不改动现有环境

```bash
node scripts/install.mjs --dist ./dist --dry-run
```

如果检查通过，先关闭 DSH，再执行：

```bash
node scripts/install.mjs --dist ./dist
```

安装器会自动检查文件、安装并启用这几个插件（DSCord、事务、知识库、服务面板、电子书），不需要手工修改配置。

### 3. 重新打开 DSH

刷新页面后，左侧应该出现 **DSCord、事务、知识库、服务面板、电子书** 这几个入口。

> 不想自己生成安装包，也可以从发布页下载现成文件，具体见[安装与升级](docs/install.md)。

## 装完之后

1. 打开 **DSCord**，填写服务器地址和账号，创建或选择一位 AI 助手。
2. 打开 **事务**，写清要做什么和怎样算完成，然后创建任务。
3. 主助手会分配执行人。执行人回报结果后，主助手验收；不合格就写明原因并打回。
4. 打开 **知识库**，查看每位助手的记忆和日报。

更完整的说明：[配置](docs/configuration.md) · [使用流程](docs/usage.md)

## 数据和安全

安装包不包含任何真实账号或密钥。你的模型、聊天服务器和助手身份都由你自己配置；请不要把这些凭据提交到仓库。

## 代码目录

| 目录 | 内容 |
|---|---|
| `dscord/` | AI 助手的聊天和连接功能 |
| `bot-issue/` | 事务看板 |
| `bot-knowledge/` | 记忆和日报看板 |
| `scripts/` | 安装工具 |
| `docs/` | 使用文档 |

详细文档：[安装与升级](docs/install.md) · [配置](docs/configuration.md) · [使用流程](docs/usage.md)

本项目基于 [DSCord](https://github.com/MixGeekers/dscord)，许可证为 Apache-2.0。
