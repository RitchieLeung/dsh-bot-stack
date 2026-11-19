# 通用采集 + 阅读助手 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `dsh-plugin-bot-ebook` 加两条能力——面板自助采集 PDF/网页（模型转 markdown）+ 阅读器里一个 agent 驱动的助手浮窗。

**Architecture:** host 新增 `lib/ingest.js`（抽取 + 模型转换）和 `lib/assistant.js`（agent 子会话管理）；复用现有 `store.replaceBook` / 阅读器 / 搜索 / 进度；client 加「导入」对话框 + FAB 浮窗。模型走 harness `llm` 服务，助手走 `agents`/`agentLoop` 子会话。

**Tech Stack:** Node 24 ESM、Cordis plugin（`inject: connection/tools/llm/web/agents`）、React（client 纯脚本）、SQLite（better-sqlite3，已内建）、`pdfjs-dist`（新增依赖）。

**Spec:** `docs/superpowers/specs/2026-11-18-ingestion-assistant-design.md`

## Global Constraints

- 私密：内容只进 `~/.dsh/bot/ebook/ebook.sqlite`，不联网上传。
- 复用现有 store 与阅读器，不重写；`books/chapters/progress` 表不动。
- client.js 无构建步骤（纯 React 脚本），浮窗/导入面板含移动端适配（沿用现有 768px 断点）。
- 模型配置 `config.model = { provider, model }`，默认 `deepseek-official/deepseek-flash`，缺省回退第一个可用 DeepSeek 模型。
- 新增依赖只有 `pdfjs-dist`（纯 JS）。
- 导入先预览后入库（`import_commit` 才 `replaceBook`），不误覆盖。

## Review Focus

1. 大文件（超一个模型上下文）分块转换：必须按块产出、顺序拼接、不丢内容。
2. 网页正文抽取失败（脚本重、登录墙、反爬）：要有明确错误码，不让模型吃一堆导航脚本。
3. PDF 分栏/页眉页脚错位：模型转换提示词要显式要求「去页眉页脚、合并分栏」。
4. agent 会话并发：同一本书两个浮窗同时提问，不能建两个 agent 会话互相覆盖。
5. 助手引用跳转：`§idx` 必须可点、跳对章节（idx 是数组序，不是 1-based 编号）。

---

### Task 1: Spike——确定 agent 驱动 API

**Files:**
- Create: `probes/agent-driver.mjs`（一次性探针，不进 lib）

**Interfaces:**
- Produces: 确定「创建/复用带本书指令 + ebook 工具的 agent 子会话、投递一条消息、拿到其回复（含工具调用过程）」的确切调用序列，写回本任务结果。

- [ ] **Step 1: 读 agent/subagents 服务源码，列出可行路径**

读 `dsh-agent` / `dsh-agent-loop` / `dsh-subagent*` 的类型与 `subagents` 服务 `prompt` 实现，确认：创建带自定义指令的 agent 用哪个服务、怎么把 ebook 工具限到它、怎么投递消息、怎么拿到回复。

- [ ] **Step 2: 写最小探针 `probes/agent-driver.mjs`，跑通一次「问书」**

用 hardcoded bookId + 一个问题，跑通「创建 agent → 投递 → 收回复」。探针脚本只在本机跑，不进包。

- [ ] **Step 3: 把结论写回接口契约**

在计划里补一段：`assistant.js` 要暴露的函数签名（`ensureAssistant(bookId) → agent`、`ask(agent, question) → stream/answer`）与依赖的服务名。

- [ ] **Step 4: Commit 探针 + 接口契约**

---

### Task 2: 抽取 + 模型转换 `lib/ingest.js`

**Files:**
- Create: `lib/ingest.js`
- Test: `test/ingest.test.js`

**Interfaces:**
- Consumes: `llm` 服务（`stream()`）、`web` 服务（`fetch()`）、`pdfjs-dist`
- Produces: `extract(input) → rawChunks` 与 `convert(rawChunks, model) → { book, chapters }`，导出供 handler 用

- [ ] **Step 1: 写失败测试**

```js
// test/ingest.test.js
import { extractMarkdown, chunkText } from '../lib/ingest.js';
test('chunkText 按上限切块且不丢内容', () => {
  const text = 'a'.repeat(1000);
  const chunks = chunkText(text, 300);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(c => c.length <= 300));
});
test('extractMarkdown 原样透传 md/txt', () => {
  assert.equal(extractMarkdown('# 标题\n\n正文').chapters[0].title, '标题');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ingest.test.js`，Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `chunkText`、`extractMarkdown`、`extractPdf`、`extractWeb`、`convertToBook`**

- `chunkText(text, limit)`：按上限切块，块边界落在段落/标题，不截断内容。
- `extractMarkdown(text)`：md/txt → `{ book, chapters }`（按 `# ` 标题分章）。
- `extractPdf(buffer)`：`pdfjs-dist` 按页抽字 → 拼 `rawChunks`。
- `extractWeb(html)`：抽正文（去 script/style/nav）→ `rawChunks`。
- `convertToBook(rawChunks, modelConfig)`：逐块 `llm.stream` 转 markdown → 拼成 `{ book, chapters }`。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: Commit**

---

### Task 3: 导入 handler 动作

**Files:**
- Modify: `lib/handler.js`
- Modify: `lib/host.js`
- Test: `test/handler.test.js`

**Interfaces:**
- Consumes: `ingest.js` 的 `extract*` / `convertToBook`、`store.replaceBook`
- Produces: `import_file`（返回预览）、`import_url`（返回预览）、`import_commit`（入库）、`models`（模型列表）

- [ ] **Step 1: 写失败测试**：`import_commit` 无预览时被拒、`import_file` 返回 `{ book, chapters }` 预览不入库、`models` 返回 provider/model 数组。

- [ ] **Step 2: 实现 handler 分支 + host 注入 `llm`/`web`**（`inject` 增加 `llm`、`web`；`apply` 里读 `config.model`，默认 flash）

- [ ] **Step 3: 跑测试确认通过**

- [ ] **Step 4: Commit**

---

### Task 4: 助手 agent 会话 + `ask` 动作

**Files:**
- Create: `lib/assistant.js`
- Modify: `lib/handler.js`
- Test: `test/assistant.test.js`

**Interfaces:**
- Consumes: Task 1 确定的 agent 服务 API、`store`
- Produces: `ensureAssistant(bookId)`、`ask(bookId, question)`（返回含引用的回答）

- [ ] **Step 1: 写失败测试**：`ensureAssistant` 同一 bookId 复用同一 agent、`ask` 返回结构含 `answer` 与 `citations`（至少引用生成规则可单测的部分）。

- [ ] **Step 2: 实现 `lib/assistant.js`**：按 Task 1 契约，系统指令锚定本书 + 工具限到 ebook 三件套。

- [ ] **Step 3: handler 加 `ask` 动作（流式或整段返回，按 Task 1 结论）**

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: Commit**

---

### Task 5: 客户端导入面板 + 浮窗

**Files:**
- Modify: `lib/client.js`
- Test: `test/client-load.test.js`

**Interfaces:**
- Consumes: `/api/bot-ebook` 的 `models` / `import_file` / `import_url` / `import_commit` / `ask`
- Produces: `ImportDialog`（上传/贴链接两 tab + 预览 + 确认）、`Assistant`（FAB + 浮窗）

- [ ] **Step 1: 写失败测试**：SOURCE 含 `import_file`、`ask` 调用、浮窗 FAB 标记、移动端断点。

- [ ] **Step 2: 实现导入对话框**：上传 tab（file input + 拖拽）+ 链接 tab；提交 → 预览 → 确认入库。

- [ ] **Step 3: 实现助手浮窗**：FAB + 右侧滑出聊天面板（移动端底部抽屉），消息列表 + 引用可点跳章。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: Commit**

---

### Task 6: 集成 + 部署

**Files:**
- Modify: `package.json`（加 `pdfjs-dist`）
- Modify: `README.md`

- [ ] **Step 1: 全量 `npm run check` 通过**

- [ ] **Step 2: 本地 `dsh-plugin-sync bot-ebook` 验证导入 + 浮窗可用**

- [ ] **Step 3: 更新 README（导入用法 + 助手用法，注意私密/无术语）**

- [ ] **Step 4: Commit + 推私密仓 + backup146**
