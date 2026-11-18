# 安装与 146 发布管道设计

日期：2026-11-18
状态：待用户批准

## 意图

让两件现在靠手工和记忆完成的事变成可复制流程：

1. 别人拿到 `dsh-bot-stack` 后，能按文档安装、激活、配置并使用 dscord、事务、知识库。
2. 本机开发测试完成后，可以用一条命令把同一份代码部署到 146，并知道部署是否成功、失败如何回滚。

## 当前事实

- 本机公开合并库在 `~/Documents/dsh-bot-stack`，线上工作目录仍是 `~/.dsh/bot/workspace/`；本设计不迁移本机线上目录。
- 146 已经运行同三件套，源目录为 `~/dscord-fork`、`~/bot-issue`、`~/bot-knowledge`，不是空白安装。
- 146 的 dsh 由系统服务 `dsh-web.service` 托管，`Restart=always`，Node 24 位于 `~/.nvm/versions/node/v24.22.2/bin`。
- 146 的事务代码比本机旧；现有事务库约 80K、记忆库约 9.5M，必须保留。
- `dsh plugin add` 只安装依赖，不会自动把包名加入 `dsh.profile.bundles`；安装器必须同时完成激活。
- dscord 需要 Node `>=24.19.0 <25`，DSH 契约基线为 `0.2.2-rc.1`。

## 目标

- 根 README 提供从 prerequisites 到首次使用的完整路径，不只描述架构。
- 一个幂等安装器：可重复执行，安装三个包并激活三个 bundle，不删除用户数据。
- 一个本机到 146 的部署命令：检查、打包、上传、备份、安装、重启、健康检查。
- GitHub Release 自动提供三个 tarball、SHA256 和 manifest，其他用户不必接触本机工作目录。
- 明确升级、回滚、配置和故障排查方法。

## 非目标

- 不把本机 `~/.dsh/bot/workspace/` 改成 monorepo。
- 不自动部署私有电子书，不把它放进公开安装包。
- 不在首次版本里做 Ansible、Docker、Terraform 或完整 CI/CD 平台。
- 不自动生成/提交模型密钥、Matrix 账号或 Bot 身份。
- 不用 rsync 直接覆盖 146 的现有源码目录作为正式部署方式。

## 反目标

- 部署失败导致 146 的 Bot 身份、事务库、记忆库丢失。
- 安装包路径指向一个随后会被删除的临时目录。
- 安装成功但 bundle 没激活，用户只看到「装完了」却找不到面板。
- 部署脚本未经明确步骤就停止/重启服务。
- 文档只适用于作者本机的绝对路径。

## 方案选择

### A. 打包 + 幂等远端安装（采用）

本机生成三个标准 npm tarball，上传到 146 的持久发布目录；远端用 dsh/pnpm 安装，激活 bundle，备份后重启并检查。

优点：安装内容明确、可重复、可校验、可回滚；同一安装器也能服务其他用户。代价是要写少量打包/安装脚本。

### B. 直接 rsync 源目录覆盖（不采用）

最快，但无法清楚描述安装边界，容易留下已删除文件，也不能给外部用户复用。

### C. 只走 GitHub Actions release，146 再手动下载（不作为唯一管道）

适合公开发布，但本机到 146 的开发闭环慢。CI release 作为 A 的补充保留。

## 设计

### 1. 本机打包

根目录新增零依赖 `package.json`：

- `npm run check`：依次运行 bot-issue、bot-knowledge 的 `check`。
- `npm run pack`：执行 `scripts/pack.mjs`。
- `npm run deploy:146`：执行 `scripts/deploy-146.sh`。

`scripts/pack.mjs`：

- 清理并重建仓库内 `dist/`（只限这个已解析目录）。
- 对 `dscord/`、`bot-issue/`、`bot-knowledge/` 分别执行 `npm pack`。
- **开发部署必须在打包 staging 副本里写入唯一 prerelease 版本**（例如
  `0.1.0-dev.202611180951.<sha>`），防止 pnpm 因 name@version 未变而跳过重装；源码里的版本号不被改写。
  GitHub Release 则使用包自身的正式版本。
- 生成 `dist/SHA256SUMS` 和 `dist/manifest.json`，记录包名、原始版本、实际打包版本、
  tarball 文件名、字节数和源 git HEAD。
- `dist/` 加入 `.gitignore`，发布产物不进 git。

### 2. 通用安装器

`scripts/install.mjs` 可在 macOS/Linux 本机或 146 执行：

```bash
node scripts/install.mjs --profile web --dist ./dist
```

行为：

1. 检查 Node `>=24.19 <25`、`dsh` 可用、profile 目录存在；不允许只靠系统旧 Node。
2. 读取 manifest，核对三个 tarball 的 SHA256。
3. 把 tarball 复制到持久目录 `~/.dsh/bot/packages/<stack-id>/`，避免 profile 依赖临时目录。
4. 备份 profile 的 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml` 到带时间戳的备份目录。
5. 用 `dsh plugin --profile <name> add <tarball>` 安装三个包；这一步由 pnpm 更新依赖和 lockfile。
6. 幂等地把 `dscord`、`dsh-plugin-bot-knowledge`、`dsh-plugin-bot-issue` 加入 `dsh.profile.bundles`，保留现有 bundle 顺序和其他配置。
7. 不主动重启；输出「已安装，需要重启」和后续检查方法。重启由部署脚本或用户显式执行。
8. 默认不动 `~/.dsh/bot/state.json`、任何 sqlite、 attachments 或模型/IM 配置。

### 3. 本机到 146 一条命令

```bash
npm run deploy:146
```

`scripts/deploy-146.sh`：

1. 默认要求合并库 git 工作区干净，记录 HEAD；`--allow-dirty` 仅用于显式调试。
2. 本机运行 `npm run check && npm run pack`。
3. 通过 ssh/rsync 上传 `dist/` 和安装器到 `146:~/dsh-bot-stack/releases/<timestamp>-<head>/`。
4. 远端预检：确认 DSH 恰为 `0.2.2-rc.1`、Node `>=24.19 <25`、registry 可用；
   当前 dscord manifest 与本机一致，没有新增依赖，安装统一加 `--ignore-scripts`。
5. **先停止 `dsh-web.service` 并等端口关闭，再修改任何 profile/DB。** 这样避免 HMR 在
   pnpm 安装中途读到半套 profile，也保证 sqlite/WAL 快照一致。146 已确认有免密 sudo。
6. 停止后完整备份：
   - profile 的 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`；
   - 三个已安装 package 目录（保留链接/目录原貌）；
   - `~/.dsh/bot`（约 15MB）和 `~/.dsh/dscord`（约 81MB），包含事务、记忆、Bot 身份、
     sqlite/WAL 与附件。部署失败需要回滚时，代码与这些数据一起恢复。
7. 使用 Node24 的绝对路径执行通用安装器；可用 `DSH_NODE_HOME` 覆盖，默认匹配 146 当前 Node24。
   `pnpm add` 会把原来的 `file:~/dscord-fork` / `link:~/bot-issue` 等依赖切换为持久 tarball；
   146 的 `cordis.patch.yml` 只有模型 provider 配置，没有插件路径，不需要改写。回滚则恢复
   原来的 file/link specs 和对应 package 目录。
8. 安装成功后显式 `systemctl start dsh-web.service`。失败则停止并给出明确命令，不假装成功。
9. 等服务监听 3080，读取 `/plugins/events`，确认三个 client entry 出现；确认服务 active、
   事务 `tools.json` 注册成功且没有 failed，并检查启动日志没有配置/schema 错误。
10. 失败时再次停止服务，恢复 profile、三个 package 目录和数据快照，按恢复的 lockfile 做
    `pnpm install --frozen-lockfile`，再启动并检查旧版本健康；保留失败 release 用于排查。
11. 保留最近 5 个 release，只有确认新 release 健康后才清理更老 release；不清理旧源目录。

部署脚本的所有远端写操作只发生在显式运行 `npm run deploy:146` 时；构建、测试和 dry-run 不触发重启。

### 4. GitHub Release

新增 tag 触发的 workflow，例如 `stack-v0.1.0`：

- checkout、Node24、运行根 `check` 和 `pack`。
- 用 GitHub 提供的 `GITHUB_TOKEN` 创建 release。
- 上传三个 tarball、`SHA256SUMS`、`manifest.json`。
- 公开 README 同时支持「下载 release 安装」和「clone 后自行 pack 安装」。

### 5. 文档

- 根 `README.md`：项目简介、要求、快速安装、首次使用、检查/部署命令、文档入口。
- `docs/install.md`：release/source 两种安装、bundle 激活原理、Node24、常见错误。
- `docs/configuration.md`：模型凭据、DSCord Core/PWA 地址与账号、主 Bot/同事、数据位置；不包含任何真实秘密。
- `docs/usage.md`：连接 Bot → 建事务 → 主 Bot 派工 → worker 闭环 → 主 Bot 验收 → 知识库查看。
- `docs/deploy-146.md`：本机部署、备份、回滚、保留策略、健康检查。
- `bot-restart` 保持独立安装，不要求用户为使用 stack 先装它。

## 试点验收

1. 本机所有检查通过，三个 tarball 内容完整且 SHA256 可复核。
2. 在临时 profile/临时 HOME 做安装器 dry-run 或隔离安装验证，不拿本机线上 profile 做第一次试验。
3. 146 安装前备份存在且可恢复，现有数据目录的 inode/内容不因安装器被改写。
4. 部署后 `dsh-web.service` active，三个插件在 graph 中，8 个事务工具注册成功，无 failed。
5. 146 页面可见 DSCord、事务、知识库；已有 Bot 和历史事务仍在。
6. 创建一条专用试点事务，完成「主 Bot 派工 → worker 评论 → 主 Bot 验收」链路；不伪造闭环结果。
7. GitHub CI 和 release workflow 均实际跑通；公开文档中的安装命令在干净 clone 中验证。

## 留给实现者

- release tag 的具体首个版本号（建议 `stack-v0.1.0`）。
- 健康检查等待间隔和上限（建议 60 秒）。
- 对 146 的 systemctl 权限，若当前账号不能重启则明确提示用户执行，不绕过权限。
- 旧 release 的保留数量可通过环境变量调整。
