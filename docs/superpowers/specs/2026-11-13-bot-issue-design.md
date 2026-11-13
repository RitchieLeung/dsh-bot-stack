# 事务管理模块（issue）设计

日期：2026-11-13
状态：待批准（v2，按 2026-11-13 评审更新）

## 意图与原因

每件事从一个 issue 出发：创建 → 讨论 → 启动 → 主 bot 接活并调度 → worker 执行 →
闭环者写回 → issue 闭环。

现在的事分散在群聊和私聊里，没有持久的 issue 状态和历史。派工结果只回到
"来源消息"那个房间，事后无法追溯"这件事派给谁了、进展到哪、结果是什么"。issue
要成为每件事的唯一入口和完整记录。

## 目标

- issue 是一等对象：标题、正文、状态、经办人、时间线、评论、结果。
- 「事务」面板：列表、新建、详情、评论、状态流转。
- 主 bot 有 issue 工具：创建、更新、评论、查询、派工登记。
- 派工复用 dscord 现有的 `dispatch_work`；worker 汇报后由主 bot 把结果写回 issue。

## 非目标

- 不做跨机器共享 issue（每个 dsh 的主 bot 各自管理自己的 issue）。
- 不替代群聊：团队讨论仍在群里进行，issue 评论只记录结论/决定。

## 约束

- 主 bot 按机器取（Mac = 鲸鱼，146 = 小欣），不写死某个名字；用 dscord 已有的
  `mainBotIds` / 主 bot 标记。
- 派工必须复用 dscord 的 `dispatch_work`，不另造 worker/任务机制。
- 面板沿用 `dsh-plugin-bot-knowledge` 的形态（Host + Client 两个 half）。
- issue 数据存各自机器的 dsh。

## 方案（已选 B）

| 方案 | 描述 | 结论 |
|---|---|---|
| A. 复用 dscord 任务台账 | issue = `dispatch_work` 的任务 + 列表面板 | 最快，但任务台账是临时的、无历史/状态/评论 |
| **B. 新做「事务」插件** | 独立插件：issue 存储 + 面板 + 主 bot 的工具；派工复用 dscord | **已选** |
| C. 扩展知识库插件 | 在 `dsh-plugin-bot-knowledge` 里加 tab | 知识库只读展示，耦合浑浊 |

## 设计

### 1. 数据（Host 插件，SQLite）

`~/.dsh/bot/issue/issue.sqlite`：

- `issues`：`id, title, body, status, mainBotId, parentId, plain, createdAt, updatedAt, closedAt, result`
- `comments`：`id, issueId, author, body, at`（评论同时充当时间线）
- `dispatches`：`issueId, taskId, workerSessionId, at`（把 dscord 的 task 回链到 issue）

状态机：`open → discussing → dispatched → in_progress → done | failed | cancelled`

### 2. 主 bot 的工具（Host 插件注册的 dsh 工具）

- `issue_create(title, body, parentId?, plain?)` → 新 issue
- `issue_list(status?, parentId?)` → issue 列表
- `issue_get(id)` → issue + 评论 + 派工记录
- `issue_update(id, status?, result?)` → 更新状态/结果
- `issue_comment(id, body)` → 追加评论
- `issue_dispatch(id, taskId, workerSessionId)` → 登记派工（提供 issue↔task 的 join key）

**注意**：这些工具必须在 dscord-fork 的 `FRONT_TOOLS` 里放行，否则主 bot 调用会被
guard 拒绝。改法：把名单做成**可配置的 extra front tools**，避免以后每加一个插件都改 fork。

### 3. 面板（Client 插件）

侧边栏「事务」+ 主面板：

- 列表：按状态筛选、搜索标题、按 parentId 显示子 issue
- 新建：标题 + 正文 + 可挂到父 issue
- 详情：时间线（状态流转 + 评论 + 派工记录 + 结果）
- 操作：启动、关闭、重新打开、打回（重新派工）
- 讨论：issue 评论（用户 + 主 bot）

### 4. 派工与写回

- 面板「启动」→ prompt 主 bot 的会话（带上 issue id）。dscord 的 `dispatch_work` 需要
  一条"要回复的消息"，因此要**把 issue 本身作为派工起点**：fork 侧允许 origin-less 派工，
  origin 由 issue 提供（issueId / 发起人 / 正文），worker 结果回写到 issue 而不是房间。
- worker 完成 → 主 bot 汇总结果 → 调 `issue_update` 写回（skill 行为约定 + MCP 工具共同实现）
- 结果不对 → 主 bot 打回：`task_cancel` 旧任务 + 重新 `dispatch_work`，状态回 `discussing`
- **自动启动**：主 bot 自己创建的 issue（如拆分出的关联 issue）无需人工确认，可直接派工

### 5. 拆分子 issue

- `parentId` 支持一层父子：事情大时主 bot 可拆出关联 issue 并分别指派给 worker
- 若实现成本高，先用评论记录拆分关系，后续再加

### 6. 讨论

- issue 评论记录结论（用户 + 主 bot）
- 需要多方讨论时，主 bot 在群里 @相关方，讨论完把结论评论到 issue

## 留给实现者决定

- 具体 SQL 表结构/索引
- 工具参数与返回 schema
- 面板具体布局与样式（沿用知识库的视觉语言）
- issue → dispatch_work 的 origin 字段映射与提示词
- 子 issue 先做还是先用评论
- extra front tools 的配置形态
