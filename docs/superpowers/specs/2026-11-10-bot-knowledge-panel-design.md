# Bot 知识库面板 + 每日工作日报 — 设计

- 日期：2026-11-10
- 状态：**待批准**
- 交付物：一个 DSH 插件（Host + Client），在当前 Web 界面里增加「知识库」面板；以及每只 bot 每天 19:00 自动写工作日报的能力。

## 1. 意图与为什么

用户有一支 5 只 bot 的团队（鲸鱼=项目管理、真莹=技术、鹤鸣=QA、小欣=方案、伟峰=实施）。他要三件事，本期做前两件：

1. bot 把记忆记在里面（类似日记）；
2. bot 把工作中沉淀的知识和必要信息放在里面；
3. （**本期不做**）其他 bot 浏览和点评。

而他要的"看得到"，落成一个面板：**打开一个地方就能看到每只 bot 记了什么**；再让每只 bot 每天定时写工作日报。

### 已核实的现状

| 事实 | 位置 |
|---|---|
| 记忆底层已在运行 | `~/.dsh/bot/knowledge/knowledge.sqlite`：`memories`（json 含 `text/kind/predicate/facets/scope/status/observedAt/sourceRefs`）、`sources`、`observations`、`journal` |
| 现有数据量 | 34 条记忆、78 条来源、496 条日志；5 只 bot 中 **3 只**有记忆（鲸鱼 24、鹤鸣 6、小欣 4） |
| bot 身份 | `~/.dsh/bot/state.json` 的 `bots`：`id/name/role/model/sessionId` |
| 已有按 bot 的记忆面板 | 在 DSCord 的 bot 界面里（"管理 {name} 的记忆"），但**没有跨 bot 汇总** |
| bot 前台工具被限制 | 前台只有聊天、回忆、派活、`remember`；**没有写文件工具**。前台能写东西的唯一路径是 `remember` |
| 宿主有 `schedule` 服务 | 支持 `timing:{kind:'daily'}` + `target:{kind:'session'}` 定向投递 |
| dscord 只有打包 tgz | 没有本地源码；改它等于 fork |

### 一个已知隐患

`journal` 里有 **334 条 `review-validation-error`**（记忆自动整理时模型没按 JSON 输出），78 条来源仍待整理。这不阻塞本次交付，但面板会如实显示 `pending`/`superseded` 状态，不做美化。

## 2. 目标 / 非目标 / 反目标

**目标**
- 一个「知识库」面板：列出所有 bot；看清每个 bot 的条目（时间、类别、正文、来源）。
- 「日报」页：按日期看每只 bot 当天的工作日报。
- 每只 bot 每天 19:00 自动写日报，内容以其自身判断为准。

**非目标（本期不做）**
- bot 之间互相点评。
- 从面板编辑/删除记忆 —— 面板**只读**；写仍由 bot 自己的 `remember` 完成。
- 修改 dscord 本体。
- 跨 bot 共享记忆池（现有隐私边界不动）。

**反目标（这样做就是失败）**
- 面板代 bot 写知识，破坏"记忆只由 bot 的真实来源产生"这条可信链。
- fork dscord，导致升级即坏。
- 面板读不到数据时要"猜"或"补"，而不是如实说看不到。

## 3. 约束

1. `knowledge.sqlite` **只读**：不改 schema、不写、不迁移。
2. **不 fork dscord**：面板是新插件，独立读同一份文件。
3. 安装进 `web` profile 需要写工作区外（profile 的 `package.json`、`node_modules`），要单独审批。
4. 日报正文必须由 bot 自己写，插件不代笔。
5. Node 24 自带 `node:sqlite`，不引入第三方依赖；客户端组件只能用 `@deepseek-ai/dsh-client-ui-primitives` 和 react。

## 4. 方案

### 4.1 界面放哪（三种，已选定 A）

- **A（选定）新做 DSH 插件面板** —— 走 DSCord 自己挂进界面的同一条路（`sidebar.panellist` + `main` 插槽），能在当前 Web 界面里出现；不依赖 dscord 内部，升级不受影响。
- B 独立本地网页 —— 最快，但要另开一个地址，不在当前界面里。
- C 改 dscord 自己的面板 —— 最"原生"，但只有 tgz，得解包重打包，升级即失效。

**结论：A。**

### 4.2 日记/知识内容落哪（两条路，选定路 1）

- **路 1（选定）复用 `remember`** —— 每条日记/日报就是一条记忆，靠约定字段区分。零改动，bot 现在就能写，面板一次读完。代价：会受记忆校验和自动整理影响，叙述可能被规范化。
- 路 2 独立知识库 + 真工具 —— 干净、可共享，但必须 fork dscord 加前台工具（前台工具是 dscord 写死的白名单，外部插件加的工具会被前台拒绝）。**本期不做。**

**结论：路 1。** 真发现叙述被啃掉，再升级路 2。

### 4.3 插件结构

```
bot-knowledge/                        # 项目根，可 git 管理
  package.json                        # dsh.bundle.patch + dsh.client
  cordis.patch.yml                    # 插入插件条目
  lib/host.js                         # Cordis 插件：只读 sqlite + HTTP 路由 + 排程
  lib/client.js                       # 纯 JS：window.__ModuleLoader__.load(...)
  README.md                           # 约定字段说明 + 安装步骤
  docs/superpowers/specs/             # 本文件
```

**Host 半**（参考 dscord 的 `dsh-connect/index.mjs` 用法）
- `ctx.connection.fetch.register({ path: '/api/bot-knowledge', methods: ['POST'], ... })` —— 同源、已认证，与 dscord 同一机制。
- 端点：
  - `bots` → bot 列表：`id/name/role/model/记忆条数/今日是否有日报`
  - `entries` → `{botId?, since?, until?, category?, limit, offset}`；返回 `text/kind/predicate/facets/scope/status/observedAt/来源摘要`
  - `reports` → `{date}`：每只 bot 当日日报
  - `schedules` → 查询/创建/「重新排程」日报任务
- 数据来源：`knowledge.sqlite`（只读）+ `state.json`（bot 名/当前 session）。

**Client 半**（参考 dscord `dsh-connect/client.js` 末尾的注册方式）
```js
window.__ModuleLoader__.load({ id: 'bot-knowledge', factory(require) {
  const React = require('react');
  const { ... } = require('@deepseek-ai/dsh-client-ui-primitives');
  ...
  return { inject: ['slots', 'locale', 'layout'], apply };
}});
```
- `sidebar.panellist`：图标，`order: 30`（排在 DSCord 的 20 之后）
- `main`：整页，`key: 'bot-knowledge'`
- 布局：
  - 左栏：bot 列表（名字 / 职责 / 条数 / 今日有无日报）
  - 右栏：标签「全部 / 日记 / 知识 / 日报」+ 时间线
  - 每条：时间、类别、正文、来源（谁 · 哪个房间 · 哪条原文）
  - 日报页顶部有日期选择

### 4.4 日记 / 知识 / 日报 怎么区分（展示层约定，不改 schema）

| 类别 | 判定 |
|---|---|
| 日报 | `predicate = "daily-report"` 且 `topic = "YYYY-MM-DD"` |
| 日记 | `predicate` 以 `journal:` 开头，或 `facets` 含 `experience` 且非日报 |
| 知识 | 其余记忆；`facets` 含 `decision`/`preference` 的归为"决定/偏好"子类 |

规则写在 README 和面板说明里，是**展示约定**，不强制、不改库。

### 4.5 日报

- **范围**：**只有主 Bot 写日报**（`state.json` 的 `mainBotIds`，当前是鲸鱼；可用 config `reportBotIds` 覆盖）。其他 Bot 只写自己的记忆和日记，不排日报。
- **时间**：每天 19:00（Asia/Shanghai），周日照写（周一那份可合并周末）。
- **投递**：`ctx.schedule.create({ title, prompt, timing: {kind:'daily', daily:{time:'19:00', time_zone:'Asia/Shanghai'}}, target: {kind:'session', sessionId: <bot 当前前台 session>} })`
- **prompt**：说明这是自动日报；要求用 `remember` 写一条 `predicate="daily-report"`、`topic=当天日期`、`kind="inference"`、`facets=["experience"]` 的记忆；正文三段（今天做了什么 / 卡在哪、需要谁配合 / 明天计划）；**不要回复给人**。
- **幂等**：以 title `bot-daily-report:<botId>` 查找已有任务，存在则 update，不重复创建。
- **失效处理**：dscord 换 segment 后 session id 会变。面板提供「重新排程」按钮，Host 重新解析当前 `sessionId` 并 edit 任务。

### 4.6 分期交付

| 阶段 | 内容 | 验收 |
|---|---|---|
| **Stage 0（spike）** | 最小插件：侧边栏出现「知识库」图标，面板显示 1 只 bot 的 3 条记忆 | 验证三件事：客户端插件加载、同源路由可用、只读 sqlite 可读 |
| **Stage 1** | 完整面板：全部 bot、全部条目、来源展开、筛选、分页 | 5 只 bot 都能点开，条目与库里一致 |
| **Stage 2** | 日报定时 + 日报页 | 先手动 `schedule.run` 验证一次写入链路，再交给 19:00 |

Stage 0 是**一次性验证**，不是交付物；通过后直接进 Stage 1。

## 5. 风险与对策

1. **日报投递到前台可能被 dscord 判为空回复失败**（前台一轮没有回复文字会记为失败）。
   → prompt 明确要求只写记忆不回复；Stage 2 先手动触发观察一次。若失败噪声太大，退路是由插件生成"活动摘要型"日报（牺牲第一人称判断），并在面板上标明是生成的。
2. **WAL 只读锁**：WAL 数据库的只读连接需要 shm。
   → 先试 `readOnly`；失败则普通连接读取后立即关闭，**绝不写**。
3. **自动整理器会改写/合并条目**（334 条 review 报错）。
   → 如实显示 `status`（active/superseded/pending），不隐藏、不美化；不因报错阻塞本次交付。
4. **安装要写工作区外**（profile 的 package.json + node_modules）。
   → 安装步骤单独列出、逐条审批；插件代码全部在工作区内可 git 追溯。
5. **日报条目被整理器覆盖**。
   → 用固定 `predicate` + `topic`，与普通事实不冲突；日报页按 predicate 精确匹配。

## 6. 留给实现者

- 视觉：沿用 DSH 设计 token 和 `@deepseek-ai/dsh-client-ui-primitives` 组件，不引入新依赖。
- 性能：先全量读取 + 前端分页；条目超 5000 再优化。
- i18n：先中文，保留 locale 注册结构以便加英文。
- 只读连接的具体实现、错误码和空状态文案。
- 面板的"看不到就说看不到"：库不存在或某 bot 无数据时，明确显示空状态，不伪装成"没有记忆"。

## 7. 验收标准

- [ ] 侧边栏出现「知识库」图标，点击打开面板。
- [ ] 面板列出 state.json 里的全部 5 只 bot。
- [ ] 点开任一 bot，条目与 `knowledge.sqlite` 中该 bot 的 `memories` 行一一对应（`text`、`observedAt`、`status` 一致）。
- [ ] 能按「全部 / 日记 / 知识 / 日报」筛选。
- [ ] 日报页能按日期显示每只 bot 的日报。
- [ ] 每只 bot 有一条 19:00 的 daily 排程任务，重复执行排程不产生重复任务。
- [ ] 面板全程不写 `knowledge.sqlite`（交付前用 mtime + 哈希核对）。
