# 事务规则 + 执行人 / 闭环 / 能力路由 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给事务模块加「执行人」字段与主 Bot-only 指派、能力(运行时 `llm`)+负载路由、闭环认可/打回门、评论同步知会、侧栏未读角标，并内置一份全队共用的「事务规则」skill。

**Architecture:** 改动集中在 `bot-issue` 插件：store 加数据列与状态机 actor 门；新增纯函数 `lib/routing.js` 做能力+负载选人；host 注入 `llm`/`skills` 现查模型能力、注册 skill provider、知会对侧；client 加角标与打回 UI。能力不写死，派工时现查 `ctx.llm.resolveModelInfo().inputModalities`。

**Tech Stack:** Node 22+ / `node:sqlite` / Cordis 插件（`dsh-plugin-bot-issue`）/ `node --test`。

**Spec:** [docs/2026-11-17-issue-workflow-design.md](</Users/ritchie_leung/.dsh/bot/workspace/bot-issue/docs/2026-11-17-issue-workflow-design.md>)

## Global Constraints

- 能力来源必须是运行时 `ctx.llm`，禁止写死模型→能力映射；`inputModalities` 缺省=unknown → 按不能看图（保守）。
- 执行人指派、`in_review→done`（验收通过）、`in_review→dispatched`（打回）只有主 Bot（`actor.isMain`）或人（`actor.kind==='user'`）能做。
- 打回必须带 `rejection` 非空文本，否则拒绝。
- 只重启 front/rescue 上线，不重启 dsh；测试只碰临时库/fake llm/fake sessionController，不碰真实 3080/3082/3099。
- 现有 59+ 测试不得回归。

## Review Focus

1. **图任务但本机无 vision 同事** → 必须返回 `dispatched:false` + 明确 reason，绝不静默派给不能看图的 bot。→ Task 5 测试。
2. **非主 bot 的 agent 调 `assign`/`done`/打回** → 必须 `FORBIDDEN_ASSIGN` / `FORBIDDEN_TRANSITION`。→ Task 2 测试。
3. **打回不带意见** → 必须 `REJECTION_REQUIRED`。→ Task 2 测试。
4. **旧库迁移**（无 `assignee*` 列的历史 issue）→ `ALTER TABLE` 不报错，`assignee` 返回 `null`，`loads()` 不含它。→ Task 1 测试。
5. **`resolveModelInfo` 抛错**（adapter 失败）→ 按不能看图，不崩溃、不派。→ Task 5 测试。

---

### Task 1: store — 执行人字段 + 负载 + versions

**Files:**
- Modify: `lib/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Produces（后续任务依赖）:
  - `issueFrom(row)` 返回对象新增 `assignee: { sessionId, name, at } | null`
  - `assign(id, { sessionId, name }, actor) -> fullIssue`（`FORBIDDEN_ASSIGN` / `INVALID_ASSIGNEE` / `NOT_FOUND`）
  - `loads() -> { [sessionId]: number }`（只统计 `status IN ('dispatched','in_review')` 且 `assigneeSessionId IS NOT NULL`）
  - `versions() -> [{ id, number, version, updatedAt }]`

- [ ] **Step 1: 写失败测试**

`test/store.test.js` 追加：`assignee 字段迁移后默认为 null`、`assign 落库并可重读`、`assign 非主 Bot/人 抛 FORBIDDEN_ASSIGN`、`loads 只统计在手事务`、`versions 返回 id/version`。

```js
test('assign 把执行人落到事务上并可通过 get 读回', () => {
  const store = openIssueStore({ dbPath: tmp });
  const issue = store.create({ title: 't' });
  store.assign(issue.id, { sessionId: 's-1', name: '伟峰' }, { kind: 'user', name: '用户' });
  assert.deepEqual(store.get(issue.id).assignee, { sessionId: 's-1', name: '伟峰', at: <number> });
});
test('loads 只统计进行中/待验收的指派事务', () => {
  // a→s-1(dispatched), b→s-1(in_review), c→s-2(done 不算), d 无 assignee(不算)
  assert.deepEqual(store.loads(), { 's-1': 2 });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/store.test.js`
Expected: FAIL（`assign` is not a function / `loads` is not a function）

- [ ] **Step 3: 实现**

`lib/store.js`：`issues` 表 `ALTER TABLE ADD COLUMN assigneeSessionId TEXT / assigneeName TEXT / assignedAt INTEGER`（迁移，判 `PRAGMA table_info`）；`issueFrom` 返回 `assignee`；新增 `assign`、`loads`、`versions` 三个方法；`assign` 写 `kind='assign'` 评论（有旧执行人则「执行人：旧 → 新」，否则「执行人：新」）并 `touch`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/store.test.js`
Expected: PASS（新增 + 既有全绿）

- [ ] **Step 5: Commit**

```bash
git add lib/store.js test/store.test.js
git commit -m "feat(store): 执行人字段 + loads() + versions()"
```

---

### Task 2: store — 状态机 actor 门 + 打回

**Files:**
- Modify: `lib/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: Task 1 的 `assign`。
- Produces:
  - `TRANSITIONS.in_review` 增加 `'dispatched'`
  - `update(id, patch, actor)`：`patch.rejection`（打回意见）；actor 含 `isMain`；违反门抛 `FORBIDDEN_TRANSITION` / `REJECTION_REQUIRED`

- [ ] **Step 1: 写失败测试**

```js
test('in_review→dispatched 打回重做，且必须带意见', () => {
  const a = store.assign(issue.id, { sessionId: 's-1', name: '伟峰' }, { kind: 'user' });
  store.update(id, { status: 'in_review' }, { kind: 'agent', name: '伟峰', isMain: false });
  assert.throws(() => store.update(id, { status: 'dispatched' }, { kind: 'agent', name: '鲸鱼', isMain: true }), /打回必须写打回意见|REJECTION_REQUIRED/);
  const done = store.update(id, { status: 'dispatched', rejection: '结论不对，重做' }, { kind: 'agent', name: '鲸鱼', isMain: true });
  assert.equal(done.status, 'dispatched');
  // 意见落成 kind='reject' 评论
  assert.ok(store.get(id).comments.some(c => c.kind === 'reject' && c.body.includes('重做')));
});
test('done 和打回只有主 Bot 或人能做', () => {
  // 非主 agent 改 in_review→done 抛 FORBIDDEN_TRANSITION；主 bot 改成功
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/store.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

`lib/store.js` `update()`：`in_review → done` 与 `in_review → dispatched` 前置校验 `actor.kind==='user' || actor.isMain===true`；打回（from=in_review, next=dispatched）要求 `patch.rejection` 非空字符串，成功后在状态评论之外再写一条 `kind='reject'` 评论（正文=rejection）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/store.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/store.js test/store.test.js
git commit -m "feat(store): in_review→dispatched 打回 + done/打回仅主Bot或人"
```

---

### Task 3: handler — assign 动作 + rejection 透传 + versions

**Files:**
- Modify: `lib/handler.js`
- Test: `test/handler.test.js`

**Interfaces:**
- Consumes: Task 1 `assign`/`versions`、Task 2 `update` 的 `rejection`。
- Produces: HTTP 动作 `assign`（`{action:'assign', id, sessionId, name}` → `{ok, value:{issue}}`）；`update` 透传 `rejection`；`meta` 返回 `versions`。

- [ ] **Step 1: 写失败测试**

```js
test('assign 动作把执行人落到事务', async () => {
  const res = await handle({ action: 'assign', id: issue.id, sessionId: 's-1', name: '伟峰' });
  assert.equal(res.ok, true);
  assert.equal(res.value.issue.assignee.name, '伟峰');
});
test('meta 返回 versions', async () => {
  const res = await handle({ action: 'meta' });
  assert.ok(Array.isArray(res.value.versions));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/handler.test.js`
Expected: FAIL（未知动作 `assign` / versions undefined）

- [ ] **Step 3: 实现**

`lib/handler.js`：新增 `assign` 动作（校验 `id`/`sessionId`，以 `{kind:'user'}` 调 `store().assign`）；`update` 动作把 `typeof body.rejection==='string' ? body.rejection : undefined` 透传；`meta` 返回 `versions: resolve().versions()`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/handler.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/handler.js test/handler.test.js
git commit -m "feat(handler): assign 动作 + rejection 透传 + versions"
```

---

### Task 4: routing — 纯函数选人（能力 + 负载）

**Files:**
- Create: `lib/routing.js`
- Test: `test/routing.test.js`（新）

**Interfaces:**
- Produces（Task 5 依赖）:
  - `imageTask(body: string) -> boolean`（`body` 含 `/api/bot-issue?attachment=` 或 `![…](…)`）
  - `specialtyScore(bot: {role,instructions}, issue: {tags,body}) -> number`
  - `chooseAssignee({ candidates, needVision }) -> { assignee: candidate|null, reason: string|null }`（candidate: `{sessionId,name,vision,load,specialty}`）

- [ ] **Step 1: 写失败测试**

```js
test('imageTask 识别附件与图片 markdown', () => {
  assert.equal(imageTask('![x](/api/bot-issue?attachment=abc)'), true);
  assert.equal(imageTask('普通文字'), false);
});
test('图任务没有 vision 候选时拒绝，不瞎派', () => {
  const r = chooseAssignee({ candidates: [{sessionId:'s1',name:'伟峰',vision:false,load:0,specialty:0}], needVision: true });
  assert.equal(r.assignee, null);
  assert.match(r.reason, /看图|vision/);
});
test('负载低者优先；负载相同看 specialty', () => {
  const r = chooseAssignee({ candidates: [
    {sessionId:'a',name:'A',vision:true,load:2,specialty:0},
    {sessionId:'b',name:'B',vision:true,load:0,specialty:1},
  ], needVision: true });
  assert.equal(r.assignee.sessionId, 'b');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/routing.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`lib/routing.js`：纯函数、无 Cordis。`imageTask` 用正则；`specialtyScore` 用 `SPECIALTY_KEYWORDS = ['前端','后端','实施','协调','头脑风暴','算法','运维']` 命中双方文本计数；`chooseAssignee` 先按 `needVision` 过滤（只留 `vision===true`），空则返回 reason，再按 `(load asc, specialty desc)` 排序取第一。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/routing.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/routing.js test/routing.test.js
git commit -m "feat(routing): 能力+负载纯函数选人"
```

---

### Task 5: host — llm 能力现查 + 路由接线 + 知会对侧 + skill provider

**Files:**
- Modify: `lib/host.js`
- Modify: `test/host.test.js`（用 fake llm / fake sessionController）

**Interfaces:**
- Consumes: Task 1 `assign`/`loads`、Task 4 `imageTask`/`chooseAssignee`/`specialtyScore`。
- Produces: `start(issue)` 返回 `{ dispatched, note?, reason?, assignee? }`；`resolveMainBot` 扩展 `sessionIds:Set`；`caller()` 增 `isMain`。

- [ ] **Step 1: 写失败测试**

```js
test('start 图任务只派 vision 同事，无 vision 则拒绝', async () => {
  // fake llm.resolveModelInfo 对 deepseek-v4-pro 返回无 image，对 gemini 返回含 image
  const start = buildStart({ llm: fakeLlm, sessionController: fakeSc, store, mainBot, statePath });
  const res = await start({ id, body: '![图](/api/bot-issue?attachment=x)', tags: [] });
  // 有 gemini 同事时 dispatched=true 且 assignee.name 是 gemini 那位
  // 全部无 vision 时 dispatched=false 且 reason 含「看图」
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/host.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

`lib/host.js`：
- `ctx.inject(['llm'], sub => { llm = sub.llm })`；`visionOf(ref)`（带 10s TTL 缓存，`resolveModelInfo` 失败→false）。
- `botProfiles(statePath)` 返回 `{id,name,sessionId,model,role,instructions}`。
- `resolveMainBot` 加 `sessionIds`；`caller()` 加 `isMain`（`sessionIds.has(sid)`）。
- 重写 `start`：算 `needVision`→候选（vision/load/specialty）→`chooseAssignee`→无 assignee 直接 `dispatched:false`→prompt 主 Bot `message_bot(被点名者, 预写说明)`→成功后才 `assign` + `update(dispatched)`→返回 `{dispatched:true, note, assignee}`。
- `notifyCounterpart(issue, bySessionId)`：`bySessionId===assignee.sessionId`→知会主 Bot；`bySessionId===主Bot`→知会执行人；接线到 `issue_comment`/`issue_update` 工具与 handler 的 `notify`。
- `ctx.inject(['skills'], ...)` 注册 skill provider（见 Task 7 的 `lib/skill.js`）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/host.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/host.js test/host.test.js
git commit -m "feat(host): 运行时能力路由 + 知会对侧 + llm/skills 注入"
```

---

### Task 6: client — 未读角标 + 打回 UI + 执行人显示

**Files:**
- Modify: `lib/client.js`
- Test: `test/badge.test.js`（新，slice 截取纯函数）

**Interfaces:**
- Produces（client 内）: `unreadOf(versions, seen) -> number`、`markSeen(seen, id, version) -> seen`（slice 可测）；侧栏 `Icon` 角标；`Detail` 打回动作 + 执行人显示。

- [ ] **Step 1: 写失败测试**

```js
test('unreadOf 统计 version 大于已读的条数', () => {
  const versions = [{ id:'a', version: 3 }, { id:'b', version: 1 }];
  assert.equal(unreadOf(versions, { a: 2 }), 2); // a 3>2 未读, b 1>0 未读
  assert.equal(unreadOf(versions, { a: 3, b: 1 }), 0);
});
test('markSeen 只升不降', () => {
  assert.deepEqual(markSeen({ a: 5 }, 'a', 3), { a: 5 });
  assert.deepEqual(markSeen({ a: 2 }, 'a', 4), { a: 4 });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/badge.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

`lib/client.js`：把 `unreadOf`/`markSeen` 放进一个可 slice 的连续块；`apply()` 里 `setInterval(20s)` 调 `call('meta')` 取 `versions`，读 `localStorage['bot-issue:seen']` 算未读数更新模块级 `unreadStore`；`Icon` 用 React state 订阅 `unreadStore` 在右上角画数字角标；`Detail` 打开时 `markSeen`；`in_review` 动作改 `[done 验收通过, reject 打回重做(弹意见框必填), cancelled 取消]`；详情显示 `issue.assignee`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/badge.test.js test/mention.test.js test/markdown.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/client.js test/badge.test.js
git commit -m "feat(client): 未读角标 + 打回重做 UI + 执行人显示"
```

---

### Task 7: skill — 「事务规则」provider + SKILL.md + README

**Files:**
- Create: `lib/skill.js`
- Create: `skills/issue-workflow/SKILL.md`
- Modify: `lib/host.js`（若 Task 5 未接线则在此接）
- Modify: `README.md`

**Interfaces:**
- Consumes: `ctx.skills.registerProvider`（服务名 `skills`）。
- Produces: provider `name='bot-issue-workflow'`、skill `name='issue-workflow'`（显示名「事务规则」）、`modelInvocable:true`。

- [ ] **Step 1: 写失败测试**

```js
test('SKILL.md 有 description 且内容覆盖闭环/打回', () => {
  const md = readFileSync(SKILL.md, 'utf8');
  assert.match(md, /^---\r?\n[\s\S]*?description:[\s\S]*?\r?\n---/);
  assert.match(md, /闭环/); assert.match(md, /打回/); assert.match(md, /主 Bot/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/skill.test.js`
Expected: FAIL（文件不存在）

- [ ] **Step 3: 实现**

`lib/skill.js` 参照 dscord `goal-skills.js` 模式：读 `skills/issue-workflow/SKILL.md`，解析 frontmatter `description`，返回 `{name:'bot-issue-workflow', list, get}`。`SKILL.md` 写全规则（起点/派工/执行/协作改派/拆子任务/闭环/打回/评论同步/不得越级/专才+负载+用量窗口）。`host.js` 注册 provider。`README.md` 补一节「事务规则 skill」。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/skill.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/skill.js skills/issue-workflow/SKILL.md lib/host.js README.md test/skill.test.js
git commit -m "feat(skill): 内置「事务规则」provider skill"
```

---

## 完成前总验证

```bash
cd /Users/ritchie_leung/.dsh/bot/workspace/bot-issue
node --test test/*.test.js          # 全绿（原 59+ 不回归）
node --check lib/store.js lib/handler.js lib/host.js lib/routing.js lib/skill.js lib/client.js
```

## 上线（不重启 dsh）

```bash
dsh-plugin-sync bot-issue           # rsync + hmr-nudge + 等 health.json mtime 变新
```
