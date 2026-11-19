# 电子书「通用采集 + 阅读助手」设计文档

日期：2026-11-18 · 状态：待审批 · 模块：`dsh-plugin-bot-ebook`（私密）

## 意图与为什么

现在的电子书是「单本书脚本导入 + markdown 阅读器」：内容靠 `scripts/import-pmpp.mjs`
针对某一本书硬编码，换一本书就得改脚本或让 agent 临时写一个。用户要的不是这种
case-by-case 采集器，也不是一个纯阅读器，而是：

> 一个**通用采集 + 阅读器**：PDF、网页随便丢进去，自动变成能读的书；
> 阅读时还能唤起一个**锚定本书的助手**（类似 Google NotebookLM）。

三个词定基调：**通用、自助、模型做转换**。

## 目标

1. **通用采集管道**：面板里上传 PDF（文字版）/ EPUB / md / txt / zip，或贴一个 URL /
   仓库地址 / 链接列表，自动解析 → 模型转成结构化 markdown → 存成一本书。
2. **阅读助手浮窗**：阅读器里常驻一个悬浮球，点开滑出聊天浮窗，锚定当前书（可选当前章
   或选中的文字）。助手是**真正的 agent**（可多步推理、自己调 ebook 工具检索原文），
   带引用回答，点引用跳回原章。
3. **模型可配置**：用 harness 已配置的模型，默认 DeepSeek Flash（`deepseek-flash`）。

## 非目标 / 反目标

- 不做扫描件 OCR（用户明确「文字版居多」；扫描件留到二期）。
- 不做递归全网爬虫（v1 只收「单个 URL」和「一串链接列表」，不做站点漫游）。
- 不做文档标注 / 书签 / 高亮系统。
- 不接入 DSCord bot 群——助手是电子书面板里的独立浮窗，不是某个 bot。
- 不破坏现有能力：书库、全文搜索、阅读进度、Bot 工具（ebook_list/read/search）全部保留。

## 约束

- **私密**：内容只进本机 SQLite（`~/.dsh/bot/ebook/ebook.sqlite`），不联网上传。
- **纯 JS 依赖**：PDF 抽字用 `pdfjs-dist`（无原生编译）；网页抓取走 harness 的 `web`
  服务，不自己裸 `fetch`。
- **复用现有底座**：`store.replaceBook` / 阅读器 / 搜索 / 进度 / 工具全部不动。
- **client.js 仍是纯脚本**（无构建步骤）：导入对话框和助手浮窗都是 React，跟现有面板同套路。
- **模型通过 harness 的 `llm` 服务调用**（`stream()` + `listProviders/listModels`）。
- **助手是真正的 agent，不是裸 LLM**：通过 `agents` / `agentLoop` 服务创建/复用子会话，复用
  DSH 的 session 持久化与工具机制。

## 方案：为什么模型做转换，而不是规则

- **规则抽取**（readability / turndown / 按字号猜标题）免费快，但分栏、页眉页脚、公式、
  表格、导航广告都会糊——用户已明确「规则转不出漂亮 markdown」。
- **选定**：机械层只做「把原始文字拿到手」（PDF 用 pdfjs 抽字、网页用 web 服务抽正文），
  真正的「清洗 + 分章 + 还原表格/公式」交给 **deepseek-flash** 完成。机械层不是转换，
  只是给模型喂料。

## 架构

### 一、通用采集管道

```
面板「导入」对话框
  ├─ 上传文件：PDF / EPUB / md / txt / zip
  └─ 贴链接：单个 URL / 仓库 / 链接列表
        │
        ▼
host 抽取层（lib/ingest.js，机械，可单测）
  ├─ PDF   → pdfjs-dist 按页抽文字
  ├─ EPUB  → 解包（本质 HTML）→ 抽正文
  ├─ 网页  → web.fetch → 抽正文（去脚本/样式/导航）
  └─ md/txt → 原样
        │
        ▼
host 转换层（lib/ingest.js，模型）
  llm.stream(deepseek-flash)：
    「把下面这段原始文字整理成结构化 markdown，按标题分章，
      保留/还原表格与公式，去掉页眉页脚和分栏错位」
        │
        ▼
入库：store.replaceBook({ id,title,author,source }, chapters)
        │
        ▼
阅读器（现有，零改动）
```

- 大文件分块喂模型（按 token 上限切），每块产出一段 markdown，最后拼成一本书。
- 导入**先出预览**：把模型结果给用户看一眼，确认后才 replaceBook（避免误覆盖）。

### 二、阅读助手浮窗（NotebookLM 式，agent 驱动）

```
阅读器右下角 FAB（悬浮球）→ 点开滑出聊天浮窗（手机变底部抽屉）
  锚定上下文：当前书 + 当前章 + 选中的文字（可选）
        │
        ▼
助手 = 一个真正的 DSH agent 子会话（跟主对话里的 agent 同源），不是裸 LLM：
  · 每本书创建/复用一个 agent 会话，模型 deepseek-flash
  · 系统指令：「你是本书《X》的阅读助手；回答前用 ebook_read / ebook_search
    检索原文，引用出处用 §idx，点引用可跳回原章」
  · 工具集 = ebook_list / ebook_read / ebook_search（host 已注册，agent 天然可用）
        │
        ▼
浮窗提问 → host 把问题投递给这个 agent → agent 多步推理 + 调工具读原文
  → 流式返回（含思考 + 引用）
        │
        ▼
浮窗渲染：回答 + 可点引用（点击 → openChapter(idx) 跳回原章）
```

- 会话按书隔离，**复用 DSH 的 session 持久化**——重开浏览器也能接着聊（顺带解决了
  「会话要不要持久化」的疑问：agent 会话本身就走在 DSH 的持久化上，不用自己建表）。
- 只锚定当前书，不做跨书（上下文干净、token 可控）。
- host 通过 `agents` / `agentLoop` 服务创建并驱动这个 agent；确切的消息投递 / 流转 API
  在计划阶段落地（见「留给实现者」）。

### 三、模型访问（两条腿）

- **采集（转换）**：直接 `llm.stream(deepseek-flash)` 做「原文 → markdown」的一次性转换。
  这是纯变换任务，不需要 agent 循环，一次调用即可。
- **助手（对话）**：走 `agents` / `agentLoop` 服务，创建 agent 子会话（模型 deepseek-flash），
  让 agent 自己调 ebook 工具检索再回答，多步推理。
- 两者共用同一套模型配置 `config.model = { provider, model }`，默认 `deepseek-official/deepseek-flash`，
  缺省回退到第一个可用的 DeepSeek 模型。

## 数据与 API 变更

**handler 新增 actions**（沿用现有 `action` 路由 `/api/bot-ebook`）：

| action | 说明 |
|---|---|
| `import_file` | 上传 PDF/EPUB/md/txt/zip → 抽取 + 模型转换 → 返回预览（不入库） |
| `import_url` | 贴 URL/列表 → 抓取 + 模型转换 → 返回预览 |
| `import_commit` | 确认预览 → `replaceBook` 入库 |
| `models` | 返回 `llm.listProviders()` + `listModels()`，给导入/助手选模型用 |
| `ask` | 助手提问：投递给本书的 agent 子会话，流式返回（含思考 + 引用） |

**store 变更**：`books/chapters/progress` 不动；不新增表（助手会话 v1 不持久化）。

## 文件改动

- `lib/ingest.js`（新）——抽取 + 模型转换，纯函数可单测
- `lib/assistant.js`（新）——agent 子会话管理（创建/复用/投递）+ 引用组装，可单测
- `lib/host.js`——注入 `llm`（+ `web`），新增 route 分支与工具（可选 `ebook_import` 工具）
- `lib/handler.js`——新增上述 actions
- `lib/store.js`——基本不动（如需导入去重，加一个 `bookBySource` 查询）
- `lib/client.js`——「导入」对话框 + 助手 FAB + 浮窗（含移动端适配）
- `package.json`——加 `pdfjs-dist` 依赖
- `test/`——ingest / assistant / handler / store / client 各补守门测试

## 留给实现者（builder）确认的细节

- **agent 子会话的创建与消息投递 / 流转 API**——查 `dsh-agent` / `dsh-agent-loop` /
  `subagents` 服务源码，优先复用现有 subagent 驱动路径（`prompt` + 流式 receipt）。
- `llm.stream(GenerateOptions)` 的确切字段（provider/model/messages 等）——查 harness
  `dsh-llm` 源码。
- `web.fetch(WebFetchRequest)` 的返回结构（拿正文用什么字段）。
- `pdfjs-dist` 在 Node 里按页抽字的写法与字体信息去重策略。
- 大文件分块喂模型的切块与拼装策略。
