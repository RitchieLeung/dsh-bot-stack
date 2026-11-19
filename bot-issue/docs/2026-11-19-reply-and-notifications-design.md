# 事务评论引用回复与待验收浏览器通知

日期：2026-11-19
状态：已确认（按推荐方案实施）

## 为什么

1. **回复中间某条评论无指向、且被回复者收不到提醒**：目前时间线评论是平铺的，如果事务里有多方参与（主 Bot、执行人、以及被 `@` 进来讨论的第三位同事），回复某条历史评论既看不出回应的是哪一条，也无法直接通知原评论作者。
2. **到「待验收」缺乏主动提醒**：目前只有左侧栏红点角标（20 秒轮询），不切换到浏览器标签页或事务面板容易错过已交验的任务。

## 目标

1. 面板用户和 Bot 都能针对事务时间线中的某一条历史评论发起回复，时间线保留先后顺序并在回复顶部显示可点击跳回的原评论引用条。
2. 回复发出后，**被回复评论的作者**会收到通知：
   - 被回复者是 Bot：host 自动向该 Bot 会话发提醒（与 `@` 提及、对侧提醒按 Bot 去重，不重复刷屏）。
   - 被回复者是用户（面板端）：触发浏览器桌面通知 + 现有未读角标。
3. 事务新进入「待验收」时，向已授权的浏览器发桌面通知，点击通知直接聚焦窗口并打开对应事务。

## 非目标

- 不做楼中楼树形嵌套缩进（会打乱「状态变更 / 结果 / 评论」混排时间线和最近 20 条上下文）。
- 不做编辑或删除已有评论。
- 不依赖额外的 WebSocket/SSE 通道（复用现有轻量 `meta` 轮询，并将周期从 20 秒调整为 10 秒）。

## 设计要点

### 1. 存储与数据结构（`lib/store.js`）
- `comments` 表新增可空列 `replyToId INTEGER` 与 `authorSessionId TEXT`（启动时自动检查并 `ALTER TABLE` 迁移旧库）。
- `comment(id, { body, authorKind, authorName, authorSessionId, kind, replyToId })`：
  - 若传 `replyToId`，校验目标评论存在且属于同一条 `issueId`（否则抛 `INVALID_REPLY_TO` / `NOT_FOUND`）。
  - `getFull(id)` 与 `comment()` 返回每条评论附带 `replyToId` 和组装好的 `replyTo` 摘要（`{ id, authorKind, authorName, authorSessionId, kind, at, preview }`），其中 `preview` 压成单行、图片占位为 `[图片]`、状态词人话化并截断 80 字，确保即使被回复评论早于最近 20 条也能完整展示引用。
- `versions()` 补充 `title` 与 `status` 字段；新增 `userReplies(limit)` 返回近期回复了用户评论的非用户新评论摘要。

### 2. 通知与 Bot 工具（`lib/handler.js`、`lib/host.js`）
- `handler.js` 的 `comment` 动作支持 `replyToId`（兼容别名 `replyTo`），`meta` 返回含 `title`/`status` 的 `versions` 与 `userReplies`。
- `host.js`：
  - `notify` 统一按 Bot 规范身份（`canonicalBotKey`）去重，顺序为：**被回复评论作者 Bot → 正文 `@` 提及的 Bot → 对侧（主 Bot ↔ 执行人）**；自己回复自己不通知。
  - `issue_get` 时间线每行带上 `[评论 <id>]` 与回复指向（不出现 `#<id>`，避免与事务编号 `#N` 链接正则冲突）。
  - `issue_comment` 新增可选整数参数 `replyTo`。
- `skills/issue-workflow/SKILL.md` 补充回复指定评论的指引。

### 3. 面板交互与浏览器通知（`lib/client.js`）
- **引用回复**：时间线每条展示「回复」按钮；点击后在评论框上方展示引用预览条（可取消），提交带 `replyToId`；时间线中带 `replyTo` 的评论顶部渲染引用块，点击可滚动并短暂高亮原评论。顺手补齐 `reject`（打回）和 `assign`（指派）的时间线标签汉化。
- **浏览器桌面通知**：
  - 面板头部提供通知授权/开关控件（`default` 时点选调用 `Notification.requestPermission()`，`granted` 时可暂停/恢复，`denied` 或非安全上下文给出清晰提示）。
  - 全局 `refreshUnread`（10 秒轮询 + 页面切回前台时立即刷新）首次初始化只记录基线不弹窗；后续检测到事务**新进入 `in_review`** 或有**非用户新回复了用户的评论**时，调用 `new Notification(...)`，点击通知调用 `window.focus()` 并打开对应事务详情。
