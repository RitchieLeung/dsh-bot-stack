# 配置

安装包不包含任何真实账号、模型密钥或 Bot 身份。以下配置由部署者提供。

## DSH 与模型

- DSH 基线为 `0.2.2-rc.1`，Node 为 `>=24.19 <25`。
- 在 DSH profile 中配置自己的模型 provider 和凭据。环境变量名由你的 provider 配置决定，密钥放在 shell 环境或受保护的密钥文件中，不要写入仓库。
- 主 Bot 和 worker 可以使用不同模型路由。事务宿主不会根据模型名硬编码「谁一定能看图」；主 Bot 参考运行时能力，执行失败应闭环回来改派或拆子事务。

## DSCord Core/PWA

DSCord 插件负责节点侧 Bot，不替你启动 Matrix/Core 服务器。你需要准备：

1. Core/PWA 的可访问地址。
2. 一个属于该服务器的账号。
3. 节点到 Core/PWA 的网络连通性。

服务器部署、账号创建和独立节点导出见 [DSCord 安装与连接](../dscord/README.md)。本仓库的 fork 改动清单见 [FORK.md](../dscord/FORK.md)。

## 连接 Bot

1. 打开 DSH 左侧 **DSCord**。
2. 填写 Core/PWA 地址和自己的账号并登录。
3. 在「此节点的 Bot」中创建或选择 Bot，选择 DSH 已配置的模型并填写职责。
4. 点击「加入服务器」。需要群聊时，再把 Bot 邀请进对应房间。

主 Bot 从 DSCord 的 `mainBotIds` / 主 Bot 标记解析，不在事务插件里写死某个名字。多台机器可以有不同主 Bot。

## 数据位置

| 数据 | 默认位置 |
|---|---|
| DSCord Bot 与主 Bot 状态 | `~/.dsh/bot/state.json` |
| 事务、评论、附件元数据 | `~/.dsh/bot/issue/issue.sqlite` |
| 事务附件文件 | `~/.dsh/bot/issue/attachments/` |
| 派工图片的共享工作区 | `~/.dsh/bot/workspace/issue-attachments/` |
| 记忆与日报 | `~/.dsh/bot/knowledge/knowledge.sqlite` |
| DSCord 节点/连接数据 | `~/.dsh/dscord/` |
| 本次安装的持久 tarball | `~/.dsh/bot/packages/<build>/` |
| 安装备份 | `~/.dsh/bot/install-backups/` |

安装器不会清空或重建这些数据库。升级前仍应备份，因为新代码首次启动可能做 schema migration。

## 知识库日报

知识库插件只读记忆库，面板本身不修改记忆。需要日报的 Bot 由 `mainBotIds`、插件 config 的 `reportBotIds` 或已有排程决定，具体行为见 [知识库 README](../bot-knowledge/README.md)。

## 多机部署

每台机器有自己的 DSH home、Bot 身份和数据库。不要把 `state.json`、sqlite 或节点私密配置当成普通代码复制到另一台机器。公开仓库只发布代码和安装包。
