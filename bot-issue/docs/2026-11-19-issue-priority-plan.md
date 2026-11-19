# 事务需求紧急程度（P0 ~ P3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每条事务增加 `P0`~`P3` 独立紧急程度字段、默认 `P2` 迁移、按优先级置顶排序与筛选，并打通面板 UI 与 Bot 工具。

**Architecture:** 在 SQLite `issues` 表增加 `priority` 列并做大小写归一化校验与优先级排序；通过 `handler.js` 透传到 HTTP 接口，在 `host.js` 更新 4 个工具与派工文案，并在 `client.js` 增加徽标、选择器、筛选条与通知展示。

**Tech Stack:** Node 24 (`node:sqlite`, `node:test`), ESM, Cordis host plugin, zero-build React `client.js`

**Spec:** `docs/2026-11-19-issue-priority-design.md`

## Global Constraints

- 紧急程度固定 `P0`、`P1`、`P2`、`P3`，默认 `P2`。
- 不改动已有自由标签 `tags` 的读写和存储。
- 工具 JSON Schema 属性只使用单一 `type` 字符串。
- `client.js` 中 `UNREAD_KEY..Icon` 区间保持对 `badge.test.js` 无 DOM 环境的兼容。
- `npm run check` 全绿。

---

### Task 1: Store 增加 `priority` 列、迁移、校验、过滤与排序

**Files:**
- Modify: `lib/store.js`
- Test: `test/store.test.js`

- [ ] **Step 1: 在 `test/store.test.js` 写失败测试**（创建默认 `P2`、支持传入/大小写归一化 `p0`→`P0`、拒绝非法值 `INVALID_PRIORITY`、更新修改优先级、旧库无 `priority` 列自动迁移为 `P2`、`list` 按 `P0→P3` 排序与 `priority` 过滤）。
- [ ] **Step 2: 跑 `node --test test/store.test.js` 确认新测试失败**。
- [ ] **Step 3: 实现 `lib/store.js` 字段、迁移、排序与过滤**。
- [ ] **Step 4: 跑 `node --test test/store.test.js` 确认全绿**。

---

### Task 2: Handler 与 Host 工具 / 派工文案接入 `priority`

**Files:**
- Modify: `lib/handler.js`
- Modify: `lib/host.js`
- Modify: `skills/issue-workflow/SKILL.md`
- Test: `test/handler.test.js`, `test/host.test.js`

- [ ] **Step 1: 在 `test/handler.test.js` 与 `test/host.test.js` 写失败测试**（HTTP `meta`/`create`/`update`/`list` 支持 `priority` 并拒绝非法值；Bot 工具 `issue_create`/`issue_update`/`issue_list`/`issue_get` 与 `start` 派工携带紧急程度且 schema 单一类型合法）。
- [ ] **Step 2: 跑 `node --test test/handler.test.js test/host.test.js` 确认新测试失败**。
- [ ] **Step 3: 更新 `lib/handler.js`、`lib/host.js` 与 `skills/issue-workflow/SKILL.md`**。
- [ ] **Step 4: 跑 `node --test test/handler.test.js test/host.test.js test/skill.test.js` 确认全绿**。

---

### Task 3: Client 徽标、选择器、筛选条与通知整合

**Files:**
- Modify: `lib/client.js`
- Test: `test/client-load.test.js`, `test/badge.test.js`

- [ ] **Step 1: 在 `test/client-load.test.js` 与 `test/badge.test.js` 写失败测试**（`client.js` 含优先级徽标、新建/详情选择器、列表优先级筛选条；高优 `P0` 待验收桌面通知带 `[P0]` 标记）。
- [ ] **Step 2: 跑 `node --test test/client-load.test.js test/badge.test.js` 确认新测试失败**。
- [ ] **Step 3: 实现 `lib/client.js` UI 组件、样式、列表筛选及通知标题增强**。
- [ ] **Step 4: 跑 `npm run check` 验证全部语法检查与测试通过**。
