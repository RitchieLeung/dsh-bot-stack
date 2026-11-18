# 事务图片（Bot 贴图 + 跨 Bot 可见）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bot 能用一次工具调用把本地图片贴进事务评论/正文，任何 Bot 读事务时都能拿到图片的本地路径并 `read_image`。

**Architecture:** 在 `lib/host.js` 的工具层加一层薄适配：读本地图片 → 复用 store 现有的 `addAttachment`（mime 白名单、10MB 上限、sha256 去重全现成）→ 把 `![name](url)` 追加进正文。`issue_get` 反过来扫描正文与评论里的 `?attachment=` id，把文件 stage 到共享工作区并返回本地路径。不改客户端、不改 schema。

**Tech Stack:** Node 24 ESM，零依赖；`node:fs` / `node:path` / `node:os`；测试用 `node --test`。

**Spec:** `docs/2026-11-18-issue-images-design.md`

## Global Constraints

- 零依赖、无构建：只能 import Node 内置模块
- 不改客户端 `lib/client.js`（面板已能渲染 markdown 图片）
- 不改数据库 schema（`attachments` 表已有 `issueId`）
- 单张图片上限沿用 store 的 `ATTACHMENT_MAX_BYTES`（10MB）；mime 白名单沿用 `^image/(png|jpeg|jpg|gif|webp|svg\+xml)$`
- 单次工具调用最多 8 张图
- 图片路径必须绝对或 `~` 开头；相对路径一律拒绝
- 「📎 N 张图」只出现在工具 render 文本和 `issue_get` 渲染里，**不写进存储的正文**
- 现有 117 个测试保持全绿；每个任务结束跑 `npm run check`

## Review Focus

1. **相对路径**：Bot 的 cwd 各不相同。给了 `shot.png` 这种相对路径必须报错并说清「请给绝对路径」，不能按 cwd 猜。
2. **重复贴同一张图**：sha256 去重是 store 的行为，第二次上传返回同一 id；评论里出现两次相同 URL 必须正常，不能报错。
3. **`issue_update` 只带 images 不带 body**：必须追加到**现有正文**末尾，不能把正文清空，也不能重复叠加同一次调用里的图。
4. **`issue_get` 反复调用**：stage 目录按 `<sha16>-<name>` 命名，第二次调用必须幂等覆盖同一个文件，不能无限增长。
5. **非图片文件混入**：`notes.txt` 改名成 `shot.png` 必须被 mime 白名单之外的检查挡住或明确报错；大小超限要指出是**哪一张**、多大。
6. **空正文 + 只有图**：`issue_comment(id, '', images)` 必须成功（只发图是有效评论），而 `issue_comment(id, '')` 无图仍然报错。

---

### Task 1: 图片路径 → 附件 + markdown 片段

**Files:**
- Modify: `lib/host.js`（新增两个导出函数，放在 `issuePaths` 之后）
- Test: `test/host.test.js`

**Interfaces:**
- Consumes: `store.addAttachment({ issueId, name, mime, data })` → `{ id, url, name, mime, bytes }`（已有）；`store` 是 `lib/host.js` 内部的惰性取值函数
- Produces:
  - `export function imageMimeFor(filePath: string): string | null` —— 按小写扩展名返回 mime，不认识的返回 `null`
  - `export function attachImages({ store, issueId, images }: { store: () => Store, issueId: string, images: string[] }): { markdown: string, attachments: Array<{ id: string, url: string, name: string }> }` —— 读文件、校验、入库、返回 markdown 行（每行一张，形如 `![shot.png](/api/bot-issue?attachment=abc123)`）；无图片时返回 `{ markdown: '', attachments: [] }`

- [ ] **Step 1: 写失败的测试**

```js
test('imageMimeFor maps extensions and rejects others', () => {
  assert.equal(host.imageMimeFor('/tmp/a.PNG'), 'image/png');
  assert.equal(host.imageMimeFor('/tmp/a.jpeg'), 'image/jpeg');
  assert.equal(host.imageMimeFor('/tmp/a.webp'), 'image/webp');
  assert.equal(host.imageMimeFor('/tmp/a.txt'), null);
  assert.equal(host.imageMimeFor('/tmp/a'), null);
});

test('attachImages stores the file and returns markdown', async () => {
  const { ctx, tools } = mockCtx();
  host.apply(ctx, { dbPath: ':memory:', statePath: makeState({ id: 'bot-1', name: '鲸鱼', sessionId: 's1' }), nodesRoot: '/tmp/none', writebackIntervalMs: 999_999 });
  const comment = tools.find(t => t.name === 'issue_comment');
  // 通过工具链先建一个事务（store 句柄不对外导出，用工具拿 issueId）
  const created = await tools.find(t => t.name === 'issue_create').execute({ title: '截图', body: '看看' }, { agent: { session: { id: 'session-main' } } });
  const dir = mkdtempSync(join(tmpdir(), 'img-'));
  const png = join(dir, 'shot.png');
  writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  const result = await comment.execute({ id: created.id, body: '改好了', images: [png] }, { agent: { session: { id: 'session-main' } } });
  assert.ok(result.id);
});

test('attachImages rejects relative paths, non-images, and too many files', async () => {
  // images: ['shot.png'] → 报错信息含「绝对路径」
  // images: ['/tmp/a.txt'] → 报错信息含「只支持图片」
  // 9 张合法路径 → 报错信息含「最多 8 张」
});
```

（现有测试的惯例是把 exec 直接写成字面量，见 `test/host.test.js:82`：`{ agent: { session: { id: 'session-main' } } }`。沿用这个写法，不要新增 helper。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/host.test.js`
Expected: FAIL，`host.imageMimeFor is not a function`

- [ ] **Step 3: 实现**

`imageMimeFor`：`const EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }`，取 `path.extname(filePath).toLowerCase()` 查表。

`attachImages`：
1. `images.length > 8` → `throw failure('TOO_MANY_IMAGES', '一次最多 8 张图片')`
2. 逐条：`~` 开头展开成 `homedir()`；`!path.isAbsolute` → `failure('RELATIVE_PATH', '<原样路径> 不是绝对路径，请给绝对路径（如 /tmp/shot.png）')`
3. `imageMimeFor` 为 `null` → `failure('UNSUPPORTED_IMAGE', '<路径> 不是支持的图片格式（png/jpg/jpeg/gif/webp/svg）')`
4. 读文件；`ENOENT` → `failure('IMAGE_NOT_FOUND', '找不到文件：<路径>')`；空 buffer → `failure('EMPTY_IMAGE', '文件是空的：<路径>')`
5. `store().addAttachment({ issueId, name: path.basename(p), mime, data: buffer.toString('base64') })`
6. 收集 `![${name}](${url})`，`return { markdown: marks.join('\n'), attachments }`

错误码：`store.js` 的 `failure` **没有导出**，不要改它的导出面。在 `lib/host.js` 内新增私有 helper：

```js
function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
```

调用处一律 `throw failure(...)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/host.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add lib/host.js test/host.test.js
git commit -m "feat(images): 本地图片 → 附件 + markdown 片段的适配层"
```

---

### Task 2: `issue_comment` 接受 `images`

**Files:**
- Modify: `lib/host.js`（`issue_comment` 工具定义）
- Test: `test/host.test.js`

**Interfaces:**
- Consumes: Task 1 的 `attachImages({ store, issueId, images })`
- Produces: `issue_comment` 的 parameters 增加 `images: { type: 'array', items: { type: 'string' }, description: '要贴进评论的本地图片绝对路径（最多 8 张）' }`；输出 schema 增加 `images: { type: 'integer' }`（本次新增的张数）

- [ ] **Step 1: 写失败的测试**

```js
test('issue_comment appends image markdown and stores the attachment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'img-'));
  const png = join(dir, 'shot.png');
  writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  const comment = tools.find(t => t.name === 'issue_comment');
  const out = await comment.execute({ id: issueId, body: '登录页改好了', images: [png] }, { agent: { session: { id: 'session-main' } } });
  assert.equal(out.images, 1);
  const got = await tools.find(t => t.name === 'issue_get').execute({ id: issueId }, { agent: { session: { id: 'session-main' } } });
  const last = got.comments.at(-1);
  assert.match(last, /登录页改好了/);
  assert.match(last, /!\[shot\.png\]\(\/api\/bot-issue\?attachment=[0-9a-f]+\)/);
});

test('issue_comment allows an images-only comment but still rejects an empty one', async () => {
  // body: '' + images: [png] → 成功
  // body: '' 无图 → 抛错，message 含「评论不能为空」
});
```

- [ ] **Step 2: 跑测试确认失败** → Expected: FAIL（`out.images` 为 undefined）

- [ ] **Step 3: 实现**

在 `issue_comment.execute` 里，先算 `const { markdown, attachments } = attachImages({ store, issueId: store().get(args.id).id, images: args.images || [] })`，再 `const body = [String(args.body || '').trim(), markdown].filter(Boolean).join('\n\n')`；`body` 为空 → 抛 `EMPTY_COMMENT`。`comment()` 返回后照旧 `notifyMentions` / `notifyCounterpart`（摘要改成 `新增评论${attachments.length ? `（${attachments.length} 张图）` : ''}`）。返回 `{ id: value.id, images: attachments.length }`。

render 文本：`评论已添加${attachments.length ? `（含 ${attachments.length} 张图）` : ''}。`

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交**

```bash
git commit -m "feat(images): issue_comment 支持 images 参数"
```

---

### Task 3: `issue_create` / `issue_update` 接受 `images`

**Files:**
- Modify: `lib/host.js`（两个工具定义）
- Test: `test/host.test.js`

**Interfaces:**
- Consumes: Task 1 的 `attachImages`
- Produces: `issue_create` 与 `issue_update` 的 parameters 都增加同样的 `images` 字段

- [ ] **Step 1: 写失败的测试**

```js
test('issue_create appends image markdown to the new body', async () => {
  // create({ title:'看图', body:'对比一下', images:[png] }) → get 后 body 含 ![shot.png](...)
});

test('issue_update with images only appends to the existing body', async () => {
  // 1. create({title:'原文', body:'原始正文'})
  // 2. update({ id, images:[png] }) 不带 body
  // 3. get → body 仍含「原始正文」，且含 ![shot.png](...)
  // 4. 再次 update({ id, images:[同一张 png] }) → 正文里图片 markdown 至少存在（允许重复一行）
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

- `issue_create.execute`：在 `store().create({...})` **之前**建立事务拿 id 是做不到的（附件要挂 issueId）。做法：先 create 拿 issue，再 `attachImages`，若 markdown 非空则 `store().update(issue.id, { body: [body, markdown].filter(Boolean).join('\n\n') })`。
- `issue_update.execute`：在调用 `store().update` 之前算出最终 body：`const baseBody = args.body !== undefined ? args.body : store().get(args.id).body`；若 `args.images?.length` → `finalBody = [baseBody, markdown].filter(Boolean).join('\n\n')`，并把 `body: finalBody` 塞进 patch。注意只有真的传了 images 才动 body，否则保持原行为（不传 body 就不改 body）。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交**

```bash
git commit -m "feat(images): issue_create / issue_update 支持 images"
```

---

### Task 4: `issue_get` 返回可直接 `read_image` 的本地路径

**Files:**
- Modify: `lib/host.js`（`issue_get` 工具定义 + 新增 `stageIssueAttachments` 辅助函数）
- Test: `test/host.test.js`

**Interfaces:**
- Consumes: `store.getAttachment(id)` → `{ id, name, mime, bytes, filePath } | null`（已有）；`stagingDir`（`issuePaths` 第 40 行，`apply` 作用域内可用）
- Produces:
  - `export function stageIssueAttachments({ store, stagingDir, issueNumber, texts }): Array<{ where, name, mime, bytes, url, path, note? }>` —— `texts` 是 `[{ where: 'body', text }, { where: 'comment:5', text }]`，按 id 去重后 stage
  - `issue_get` 输出新增 `attachments` 字段（形状同上），`comments` 仍是字符串数组

- [ ] **Step 1: 写失败的测试**

```js
test('issue_get stages comment images and returns a readable local path', async () => {
  // 造一个带图的评论，然后：
  const got = await get.execute({ id }, { agent: { session: { id: 'session-main' } } });
  assert.equal(got.attachments.length, 1);
  const [att] = got.attachments;
  assert.equal(att.where.startsWith('comment:'), true);
  assert.ok(att.path && existsSync(att.path), 'path 必须真实存在');
  assert.equal(readFileSync(att.path).length, 8);
});

test('issue_get is idempotent and dedupes the same attachment', async () => {
  // 同一张图出现在正文和评论里 → attachments 只有 1 条
  // 连续调用两次 → 两次 path 相同，目录里只有一个文件
});
```

- [ ] **Step 2: 跑测试确认失败** → Expected: FAIL（`got.attachments` 为 undefined）

- [ ] **Step 3: 实现**

`stageIssueAttachments`：
1. 用正则 `/\/api\/bot-issue\?attachment=([0-9a-f]+)/g` 扫每个 `texts[i].text`，记录 `{ id, where }`
2. 按 id 去重（第一次出现的位置为准）
3. 安全阀：最多 20 个；单文件 > 10MB 跳过
4. 目标目录 `path.join(stagingDir, String(issueNumber || issueId))`，`mkdirSync(recursive)`
5. 目标文件名 `` `${id}-${path.basename(name || id)}` ``（id 已含 sha 前 16 位，同名不同图不覆盖；同一 id 幂等覆盖）
6. `copyFileSync(file.filePath, dest)`；失败则 `path: null, note: <错误简述>`（不抛）

`issue_get.execute` 返回时：`attachments: stageIssueAttachments({ store, stagingDir, issueNumber: issue.number, issueId: issue.id, texts: [{ where: 'body', text: issue.body || '' }, ...issue.comments.map(c => ({ where: `comment:${c.id}`, text: c.body }))] })`

render 文本追加：
```
附带的图片（用 read_image 读这些本地路径，不要读 URL）：
1. shot.png  /…/issue-attachments/12/abc123-shot.png
```

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交**

```bash
git commit -m "feat(images): issue_get 把图 stage 到共享工作区并返回本地路径"
```

---

### Task 5: 让 Bot 知道这条能力（skill + README）

**Files:**
- Modify: `skills/issue-workflow/SKILL.md`
- Modify: `README.md`（工具表里补一句 images）
- Test: `test/skill.test.js`

**Interfaces:**
- Consumes: 无
- Produces: skill 文本里出现 `images` 关键词（测试断言）

- [ ] **Step 1: 写失败的测试**

```js
test('skill tells bots how to attach and read images', async () => {
  const text = await readSkill();
  assert.match(text, /images/);
  assert.match(text, /read_image/);
  assert.match(text, /绝对路径/);
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 改文档**

`SKILL.md` 加两条（放在「做完要闭环」那一节附近）：
- 有截图/产出图：`issue_comment(id, '说明', images: ['/abs/shot.png'])`，**不要只说「已截图」却不给图**
- 要看别人贴的图：`issue_get` 返回的 `attachments[].path` 才是本地路径，用它 `read_image`；URL 读不了

`README.md` 工具表里 `issue_comment` 那行补「支持 images（本地图片路径）」；`issue_get` 那行补「返回 attachments 含本地路径」。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交**

```bash
git commit -m "docs: skill 与 README 说明事务图片用法"
```

---

### Task 6: 全量验证 + 部署 + 推远端

**Files:** 无新增

- [ ] **Step 1: 全量检查**

Run: `npm run check`
Expected: 第一行 `✓ 语法检查通过：N 个文件`；测试部分 `pass` 数等于现有 117 加上本次新增的条数，`fail 0`

- [ ] **Step 2: 部署到 profile（不重启 dsh）**

Run: `~/bin/dsh-plugin-sync bot-issue`
Expected: `✓ 已原地重载（pid 不变）`

- [ ] **Step 3: 线上验证工具已注册**

Run: `curl -s localhost:3080/api/bot-issue...` 不适用（需要登录）；改用 `cat ~/.dsh/bot/issue/tools.json` 确认 `registered` 里 8 个工具仍在、`failed` 为空。

- [ ] **Step 4: 真实端到端演练**

在面板里建一条测试事务，让某只 Bot（或直接调工具）贴一张图，确认：
1. 评论里出现图片缩略图
2. `issue_get` 的 `attachments[0].path` 存在且能被 `read_image` 读到

- [ ] **Step 5: 推 GitHub + 146**

```bash
git push origin main && git push backup146 --all
```
Expected: 两处 SHA 与本地一致
