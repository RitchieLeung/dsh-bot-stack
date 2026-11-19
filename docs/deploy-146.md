# 146 部署与回滚

这条管道用于：**本机开发测试完成 → 同一份构建部署到 146 试点**。不是把本机线上工作目录同步过去，也不要求 146 是空白机。

## 一次性准备

本机需要 ssh/rsync 能连接 146。远端需要 Node24、匹配的 DSH、pnpm，以及正在运行的 `dsh-web.service`。当前脚本默认服务名为 `dsh-web.service`，可用环境变量覆盖。

在仓库根目录创建本机私有 `.deploy-146.env`（已 gitignore）：

```bash
DEPLOY_HOST=your-146-ssh-host
REMOTE_ROOT=/home/your-user/dsh-bot-stack
DSH_NODE_HOME=/home/your-user/.nvm/versions/node/v24.22.2
DSH_SERVICE=dsh-web.service
```

如果本机 ssh config 已把 146 配成 alias `146`，`DEPLOY_HOST` 也可以就是 `146`。不要把真实地址或密钥提交到仓库。

## 日常部署

```bash
npm run deploy:146
```

默认要求 git 工作区干净。流程：

1. 本机运行完整 `npm run check`。
2. `npm run pack` 生成唯一开发版本、SHA256 和 manifest。
3. 上传 dist 和安装脚本到 `~/dsh-bot-stack/releases/<build>/`。
4. 远端 dry-run 校验 Node/DSH/SHA。
5. 停止 `dsh-web.service`，确认 3080 不再响应。
6. 备份 profile、全部已安装 package 目录，以及完整的 `~/.dsh/bot`、`~/.dsh/dscord`。
7. 安装并激活全部 bundle。
8. 启动服务，最多等待 60 秒：检查新 pid、每个 bundle 的 graph entry、8 个事务工具和 failed 为空。
9. 健康后更新 `releases/current`，只保留最近 5 个 release。

部署期间 146 会有短暂停机。脚本不会自动 push git，也不会修改本机线上 workspace。

### 只检查本机会做什么

```bash
npm run deploy:146 -- --dry-run
```

这个模式不调用 git/npm/ssh/rsync/systemctl。

### 临时调试未提交改动

```bash
npm run deploy:146 -- --allow-dirty
```

这只用于明确调试；正式试点应从未提交的干净 HEAD 构建，便于复现。

## 自动回滚

安装或健康检查失败时，远端会：

1. 停止服务；
2. 恢复 profile 的 package/lock/patch；
3. 恢复全部 `node_modules/<package>`；
4. 从 `data.tgz` 恢复整个 bot/dscord 数据；
5. 按旧 lockfile 执行 `pnpm install --frozen-lockfile --ignore-scripts`；
6. 启动旧版本并做基础健康检查。

备份位于 `REMOTE_ROOT/backups/<build>/`，失败 release 也会保留用于排查。

## 手工回滚

只有自动回滚也失败时才需要手工做。先停止服务，然后在 146 上执行（替换路径）：

```bash
source /home/your-user/dsh-bot-stack/releases/<build>/scripts/remote-deploy.sh
restore_paths \
  /home/your-user/.dsh/profiles/web \
  /home/your-user/.dsh \
  /home/your-user/dsh-bot-stack/backups/<build>
cd /home/your-user/.dsh/profiles/web
/path/to/node24/bin/pnpm install --frozen-lockfile --ignore-scripts
sudo systemctl start dsh-web.service
```

`restore_paths` 会同时替换代码和数据，不要在只想回滚一个文件时随手运行。

## 试点验收

- `systemctl is-active dsh-web.service` 为 active，MainPID 已变化。
- `plugins/events` 含 dscord、事务、知识库。
- `~/.dsh/bot/issue/tools.json` 是本次启动生成的，8 个工具齐全。
- 旧 Bot、旧事务、旧记忆仍在。
- 最后建一条专用试点事务，真实走通派工、评论、验收；不要只凭「安装命令 exit 0」认定成功。
