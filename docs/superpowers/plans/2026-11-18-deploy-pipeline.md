# 安装与 146 发布管道实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让外部用户可复制安装/激活三件套，并让维护者用 `npm run deploy:146` 安全升级 146。

**Architecture:** 根目录零依赖脚本负责打包与安装；开发部署生成唯一 prerelease 版本，release 使用正式版本。146 先停服务，完整备份 profile、已安装包和数据，再安装、启动、健康检查，失败同时回滚代码与数据。

**Tech Stack:** Node 24 ESM、node:test、bash、npm/pnpm、ssh/rsync、systemd、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-11-18-deploy-pipeline-design.md`

## Global Constraints

- Node `>=24.19 <25`，DSH `0.2.2-rc.1`
- 不改本机线上 workspace，不部署私有电子书
- 开发包必须唯一版本；所有包有 SHA256 和 manifest
- 146 修改 profile 前必须停服务并完成数据备份
- 安装器幂等，bundle 不重复，失败恢复已修改内容
- 不输出密钥，不自动改写模型/IM/Bot 配置

## Review Focus

1. 同 name@version 连续部署不能静默 no-op → Task 1 的两次 dev pack + pnpm 重装测试。
2. 安装到第二个包失败不能留下半套 profile → Task 2 的失败恢复测试。
3. bundle 已存在时不能重复，其他配置不能丢 → Task 2 的幂等测试。
4. tarball 被篡改必须在任何写入前失败 → Task 2 的 SHA256 测试。
5. 健康检查失败必须同时恢复代码与数据 → Task 3 的脚本检查 + 146 实际故障路径审阅。
6. 文档命令不能依赖作者本机绝对路径 → Task 4 干净 clone 验证。

---

### Task 1: 可复现打包

**Files:** Create `package.json`, `scripts/pack.mjs`, `test/pack.test.js`; Modify `.gitignore`

**Interfaces:** Produces `dist/manifest.json`：`{stack:{head,buildId,mode},packages:[{directory,name,baseVersion,version,filename,sha256,bytes}]}`。

- [ ] 写测试：三个 fixture 包能打包；两次 dev pack 版本不同；release pack 保留原版本；SHA256 与文件一致；临时 consumer 连续 `pnpm add` 后版本确实变化。
- [ ] 跑 `node --test test/pack.test.js`，确认因脚本不存在失败。
- [ ] 实现 `pack.mjs`：staging 副本、dev 唯一版本、npm pack、manifest/SHA256；实现根 npm scripts。
- [ ] 跑测试与实际 `npm run pack`，检查三个真实包。
- [ ] 提交。

### Task 2: 幂等安装器

**Files:** Create `scripts/install.mjs`, `test/install.test.js`

**Interfaces:** Consumes Task 1 manifest/tarballs。CLI：`--profile web --dist ./dist [--profile-dir] [--dsh-bin] [--packages-dir] [--backup-root] [--dry-run]`。

- [ ] 写测试：dry-run 不写文件；hash 错误在写入前失败；fake dsh 成功后依赖/持久 tarball/bundle 齐备；重复运行不重复 bundle；第二个包失败恢复 profile 和 package dirs；DSH/Node 版本不符拒绝。
- [ ] 跑测试确认失败。
- [ ] 实现版本检测、SHA 校验、持久包目录、profile/package 备份、dsh plugin add、失败恢复、bundle 激活。
- [ ] 跑测试并检查输出无秘密。
- [ ] 提交。

### Task 3: 146 部署与回滚脚本

**Files:** Create `scripts/deploy-146.sh`, `scripts/remote-deploy.sh`, `test/deploy-script.test.js`

**Interfaces:** Consumes Task 1 dist 和 Task 2 installer；服务默认 `dsh-web.service`，远端根目录 `~/dsh-bot-stack`。

- [ ] 写测试：`bash -n`；dry-run 无 ssh/rsync/systemctl 实执行；脚本包含停服务后备份、完整 bot/dscord 数据快照、唯一版本安装、健康失败恢复 node_modules+profile+数据、保留 5 个 release。
- [ ] 跑测试确认失败。
- [ ] 实现本机 orchestration 和远端 stop→backup→install→start→health/rollback。
- [ ] 跑测试；在本机用临时目录模拟远端文件布局验证备份/恢复函数，不碰真实服务。
- [ ] 提交。

### Task 4: 文档与 CI/Release

**Files:** Modify `README.md`, `.github/workflows/check.yml`; Create `docs/install.md`, `docs/configuration.md`, `docs/usage.md`, `docs/deploy-146.md`, `.github/workflows/release.yml`

- [ ] 写文档检查测试：README 含 requirements、安装、激活、首次使用、deploy:146、回滚链接；无私有电子书安装命令、无作者绝对路径。
- [ ] 跑测试确认失败，再写文档与 workflow。
- [ ] 根 `npm run check` 全绿；干净 clone 按 README 跑到 pack/install dry-run。
- [ ] 提交并 push，确认 GitHub CI 绿色。

### Task 5: 146 试点

**Files:** 无产品代码新增

- [ ] 146 运行 installer dry-run，核对现有版本、数据大小和 profile。
- [ ] 执行 `npm run deploy:146`；记录 release、backup、旧/新 pid。
- [ ] 验证服务、graph、8 个事务工具、现有 Bot 和历史事务仍在。
- [ ] 创建专用试点事务，真实完成主 Bot 派工→worker 评论→主 Bot 验收；若 bot 调度不可用，不伪造，记录具体阻塞。
- [ ] 若健康检查失败，执行自动回滚并验证旧版恢复，再修问题重试。

### Task 6: Release 与最终复核

**Files:** 无新增

- [ ] 打 `stack-v0.1.0` 并推送，确认 release workflow 上传三个 tarball、SHA256、manifest。
- [ ] 从 GitHub Release 在干净目录走安装 dry-run。
- [ ] 推送合并库与 146 镜像，核对 SHA。
- [ ] 派 fresh reviewer 审整支改动；Critical/Important 用 RED→GREEN 修复并重新验证。
- [ ] 收集设计和实施决策、试点证据，完成目标。
