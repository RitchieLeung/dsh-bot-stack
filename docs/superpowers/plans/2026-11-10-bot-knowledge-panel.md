# Bot 知识库面板 + 每日工作日报 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前 DSH Web 界面里加一个「知识库」面板，能看到每只 bot 记了什么；并让每只 bot 每天 19:00 自动写一条工作日报。

**Architecture:** 新建一个 DSH 插件包 `dsh-plugin-bot-knowledge`，装进 `web` profile。Host 半注册同源 HTTPS 路由，只读 `knowledge.sqlite` 和 `state.json`，并用宿主 `ctx.schedule` 维护每只 bot 的每日排程；Client 半用 `window.__ModuleLoader__.load` 注册 `sidebar.panellist` 图标和 `main` 整页面板。不改动 dscord，不写记忆库。

**Tech Stack:** Node 24 `node:sqlite`（只读）、Cordis 插件（`ctx.connection.fetch.register`、`ctx.schedule`）、纯 JS 浏览器插件（`window.__ModuleLoader__.load` + React）、`node --test`。

**Spec:** `docs/superpowers/specs/2026-11-10-bot-knowledge-panel-design.md`

## Global Constraints

- 插件 id `bot-knowledge`；包名 `dsh-plugin-bot-knowledge`；locale 命名空间 `bot-knowledge`。
- 只用 Node 24 内置 `node:sqlite`；**不新增任何 npm 依赖**。
- `knowledge.sqlite` **只读**：任何代码路径都不得写、不得改 schema、不得 VACUUM。
- 不修改 `/Users/ritchie_leung/.dsh/profiles/web/node_modules/dscord/` 下任何文件。
- Client 半是**普通脚本**（不是 ESM），唯一入口是 `window.__ModuleLoader__.load({ id, factory })`；`factory(require)` 里可 `require('react')`。图标用内联 SVG，不猜 primitives 的导出名。
- 样式只用主题 token：`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1`、`--dsw-alias-bg-layer-2`、`--dsw-alias-border-l1`、`--dsw-alias-border-l2`、`--dsw-alias-label-primary`、`--dsw-alias-label-secondary`、`--dsw-alias-brand-primary`、`--dsw-alias-state-error-primary`、`--dsw-alias-state-warn-primary`、`--dsw-alias-state-success-primary`。
- 默认路径：`~/.dsh/bot/knowledge/knowledge.sqlite`、`~/.dsh/bot/state.json`，可用 `DSH_HOME` 覆盖。
- 日报约定：`predicate = 'daily-report'`、`topic = 'YYYY-MM-DD'`（Asia/Shanghai）、任务标题 `bot-daily-report:<botId>`、时间 19:00。
- 界面文案用中文；未知数据一律如实显示"未知/看不到"，不臆测。
- 每个任务结束前 `node --test` 必须全绿。

## Review Focus

按最可能翻车的顺序：

1. **记忆库不存在或路径变了**（用户删过、换过 DSH_HOME）→ 面板必须明确报"找不到记忆库"并给出路径，**不能显示成"这只 bot 没有记忆"**。
2. **bot 在 state.json 里但库里 0 条** → 显示"还没有记忆"，与第 1 条区分开。
3. **只读打开失败**（WAL 被独占 / 权限不足）→ 报错、可重试，页面不白屏、不崩溃。
4. **重新排程**（dscord 换 segment 后 session id 变了）→ 必须 edit 已有任务，**不能创建出第二个 19:00 任务**。
5. **记忆 json 字段损坏**（`predicate` 非字符串、`facets` 非数组、`text` 缺失）→ 分类与渲染都不能抛异常，落到 knowledge 类别、文本显示"（内容不可读）"。

---

### Task 1: 包骨架 + 最小可见面板（Stage 0 spike）

**Files:**
- Create: `bot-knowledge/package.json`
- Create: `bot-knowledge/cordis.patch.yml`
- Create: `bot-knowledge/lib/host.js`
- Create: `bot-knowledge/lib/client.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `package.json` 的 `dsh.bundle.patch = "./cordis.patch.yml"`、`dsh.client = { "platform": "web", "immediately": true }`、`exports` 含 `"."` → `./lib/host.js` 和 `"./client"` → `./lib/client.js`
  - `lib/host.js`：`export const name = 'bot-knowledge'`、`export const inject = ['connection']`、`export async function apply(ctx, config)`
  - `lib/client.js`：注册 `sidebar.panellist`（`id: 'bot-knowledge'`、`order: 30`）与 `main`（`key: 'bot-knowledge'`）

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "dsh-plugin-bot-knowledge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./lib/host.js",
  "exports": { ".": "./lib/host.js", "./client": "./lib/client.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "immediately": true } }
}
```

- [ ] **Step 2: 写 `cordis.patch.yml`**

```yaml
- insert:
    - id: bot-knowledge
      name: 'dsh-plugin-bot-knowledge'
```

- [ ] **Step 3: 写最小 `lib/host.js`**

`apply` 里只做一件事：`ctx.connection.fetch.register({ path: '/api/bot-knowledge', methods: ['POST'], requestBody: 'buffered', async fetch(request) { ... } })`，对任意 body 返回 `{ ok: true, value: { hello: true } }`。用 `ctx.effect(() => disposer, 'bot-knowledge: route')` 挂卸载。

- [ ] **Step 4: 写最小 `lib/client.js`**

普通脚本，末尾调用 `window.__ModuleLoader__.load`。`factory` 内：`const React = require('react')`；`apply(ctx)` 里 `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'bot-knowledge', label: () => '知识库', order: 30 }, Icon))` 与 `ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'bot-knowledge' }, Page))`。`Icon` 返回一个内联 SVG（书本形），`Page` 返回一行文字「知识库」。返回 `{ inject: ['slots'], apply }`。

- [ ] **Step 5: 装进 web profile（需要工作区外写入，逐条审批）**

先备份 `/Users/ritchie_leung/.dsh/profiles/web/package.json`，然后二选一：
- 用 plugin_manager `install_bundle`，spec 为 `file:/Users/ritchie_leung/.dsh/bot/workspace/bot-knowledge`；
- 或手工在 profile 的 `package.json` 加 `"dsh-plugin-bot-knowledge": "file:/Users/ritchie_leung/.dsh/bot/workspace/bot-knowledge"` 到 `dependencies`、加 `"dsh-plugin-bot-knowledge"` 到 `dsh.profile.bundles`，再在 profile 目录跑 `pnpm install --ignore-scripts`。

**若需要重启 `dsh web` 才能生效，先停下来问用户**——重启可能中断当前会话。

- [ ] **Step 6: 验证 panel 出现**

刷新 `http://127.0.0.1:3080`，预期：左侧栏多一个书本图标（在 DSCord 图标之后），点开是整页，显示「知识库」两字。
Expected: 图标可见、页面可打开。若图标没出现，先看浏览器 console 是否报 `ModuleLoader`/`register` 错误，再看 profile 启动日志里插件是否加载。

- [ ] **Step 7: Commit**

```bash
cd /Users/ritchie_leung/.dsh/bot/workspace/bot-knowledge && git init -q 2>/dev/null; git add -A && git commit -m "feat: bot-knowledge plugin skeleton with visible panel"
```

---

### Task 2: 记忆分类模块

**Files:**
- Create: `bot-knowledge/lib/classify.js`
- Test: `bot-knowledge/test/classify.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `export function classifyMemory(memory) -> { category: 'daily-report' | 'journal' | 'knowledge', subtype?: 'decision' | 'preference' }`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMemory } from '../lib/classify.js';

test('daily-report 优先于 experience', () => {
  assert.deepEqual(classifyMemory({ predicate: 'daily-report', facets: ['experience'] }), { category: 'daily-report' });
});
test('experience facet 归为 journal', () => {
  assert.deepEqual(classifyMemory({ predicate: 'release-window', facets: ['experience'] }), { category: 'journal' });
});
test('decision / preference 作为 knowledge 子类', () => {
  assert.deepEqual(classifyMemory({ predicate: 'model-choice', facets: ['decision'] }), { category: 'knowledge', subtype: 'decision' });
  assert.deepEqual(classifyMemory({ predicate: 'language', facets: ['preference'] }), { category: 'knowledge', subtype: 'preference' });
});
test('普通事实是 knowledge', () => {
  assert.deepEqual(classifyMemory({ predicate: 'role', facets: [] }), { category: 'knowledge' });
});
test('字段损坏不抛异常', () => {
  for (const bad of [{}, { predicate: 42 }, { facets: 'experience' }, null, undefined]) {
    assert.doesNotThrow(() => classifyMemory(bad));
    assert.equal(classifyMemory(bad).category, 'knowledge');
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd bot-knowledge && node --test test/classify.test.js`
Expected: FAIL，`Cannot find module '../lib/classify.js'`

- [ ] **Step 3: 实现 `lib/classify.js`**

`classifyMemory` 接收任意值；`predicate` 只认字符串。判定顺序：`predicate === 'daily-report'` → daily-report；`facets` 是数组且含 `'experience'` → journal；`facets` 含 `'decision'` / `'preference'` → knowledge + subtype；否则 knowledge。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd bot-knowledge && node --test test/classify.test.js`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add lib/classify.js test/classify.test.js && git commit -m "feat: classify memories into report/journal/knowledge"
```

---

### Task 3: 只读数据读取模块

**Files:**
- Create: `bot-knowledge/lib/store.js`
- Create: `bot-knowledge/test/fixtures.js`
- Test: `bot-knowledge/test/store.test.js`

**Interfaces:**
- Consumes: `classifyMemory` from Task 2
- Produces:
  - `export function openKnowledgeStore({ dbPath, statePath }) -> store`
  - `store.bots({ date }) -> Array<{ id, name, role, model, memoryCount, reportCount }>`
  - `store.entries({ botId, category, limit = 50, offset = 0 }) -> { items, shown, total }`，`item = { id, botId, botName, text, kind, predicate, facets, scope, status, observedAt, topic, category, subtype, sources: [{ id, revision, authorId, roomId, eventId }] }`
  - `store.reports({ date }) -> Array<{ botId, botName, date, text, observedAt, memoryId }>`
  - `store.close()`
  - 错误码：`KNOWLEDGE_DB_MISSING`、`KNOWLEDGE_STATE_MISSING`、`KNOWLEDGE_DB_UNREADABLE`

- [ ] **Step 1: 写 `test/fixtures.js`**

`export function makeFixture()`：在 `mkdtemp` 目录下用 `node:sqlite` 建库，按真实 schema 建 `memories(id TEXT PRIMARY KEY, bot TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL)`、`sources(id TEXT, revision INTEGER, json TEXT NOT NULL, PRIMARY KEY(id,revision))`、`source_heads`、`journal`。写入：
- bot `A`：3 条 active 记忆（`role`/knowledge、`release-window`+experience/journal、`daily-report`+topic `2026-11-10`），1 条 superseded；
- bot `B`：0 条记忆；
- 一条 source 被 A 的 knowledge 记忆引用。
另写 `state.json`：`{ version: 1, bots: { A: { id: 'A', name: '甲', role: '职责甲', model: 'm1' }, B: { id: 'B', name: '乙', role: '职责乙', model: 'm2' } } }`。
返回 `{ dir, dbPath, statePath, cleanup }`。

- [ ] **Step 2: 写失败测试 `test/store.test.js`**

覆盖：`bots({date})` 返回两只、A 的 `memoryCount === 3`（只算 active）/`reportCount === 1`、B 的为 0/0；`entries({botId:'A'})` 返回 3 条且带 `botName === '甲'`；`entries({category:'daily-report'})` 返回 1 条；`reports({date:'2026-11-10'})` 返回 A 的一条；`sources` 里能解析出被引用的 source 的 `authorId/roomId`；数据库路径不存在时抛 `code === 'KNOWLEDGE_DB_MISSING'`；数据库文件存在但内容不是 SQLite（写入 `garbage` 字节）时抛 `code === 'KNOWLEDGE_DB_UNREADABLE'`（Review Focus 3）；`state.json` 缺失时抛 `KNOWLEDGE_STATE_MISSING`；记忆 json 缺 `text` 时 `text` 为空串且不抛。

- [ ] **Step 3: 跑测试确认失败**

Run: `cd bot-knowledge && node --test test/store.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 4: 实现 `lib/store.js`**

要点：
- `new DatabaseSync(dbPath, { readOnly: true })`；打开失败按原因区分 `KNOWLEDGE_DB_MISSING`（`ENOENT`）与 `KNOWLEDGE_DB_UNREADABLE`。
- 打开后 `PRAGMA busy_timeout = 2000`。
- `state.json` 每次调用读，解析失败抛 `KNOWLEDGE_STATE_MISSING`。
- 条目：`SELECT json FROM memories WHERE status='active'`（可按 bot 过滤），`JSON.parse` 后 `classifyMemory`，在 JS 里按 `category` 过滤与分页；`total` 是过滤后总数，`shown` 是本次条数。
- 来源：按 `sourceRefs` 的 `id/revision` 查 `sources`，解析 json 取 `authorId/roomId/eventId`；查不到就返回 `{ id, revision, authorId: null, roomId: null, eventId: null }`。
- 读取条目时 `try/catch`：单条解析失败不拖垮整页，该条 `text = '（内容不可读）'`、`category = 'knowledge'`。
- `reports({date})`：`predicate === 'daily-report' && topic === date`，按 `observedAt` 排序。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd bot-knowledge && node --test test/`
Expected: PASS（classify + store 全绿）

- [ ] **Step 6: Commit**

```bash
git add lib/store.js test/fixtures.js test/store.test.js && git commit -m "feat: read-only knowledge store queries"
```

---

### Task 4: HTTP 处理层

**Files:**
- Create: `bot-knowledge/lib/handler.js`
- Test: `bot-knowledge/test/handler.test.js`
- Modify: `bot-knowledge/lib/host.js`（把路由接到 handler）

**Interfaces:**
- Consumes: `openKnowledgeStore`（Task 3）
- Produces: `export function createKnowledgeHandler({ store, schedule }) -> async (body) => { ok: true, value } | { ok: false, error: { code, message } }`
  - `body.action` ∈ `'bots'`、`'entries'`、`'reports'`、`'schedules'`、`'ensure-schedules'`
  - `'bots'` → `{ bots }`；`'entries'` → `{ items, shown, total }`；`'reports'` → `{ date, reports }`
  - `'schedules'` / `'ensure-schedules'` 在本任务先返回 `{ code: 'SCHEDULE_NOT_WIRED' }`

- [ ] **Step 1: 写失败测试 `test/handler.test.js`**

用 Task 3 的 fixture 和真实 store，`schedule` 传 `null`。覆盖：未知 `action` 返回 `error.code === 'UNKNOWN_ACTION'`；`bots` 返回两只；`entries` 带 `botId` 过滤；`reports` 无 `date` 时用今天（Asia/Shanghai）；store 抛 `KNOWLEDGE_DB_MISSING` 时 handler 返回 `error.code === 'KNOWLEDGE_DB_MISSING'` 且 `message` 含库路径（Review Focus 1）；`body` 不是对象时返回 `INVALID_BODY` 不抛。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd bot-knowledge && node --test test/handler.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `lib/handler.js`**

一个 `try/catch` 包住全部；`error.code` 存在就透传，否则 `INTERNAL`。`date` 缺省用 `new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())` 得到 `YYYY-MM-DD`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd bot-knowledge && node --test test/`
Expected: PASS

- [ ] **Step 5: 把 handler 接进 `lib/host.js`**

`apply` 里构造 store（`dbPath`/`statePath` 从 `config` 或 `DSH_HOME` 推导），`createKnowledgeHandler({ store, schedule: null })`，在 `fetch` 里 `await request.json()` 后调用它并 `new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })`。用 `ctx.effect` 在卸载时 `store.close()`。

- [ ] **Step 6: Commit**

```bash
git add lib/handler.js lib/host.js test/handler.test.js && git commit -m "feat: knowledge HTTP handler wired to plugin route"
```

---

### Task 5: 完整面板 UI

**Files:**
- Modify: `bot-knowledge/lib/client.js`

**Interfaces:**
- Consumes: `/api/bot-knowledge`（Task 4 的 `bots`/`entries`/`reports`）
- Produces: 面板组件（内部实现，无对外接口）

- [ ] **Step 1: 实现 `client.js` 的数据层**

`const call = async (action, payload = {}) => { const r = await fetch('/api/bot-knowledge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...payload }) }); const j = await r.json(); if (!j.ok) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return j.value; }`

- [ ] **Step 2: 实现整体布局**

`Page` 用 `React.useState`/`useEffect` 拉 `bots`，两栏布局：左栏 bot 列表（名字 · 职责 · 条数 · 是否有日报），点击选中；右栏标签「全部 / 日记 / 知识 / 日报」+ 条目时间线。无 bot 时显示空状态。

- [ ] **Step 3: 实现条目渲染**

每条：`observedAt` 格式化为本地时间、类别徽标、正文（`text`）、来源行（`authorId · roomId · eventId`，为空显示"来源未知"）、`status !== 'active'` 时显示状态徽标。`text` 为空显示"（内容不可读）"。

- [ ] **Step 4: 实现三种错误状态（Review Focus 1/2/3）**

`error.code === 'KNOWLEDGE_DB_MISSING'` → 居中显示「找不到记忆库」+ `message` 里的路径 + 「重试」按钮；bot 选中但 `items` 为空 → 「这只 bot 还没有记忆」；其它错误 → 「读取失败」+ 消息 + 重试。

- [ ] **Step 5: 注入样式**

在 `apply` 里创建 `<style>` 元素挂到 `document.head`，内容用 `--dsw-alias-*` token；`ctx.effect` 返回的清理函数里移除它。类名统一前缀 `bk-`。

- [ ] **Step 6: 验证**

刷新页面，点开「知识库」：5 只 bot 都在；点鲸鱼（`session-a05e2e6a-...`）能看到条目；条目数与库里一致。
Run: `sqlite3 ~/.dsh/bot/knowledge/knowledge.sqlite "select bot, count(*) from memories where status='active' group by bot;"`
Expected: 面板显示的条数与查询一致。

- [ ] **Step 7: Commit**

```bash
git add lib/client.js && git commit -m "feat: knowledge panel UI with bots, categories and error states"
```

---

### Task 6: 日报排程模块

**Files:**
- Create: `bot-knowledge/lib/schedule.js`
- Test: `bot-knowledge/test/schedule.test.js`

**Interfaces:**
- Consumes: 无（`schedule` 服务以参数注入）
- Produces:
  - `export const REPORT_PREDICATE = 'daily-report'`
  - `export function reportTitle(botId) -> string`
  - `export function reportPrompt({ botName, date }) -> string`
  - `export async function ensureDailyReportSchedules({ schedule, bots, time = '19:00', timeZone = 'Asia/Shanghai' }) -> Array<{ botId, scheduleId, action: 'created' | 'updated' | 'unchanged' }>`

- [ ] **Step 1: 写失败测试**

用假的 `schedule`：`{ list: async () => ({ items }), create: async (req) => ({ id: 'new', ...req }), edit: async (req) => ({ ...req }) }`，并记录调用。覆盖：
- 空列表时每只 bot 各 `create` 一次，`action: 'created'`；
- 已有同名任务且 target sessionId 相同、prompt 相同 → `action: 'unchanged'` 且不调用 `edit`（Review Focus 4）；
- 已有同名任务但 sessionId 变了 → 调用 `edit`（返回 `action: 'updated'`，请求里带 `id`），且 **`create` 调用次数为 0**；
- `reportPrompt` 含「daily-report」「三段」「不要回复」关键字与当天日期。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd bot-knowledge && node --test test/schedule.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `lib/schedule.js`**

`ensureDailyReportSchedules` 先 `schedule.list({ limit: 500 })` 取全部，按 `title` 建索引；逐 bot 比对 `target.kind === 'session' && target.sessionId === bot.sessionId`、`prompt`、`timing`；决定 create / edit / unchanged。`reportPrompt` 生成中文 prompt：说明这是每日本自动日报、用 `remember` 写一条 `predicate="daily-report"`、`topic=<date>`、`kind="inference"`、`facets=["experience"]` 的记忆；正文四行（今天做了什么 / 卡在哪需要谁配合 / 明天计划 / 一句话感想）；**不要回复给人**。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd bot-knowledge && node --test test/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/schedule.js test/schedule.test.js && git commit -m "feat: idempotent daily report scheduling"
```

---

### Task 7: 排程接入 host 与面板

**Files:**
- Modify: `bot-knowledge/lib/handler.js`
- Modify: `bot-knowledge/lib/host.js`
- Modify: `bot-knowledge/lib/client.js`

**Interfaces:**
- Consumes: `ensureDailyReportSchedules`、`reportTitle`（Task 6）；`store.bots()`（Task 3）
- Produces: `handler` 支持 `'schedules'` → `{ items: [{ botId, scheduleId, status, nextRunAt }] }`；`'ensure-schedules'` → `{ results }`

- [ ] **Step 1: 实现 handler 的 schedules 分支**

`'schedules'`：`schedule.list({})` 过滤 `title` 以 `bot-daily-report:` 开头，join `store.bots()` 得到 bot 名，返回 `botId/scheduleId/status/nextRunAt(timing 里的 scheduledAt)`。`'ensure-schedules'`：`ensureDailyReportSchedules({ schedule, bots: store.bots() })` 后返回结果。`inject` 增加 `'schedule'`（可选：`ctx.get('schedule')`，取不到时 `'ensure-schedules'` 返回 `SCHEDULE_UNAVAILABLE`）。

- [ ] **Step 2: host 传入 schedule**

`apply` 里 `const schedule = ctx.get('schedule')`，传给 `createKnowledgeHandler`。默认 19:00 与 `Asia/Shanghai` 从 `config.reportTime`/`config.timeZone` 读。**不要**在插件启动时自动排程——只在用户点按钮时执行，避免每次重载都动任务。

- [ ] **Step 3: 面板加排程条**

「日报」标签下加一行：「日报排程：N/5 已排」+ 每个 bot 的状态点 + 「重新排程」按钮；点击调 `ensure-schedules`，成功后刷新 `schedules`，失败显示错误消息。

- [ ] **Step 4: 单元测试补充**

在 `test/handler.test.js` 加：`schedule` 为 `null` 时 `schedules`/`ensure-schedules` 返回 `SCHEDULE_UNAVAILABLE`；传入假 schedule 时 `schedules` 能按 title 过滤并带 bot 名。

- [ ] **Step 5: 跑测试**

Run: `cd bot-knowledge && node --test test/`
Expected: PASS

- [ ] **Step 6: 真实验证（会创建真实定时任务）**

在面板点「重新排程」，然后：
Run: `sqlite3 ~/.dsh/bot/state.json` 前先复制 `state.json` 备份；
用宿主排程列表核对 5 条 `bot-daily-report:*` 任务；
再点一次「重新排程」，确认任务数仍是 5（Review Focus 4）。
Expected: 5 条任务，重复点击不新增。

- [ ] **Step 7: Commit**

```bash
git add lib/handler.js lib/host.js lib/client.js test/handler.test.js && git commit -m "feat: daily report schedules exposed in panel"
```

---

### Task 8: 文档与端到端验收

**Files:**
- Create: `bot-knowledge/README.md`
- Modify: `bot-knowledge/docs/superpowers/specs/2026-11-10-bot-knowledge-panel-design.md`（如实现与原设计有偏差，改设计并注明）

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 可交付的安装/排程/字段约定文档

- [ ] **Step 1: 写 README**

包含：插件作用与边界（只读、不写库、不改 dscord）；安装步骤（profile 依赖 + bundles + 重启要求）；字段约定表（`daily-report`/`experience`/`decision`/`preference`）；日报排程说明与「重新排程」用法；故障排查（找不到记忆库、只读失败、排程未生效）。

- [ ] **Step 2: 核对只读承诺**

记录 `knowledge.sqlite` 与其 `-wal` 的 sha256 与尺寸，打开面板浏览全部 5 只 bot 后重新记录，比对。
Run: `shasum -a 256 ~/.dsh/bot/knowledge/knowledge.sqlite*`
Expected: 浏览前后一致（`-wal` 可能因其它写入者变化，需注明——若变化，确认来源不是面板进程）。

- [ ] **Step 3: 跑全部测试**

Run: `cd bot-knowledge && node --test test/`
Expected: PASS，无 skip

- [ ] **Step 4: 逐条走验收标准**

对着 spec 第 7 节的 7 条勾选，任一不满足就回到对应任务修。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: bot-knowledge README and acceptance pass"
```
