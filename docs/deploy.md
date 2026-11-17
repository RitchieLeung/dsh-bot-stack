# 部署与生效

这份环境里「改代码」和「改线上」是两件事。profile 里的插件是**快照副本**，改 workspace 里的文件不会自动生效。

## 三层生效代价

| 你改了什么 | 需要的动作 | 进程要不要重启 |
|---|---|---|
| 插件 host / client 代码 | 同步到 profile，触发 HMR 重组 | ❌ 不用 |
| profile 的 `package.json` 依赖 / 新增插件 | `pnpm install`，再重载 | ❌ 通常不用 |
| 原生依赖、进程本身、HMR 报「需要重启」 | 重启 `dsh web` | ✅ 要 |

**永远优先选最左边那层。**

## 为什么不能靠软链

试过把 profile 的 `node_modules/<pkg>` 软链回 workspace：插件目录里没有自己的 `node_modules`，`deep-view` 之类的依赖解析失败，整个插件加载不了。

而且 `dsh-hmr` 只「看得见」profile 目录里的模块文件——加载路径在 profile 外面的软链，改了它也不会重载。所以必须装**真实副本**。

## 插件代码：同步 + HMR 重组

`~/bin/dsh-plugin-sync` 做两件事：

1. 把 `$DSH_WORKSPACE/<plugin>` 以真实副本同步进 `$DSH_HOME/profiles/web/node_modules/<pkg>/`
2. 往 `cordis.patch.yml` 追加一行 `# hmr-nudge <ns>`，触发 `dsh-hmr` 的 reconcile——它会停掉那个 entry、用新代码重起，**dsh 进程不变**

```bash
dsh-plugin-sync                # 同步全部
dsh-plugin-sync bot-issue      # 只同步一个
dsh-plugin-sync --dry-run      # 只看会动哪些文件
dsh-plugin-sync --no-nudge     # 只拷文件，不触发重载
```

## dscord fork：sync.sh + 重启

dscord 是 `file:` 依赖，有自己的同步脚本：

```bash
cd <workspace>/bot-knowledge/dscord-fork
./sync.sh --check   # 先看差异
./sync.sh           # 同步
# 重启 dsh web 生效
```

## 急救台

`dsh-rescue` 是独立进程（`:3099`），在面板起不来时用：

- 停用某个插件（坏插件导致整页白屏时）
- 重启 dsh
- 抓登录链接（Cloudflare Access 挡住 3080 时）

前面的 `front`（`:3080`）是固定端口的透传 + 兜底页。隧道在云端配死打 `:3080`，所以 dsh 本体让到 `:3082`，避免抢端口。

## 回滚一个插件

```bash
# 从 profile 摘掉
# 1. 删 package.json 的 dependencies 和 dsh.profile.bundles 里的条目
# 2. pnpm install
# 3. 重载
```

## 排查顺序

1. 面板白屏 / 插件没加载 → 看 profile 的 `node_modules/<pkg>` 在不在、是不是空目录
2. 工具没注册 → 看 `~/.dsh/bot/<plugin>/tools.json`（如果是运行时落盘的）
3. 改了代码但没变化 → 99% 是没同步到 profile，不是 HMR 坏了
4. 一切对但行为怪 → 看 `~/.dsh/bot/logs/diagnostics.jsonl`
