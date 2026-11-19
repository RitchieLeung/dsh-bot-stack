# 事务评论引用回复与待验收浏览器通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `bot-issue` 增加引用回复指定历史评论（含被回复者通知与按 Bot 去重）以及「待验收 / 被回复」浏览器桌面通知功能。

**Architecture:** 在 SQLite `comments` 表增加 `replyToId` 和 `authorSessionId` 并通过 `getFull`/`meta` 暴露摘要与轻量状态变化；在 `host.js` 中将回复对象通知整合进统一去重的通知管线并升级 `issue_get`/`issue_comment`；在 `client.js` 中完成引用回复 UI、点击定位、以及基于全局 `meta` 轮询差分的浏览器 `Notification` 提醒与授权控制。

**Tech Stack:** Node 24 (`node:sqlite`, `node:test`), ESM, Cordis host plugin, zero-build React `client.js`

**Spec:** `docs/2026-11-19-reply-and-notifications-design.md`

## Global Constraints

- 所有给用户或模型看的文案与 `output.render` 一律使用中文人话，不暴露内部状态码（如 `open`/`in_review`）、工具名或版本号。
- 评论编号展示不使用 `#<数字>`，避免触发 `client.js` 中事务引用正则 `REF_SPLIT`。
- 工具 JSON Schema 属性只使用单一 `type` 字符串（不得使用 type 数组）。
- `lib/client.js` 中 `UNREAD_KEY` 到 `function Icon` 之间的片段必须保持对 `test/badge.test.js` 的 Node 无 DOM 环境兼容。
- `npm run check`（语法检查 + 全部单测）必须 100% 通过。

## Review Focus

- 跨事务伪造 `replyToId`（用事务 B 的评论 id 去回复事务 A）必须被 store 拒绝，不能写入跨事务引用。
- 旧数据库升级后（原 `comments` 表无 `replyToId`/`authorSessionId`）打开不能报错，且历史评论能正常读写。
- 同一次回复同时触发「被回复作者 + `@` 提及 + 对侧知会」指向同一只 Bot 时，只能发出一次 `sessionController.prompt`（且自己回复自己时不通知自己）。
- 浏览器页面刷新/首次加载时，已有的「待验收」事务和历史「回复用户的评论」不得误弹窗；只有后续新进入或重新进入「待验收」/新回复时才弹窗。
- 在 `window.Notification` 缺失、非安全上下文或权限为 `denied` 时，面板不得抛错且能正常使用与显示红点。

---

### Task 1: Store 支持 `replyToId`、`authorSessionId`、`replyTo` 摘要与 `userReplies` / `versions` 状态

**Files:**
- Modify: `lib/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Produces:
  - `store.comment(id, { body, authorKind, authorName, authorSessionId, kind, replyToId })` → returns `{ id, issueId, authorKind, authorName, authorSessionId, body, kind, replyToId, replyTo, at }`
  - `store.get(id).comments[]` → includes `replyToId`, `authorSessionId`, `replyTo` (`{ id, authorKind, authorName, authorSessionId, kind, at, preview } | null`)
  - `store.versions()` → `[{ id, number, title, status, version, updatedAt }]`
  - `store.userReplies(limit = 20)` → `[{ id, issueId, issueNumber, issueTitle, authorKind, authorName, preview, at }]`

- [ ] **Step 1: 在 `test/store.test.js` 写失败测试**（引用回复建链与 `replyTo` 摘要、跨事务拒绝、旧库迁移、`versions()` 带 `title`/`status`、`userReplies()` 仅列非用户对用户评论的回复）。
- [ ] **Step 2: 跑 `node --test test/store.test.js` 确认新测试失败**。
- [ ] **Step 3: 实现 `lib/store.js` 的表迁移、校验逻辑与查询方法**。
- [ ] **Step 4: 跑 `node --test test/store.test.js` 确认全绿**。

---

### Task 2: Handler 与 Host 通知管线（被回复者通知 + 去重）及工具 `issue_get` / `issue_comment`

**Files:**
- Modify: `lib/handler.js`
- Modify: `lib/host.js`
- Modify: `skills/issue-workflow/SKILL.md`
- Test: `test/handler.test.js`, `test/host.test.js`

**Interfaces:**
- Consumes: `store.comment(..., { replyToId, authorSessionId })`, `store.userReplies()`, `store.versions()`
- Produces:
  - `POST /api/bot-issue` `{ action: 'comment', id, body, replyToId }`
  - `POST /api/bot-issue` `{ action: 'meta' }` → includes `userReplies` and `versions` with `status` & `title`
  - Tool `issue_comment({ id, body, images, replyTo })`
  - Tool `issue_get` timeline lines with `[评论 <id>]`

- [ ] **Step 1: 在 `test/handler.test.js` 与 `test/host.test.js` 写失败测试**（HTTP `comment` 传 `replyToId`；`meta` 返回 `userReplies` 与 `versions.status`；回复非对侧第三位 Bot 评论时该 Bot 收到 prompt；同一 Bot 既是 `@` 又是被回复者又是执行人时只发一次 prompt；自己回复自己不通知；`issue_get` 展示 `[评论 id]` 且不触发 `#N`；`issue_comment` 带 `replyTo` 落库并通知原评论作者）。
- [ ] **Step 2: 跑 `node --test test/handler.test.js test/host.test.js` 确认新测试失败**。
- [ ] **Step 3: 更新 `lib/handler.js`、`lib/host.js` 与 `skills/issue-workflow/SKILL.md`**。
- [ ] **Step 4: 跑 `node --test test/handler.test.js test/host.test.js test/skill.test.js` 确认全绿**。

---

### Task 3: Client 引用回复交互与浏览器待验收/被回复桌面通知

**Files:**
- Modify: `lib/client.js`
- Test: `test/badge.test.js`, `test/client-load.test.js`

**Interfaces:**
- Consumes: `meta` (`versions[].status`, `versions[].title`, `userReplies[]`), `call('comment', { id, body, authorKind: 'user', replyToId })`, `bot-issue:open` / `bot-issue:focus` accepting `{ number, id }`

- [ ] **Step 1: 在 `test/badge.test.js` 与 `test/client-load.test.js` 写失败测试**（首次轮询不误报已有 `in_review` / 已有 `userReplies`；后续状态新进入 `in_review`、打回后再次进入 `in_review`、以及新 `userReply` 触发 `Notification` 且点击回调派发打开事件；在 `in_review` 状态仅评论不重复弹窗；无 `Notification` API 时安全降级；`client.js` 包含回复交互、引用跳转、授权按钮且无语法/沙盒加载错误）。
- [ ] **Step 2: 跑 `node --test test/badge.test.js test/client-load.test.js` 确认新测试失败**。
- [ ] **Step 3: 实现 `lib/client.js` 的引用回复 UI、跳转高亮、标签汉化、10s+切回前台轮询、`Notification` 检测与头部通知按钮**。
- [ ] **Step 4: 跑 `npm run check` 验证全部语法检查与全量单测全绿**。
