# dsh-plugin-bot-knowledge

在当前 DSH Web 界面里增加一个**知识库**面板：看到每只 DSCord Bot 记了什么，并让每只 Bot 每天 19:00 自动写工作日报。

## 边界（重要）

- **只读**。插件读取 `knowledge.sqlite`，从不写入、不改 schema。Bot 的记忆仍由它自己的 `remember` 工具产生。
- **不修改 dscord**。插件是独立包，通过同一个 profile 加载；升级 dscord 不会破坏它。
- 面板显示的是**记忆库里的原始记录**，不做美化：`status` 不是 `active` 的会带警示徽标，`text` 缺失的显示「（内容不可读）」。

## 数据来源

| 数据 | 位置 | 用途 |
|---|---|---|
| 记忆条目 | `$DSH_HOME/bot/knowledge/knowledge.sqlite` → `memories`（只读） | 时间线、分类、日报 |
| 来源原文引用 | 同库 `sources` | 每条记录的来源行 |
| Bot 名称/职责/会话 | `$DSH_HOME/bot/state.json` → `bots` | 左栏列表、排程目标 |

`DSH_HOME` 未设置时默认 `~/.dsh`；两个路径都可在插件 config 里用 `dbPath` / `statePath` 覆盖。

## 分类约定（展示层，不改库）

| 分类 | 判定 |
|---|---|
| 日报 | `predicate === "daily-report"` |
| 日记 | `facets` 含 `experience`（且不是日报） |
| 知识 | 其余；`facets` 含 `decision` / `preference` 时显示「决定」/「偏好」 |

## 每日工作日报

- 每只 Bot 一条排程任务，标题 `bot-daily-report:<botId>`，每天 **19:00（Asia/Shanghai）**。
- 投递目标是该 Bot 当前的**前台 session**（`state.json` 的 `bots[].sessionId`）。
- prompt 要求 Bot 调用 `remember` 写一条记忆：
  - `predicate = "daily-report"`
  - `topic = 当天日期（YYYY-MM-DD）`
  - `kind = "inference"`，`facets = ["experience"]`
  - 正文四行：今天做了什么 / 卡在哪、需要谁配合 / 明天计划 / 一句话感想
- **不会给你发消息**：dscord 只把「它自己发起的那一轮」的回复转回聊天（判据是消息带 request marker）；定时投递的 prompt 没有该标记，因此 Bot 写的回复不会被投递到任何房间。日报只落在记忆库里，在面板里看。
- **不会自动排程**：安装或打开面板都不会创建任务。点面板上的「重新排程」才会创建/修复。

### 重新排程的作用

- 缺任务 → 创建；
- session 变了（Bot 换了会话段）→ 改投递目标，**不会**产生第二个任务；
- prompt 变了 → 更新 prompt；
- 已经正确的 → 不动。

dscord 自己也会在 Bot 换会话段时迁移已有定时任务，所以「重新排程」是修复路径，不是每天必点。

## 安装

已作为 bundle 装进 `web` profile：

```bash
# 依赖与 bundles 由 plugin_manager 写入 ~/.dsh/profiles/web/package.json
```

重新安装 / 换机器时：

```
plugin_manager install_bundle → target: file:/Users/ritchie_leung/.dsh/bot/workspace/bot-knowledge
```

装完刷新页面；Host 半会随 profile 加载，Client 半需要刷新一次浏览器。

## 开发

```bash
cd bot-knowledge
node --test "test/*.test.js"
```

测试用 `node:sqlite` 在临时目录建 fixture 库，不碰真实记忆库。

```
lib/classify.js   记忆记录 → 分类（纯函数）
lib/store.js      只读打开库、查 Bot/条目/日报/来源
lib/handler.js    HTTP 动作分发（bots/entries/reports/schedules/ensure-schedules）
lib/schedule.js   每日日报排程的幂等创建与修复
lib/host.js       Cordis 插件入口：注册 /api/bot-knowledge
lib/client.js     浏览器插件：sidebar.panellist 图标 + main 面板
```

## 排查

| 现象 | 处理 |
|---|---|
| 面板显示「找不到记忆库」 | 库里路径不存在。检查 `~/.dsh/bot/knowledge/knowledge.sqlite`，或给插件配 `dbPath`。 |
| 面板显示「读取失败」 | 读权限或 WAL 被独占。点「重试」；确认库文件可读。 |
| 图标没出现 | 看浏览器 console 是否报 `__ModuleLoader__` 错误；确认 profile 的 bundles 含 `dsh-plugin-bot-knowledge`。 |
| 日报排程 N/5 上不去 | Host 半取不到 `ctx.schedule`；确认 `dsh-web-app` 的 schedule 行已启用。 |
| 某只 Bot 一直是「还没有记忆」 | 这只 Bot 确实没写过记忆（正常，例如新 Bot）。 |
