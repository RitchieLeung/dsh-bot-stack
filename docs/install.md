# 安装与升级

## 前置条件

- Node `>=24.19.0 <25`；DSCord 不支持系统里的旧 Node 10/22。
- DSH `0.2.2-rc.1`。
- 目标 profile 已初始化。默认路径为 `~/.dsh/profiles/web/package.json`；如果还没有，先正常启动一次 `dsh web`。
- dsh、npm/pnpm 可用。非交互 SSH 到服务器时，PATH 可能指向旧 Node，应显式使用 Node24 的绝对路径。

安装器会检查这些版本，不符合时在任何写入前退出。

## 方式 A：GitHub Release

先 clone 与 release 同 tag 的安装器，再下载对应构建产物：

```bash
git clone --branch stack-v0.1.3 https://github.com/RitchieLeung/dsh-bot-stack.git
cd dsh-bot-stack
mkdir -p dist
gh release download stack-v0.1.3 \
  -R RitchieLeung/dsh-bot-stack \
  --dir dist \
  --pattern '*.tgz' --pattern 'manifest.json' --pattern 'SHA256SUMS'
node scripts/install.mjs --profile web --dist ./dist --dry-run
```

`gh` 只用于下载公开 release；没有 gh 时，也可以在浏览器下载同样三个 tarball、`manifest.json`、`SHA256SUMS` 到 `dist/`。

## 方式 B：从当前源码构建

```bash
npm run check
npm run pack:release
node scripts/install.mjs --profile web --dist ./dist --dry-run
```

`pack:release` 保留三个包在 package.json 里的正式版本。开发部署使用 `npm run pack`，会生成唯一 prerelease 版本，避免同名同版本被 pnpm 当作已满足而不重装。

## 正式安装

**如果 dsh 正在运行，先按原方式停止它。** 这样 HMR 不会在 pnpm 写入 profile 的中途加载到半套配置。

```bash
node scripts/install.mjs --profile web --dist ./dist
```

安装器执行：

1. 校验 Node、DSH、manifest 和每个 tarball 的 SHA256。
2. 备份 profile 的 package/lock/patch 文件和三个已安装 package 目录。
3. 把 tarball 复制到 `~/.dsh/bot/packages/<build>/`，避免依赖临时目录。
4. 用 `dsh plugin add` 安装，并加 `--ignore-scripts`。
5. 幂等地把 `dscord`、`dsh-plugin-bot-knowledge`、`dsh-plugin-bot-issue` 加入 `dsh.profile.bundles`。
6. 从事务包的 `pnpm-lock.yaml` 读取规范化 tarball selector，只对这个 selector 执行
   `pnpm approve <selector> --yes`，然后重新 `permissions list` 复核。其他包或权限的
   待批准项保持原样，不使用 `--all`。
7. 安装中途失败时恢复本次修改过的 profile 和 package 目录。

成功后按原方式启动 `dsh web`，再刷新浏览器。安装器本身不重启服务。

### Node/dsh 不在 PATH

```bash
/path/to/node24/bin/node scripts/install.mjs \
  --profile web --dist ./dist \
  --dsh-bin /path/to/node24/bin/dsh
```

### 自定义 profile

`--profile` 决定 dsh plugin 操作哪个 profile；`--profile-dir` 可显式覆盖目录，主要用于测试或非标准布局：

```bash
node scripts/install.mjs \
  --profile my-profile \
  --profile-dir /absolute/path/to/profiles/my-profile \
  --dist ./dist
```

## 验证

- 页面左侧出现 DSCord、事务、知识库。
- 事务插件启动后，`~/.dsh/bot/issue/tools.json` 的 `registered` 应包含 8 个 `issue_*` 工具，`failed` 为空。
- Linux 可读取 `http://127.0.0.1:3080/plugins/events`，确认三个 client entry 存在。

## 升级与回滚

升级就是同一条安装命令换一份新 dist。旧版本备份路径会在安装输出中打印。

安装器只在**安装中途失败**时自动恢复。若新代码已经启动并可能执行数据库迁移，需要同时恢复数据；146 的完整部署脚本已自动处理。其他机器升级前请自行备份 `~/.dsh/bot` 和 `~/.dsh/dscord`。

## 常见问题

| 现象 | 处理 |
|---|---|
| `需要 Node >=24.19 <25` | 用 Node24 的 node 执行安装器，不要靠系统旧 Node。 |
| `需要 DSH 0.2.2-rc.1` | 安装匹配版本，或用 `--dsh-bin` 指向正确安装。 |
| 安装完成但没有面板 | 检查 profile 的 bundles；安装器应已加入三项，然后需要重启 dsh 并刷新页面。 |
| SHA256 校验失败 | 重新下载/打包，不要跳过校验。 |
| 第二次部署内容没变 | 开发部署必须用 `npm run pack` 生成新 build 版本，不能直接复用同名同版本 tarball。 |
