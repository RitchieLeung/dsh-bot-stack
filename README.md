# dsh-bot-stack

一套运行在 DeepSeek Harness（DSH）里的多 Bot 协作栈：**DSCord 负责 Bot 会话与协作，事务负责派单与闭环，知识库负责记忆与日报展示。**

## 要求

- Node **>=24.19 <25**
- DSH **0.2.2-rc.1**，并且已经启动过一次、存在目标 profile（默认 `web`）
- Git、npm，以及 DSH 可用的 pnpm
- 使用 DSCord 时，还需要你自己的 Core/PWA 地址、账号和业务模型配置；这些秘密不随仓库提供

支持 macOS 和 Linux。首次安装或升级正在运行的 profile 前，请先按原方式停止 `dsh web`。

## 快速安装

### 从源码安装

```bash
git clone --branch stack-v0.1.0 https://github.com/RitchieLeung/dsh-bot-stack.git
cd dsh-bot-stack
npm run check
npm run pack:release

# 先只检查 Node/DSH、安装包和 profile，不写任何内容
node scripts/install.mjs --profile web --dist ./dist --dry-run

# 停止 dsh web 后执行正式安装
node scripts/install.mjs --profile web --dist ./dist
```

安装器会校验 SHA256、把 tarball 放进持久目录、安装三个包，并把它们加入 `dsh.profile.bundles`。
**只安装 package 不等于激活 bundle**；这一步已经由安装器完成，不需要再手工编辑 profile。

完成后按原方式启动 `dsh web`，刷新页面。左侧应出现 **DSCord、事务、知识库**。

也可以从 GitHub Release 下载已经构建好的 tarball，见 [安装与升级](docs/install.md)。

## 首次使用

1. 打开 **DSCord**，填写自己的 Core/PWA 地址和账号，连接节点并创建/选择 Bot。
2. 打开 **事务**，写清任务、验收标准，创建后启动派工。
3. 主 Bot 选择执行人；worker 在事务里评论结果，主 Bot 验收或带意见打回。
4. 打开 **知识库**，查看各 Bot 的记忆和每日工作日报。

完整说明：[配置](docs/configuration.md) · [使用流程](docs/usage.md)

## 本机开发与部署到 146

```bash
# 两个插件的完整测试 + 打包/安装/部署脚本测试
npm run check

# 开发包：自动生成唯一 prerelease 版本，防止 pnpm 同版本不重装
npm run pack

# 本机检查、打包、上传、146 停服备份、安装、启动、健康检查
npm run deploy:146

# 只看部署步骤，不执行任何外部命令
npm run deploy:146 -- --dry-run
```

146 的主机地址、Node 路径等放在本机 gitignore 的 `.deploy-146.env`。部署失败会同时回滚
profile、已安装包和 Bot/事务/记忆数据。详见 [146 部署与回滚](docs/deploy-146.md)。

## 目录

| 目录 | 内容 |
|---|---|
| `dscord/` | DSCord fork：Bot 会话、单聊/群聊、任务分发、记忆管线 |
| `bot-issue/` | 事务：派工、执行人、评论/图片、验收/打回、闭环 |
| `bot-knowledge/` | 知识库看板：只读记忆与日报 |
| `scripts/` | 打包、安装、146 部署和回滚 |
| `docs/` | 安装、配置、使用、部署文档 |

本仓库是发布镜像，**不是线上工作目录**。本机线上代码仍在 `~/.dsh/bot/workspace/`，仓库合并不改变现有 profile 的接线。

## 文档

- [安装与升级](docs/install.md)
- [配置](docs/configuration.md)
- [使用流程](docs/usage.md)
- [146 部署与回滚](docs/deploy-146.md)
- [DSCord fork 改动与上游升级](dscord/FORK.md)
- [部署设计](docs/superpowers/specs/2026-11-18-deploy-pipeline-design.md)

DSCord 上游为 [`MixGeekers/dscord`](https://github.com/MixGeekers/dscord)，Apache-2.0，当前 fork 基线为 `ds-group-v0.4.0-alpha.2`。
