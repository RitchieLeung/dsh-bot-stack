# 事务规则 skill + 执行人 / 闭环 / 能力路由 — 设计文档

日期：2026-11-17 · 状态：待批准

## Intent / 为什么

事务模块（`dsh-plugin-bot-issue`）现在的派工链路是纯自然语言：点「启动」→ 主 Bot
（鲸鱼）收到一段提示 → 它自己 `list_bots` + `message_bot` 挑人。结果：

- 没有任何能力/负载数据喂它 → 看图任务派给看不了图的伟峰，且老派伟峰（#7 实锤）。
- 谁接了哪条事务没有记录 → 「负载」无从算起。
- 状态机让任何能调 `issue_update` 的 agent 把「待验收」直接改「已闭环」→ 工作者自己验收自己。
- 没有一份「每个成员都该遵守的事务规则」。

本轮要把这套规则写成一份**每个成员共用的 skill**（教育面），并把其中能强制的部分
写进代码（强制面），两层一起，缺一不可。

## Goals / Non-goals / Anti-goals

**Goals**

1. 一份内置 provider skill，教每个成员事务工作流（起点/派工/执行/协作分拆/闭环/打回/评论同步）。
2. 事务新增「执行人」字段，记录承接 bot；**只有主 Bot 和人能指派/改派**。
3. 能力 + 负载路由：看图能力从运行时模型目录现查（不写死），负载 = 该执行人在手事务数。
4. 闭环：worker 只能「进行中 → 待验收」交结果；「待验收 → 已闭环」「打回重做」只有主 Bot/人。
5. 打回必须带意见，存评论并知会执行人。
6. 评论同步：落时间线 + 知会对侧（主 Bot ↔ 执行人），不只靠 `@`。
7. 侧栏「事务」未读数字角标（状态/评论变化）。

**Non-goals**

- 不写死模型→能力映射；不猜模型能力。
- 不覆盖跨机（146）同事的路由（本机 `state.json` 没有它们，确定派工覆盖不到）。
- 不自动重启、不杀任何进程（沿用急救台教训）。

**Anti-goals（做成这样就算失败）**

- 拿一份手写名单冒充「能力模型」，模型一换就错（自欺欺人）。
- 交付失败却静默标记「进行中」。
- worker 能自己验收自己、能自己改执行人。
- 一份「写了但没人加载」的 skill。

## Constraints

- `bot-issue` 是 dsh 插件（profile 内真实副本，`dsh-plugin-sync` 上线，不重启 dsh）。
- 可注入服务：`connection`（已有）、`llm`（本轮加，服务名确认为 `llm`，见 `dsh-llm` 的 `super(ctx, "llm")`）、
  `skills`（本轮加）、`sessionController`（已有）、`tools`（已有）。
- store：`node:sqlite`，版本守卫，状态机集中在 `store.js`。
- skill 格式：`SKILL.md` + `---\ndescription: …\n---` frontmatter（参照 dscord `goal-skills.js` / `office-skills.js`）。
- 测试：`node --test`，临时库 + fake `llm`/`sessionController`/`start`，不碰真实 3080/3082/3099。

## Approaches（选了什么、为什么）

1. **skill 交付**：A（内置 provider，`ctx.skills.registerProvider`，全队自动可见、随插件版本管理）vs
   B（存能力库 `capabilities.items`，逐只挂 `capabilities`）。**选 A**——不漏挂、单一来源；硬规则再写进代码兜底。
2. **能力来源**：运行时 `ctx.llm.resolveModelInfo(provider, model).inputModalities`（含 `image` = 能看图）vs
   写死模型映射。**选运行时**——和 `list_bot_models` 的 "reads images" 同一来源；`inputModalities` 缺省 = unknown → 按不能看图（保守）。
3. **派工**：host 确定性算分（能力 + 负载）落库 vs 纯自然语言。**选确定性**——host 定执行人并落库，主 Bot 只写说明 + `message_bot` 给被点名的人。

## 设计细节

### 1. 数据模型（store.js）

- `issues` 表新增列（迁移 `ALTER TABLE`）：
  - `assigneeSessionId TEXT`、`assigneeName TEXT`、`assignedAt INTEGER`（均 nullable；历史事务为空）。
- `issueFrom()` 返回 `assignee: { sessionId, name, at } | null`。
- 新增 store 方法：
  - `assign(id, { sessionId, name }, actor)` — 设/改执行人；仅 `actor.kind === 'user'` 或 `actor.isMain` 允许，否则 `FORBIDDEN_ASSIGN`。写一条「执行人」时间线记录。
  - `reassign(id, { sessionId, name }, actor)` — 同 `assign`，但额外写「执行人变更」状态评论。
  - `loadOf(sessionId)` — 该执行人在手（`dispatched` / `in_review`）事务数。
  - `loads()` — 每位执行人在手数 `{ sessionId: n }`（路由用）。

### 2. 状态机 + actor 门（store.js）

- 新增迁移：`in_review → dispatched`（打回重做）。
- `update` / `setStatusUnchecked` 增加 actor 门（`actor` 由 handler 传入，含 `kind` 与 `isMain`）：
  - `in_review → done`（验收通过）：**仅主 Bot / 人**。
  - `in_review → dispatched`（打回重做）：**仅主 Bot / 人**；必须带 `rejection` 文本，否则 `REJECTION_REQUIRED`；文本存成 `kind='reject'` 评论。
  - `dispatched → in_review`（交结果）：执行人 / 主 Bot / 人均可。
  - `dispatched → failed`：执行人 / 主 Bot / 人均可（做不了要能报）。
  - 其余迁移维持现状；worker 不得改 `assignee`、不得自己 `done`。
- 「请求改派 / 拆任务」不做独立状态——由 skill 规定 worker 用 `message_bot` 找主 Bot，主 Bot 用
  `reassign`（改派）或 `issue_create(parentId=…)`（拆子任务）落地。

### 3. 路由（host.js `start`）

- 注入 `llm`；派工当下算每位同事（`state.json` bots 去掉主 Bot）：
  - `vision` = `resolveModelInfo(provider, model).inputModalities?.includes('image')`（失败/缺省 → false）。
  - `specialty` = 从该 bot 自己声明的 `role` / `instructions` 关键词（前端/后端/实施/协调/头脑风暴）读，不额外造。
  - `load` = `store().loads()[sessionId] || 0`。
- 「需要看图」判定：`body` 含 `/api/bot-issue?attachment=` 或 `![…]` 图片 markdown。
- 硬过滤：需要看图 → 只留 `vision` 者；**无人可用 → 返回明确 `reason`，不瞎派**。
- 打分：specialty 命中 + 负载逆序；选最高。落库：`status → dispatched` + `assignee = 选中者`。
- prompt 主 Bot：`message_bot(被点名者, 预写说明)` + 告知已落执行人；主 Bot 只写说明 + 发送，不再挑人。

### 4. 闭环 + 评论同步（host.js notify）

- worker 交结果（`dispatched → in_review`）→ host 通知主 Bot 来验收。
- 主 Bot `done` / 打回 → 通知执行人（打回附意见）。
- 评论（`issue_comment` / 面板）→ 落时间线 + 知会对侧（主 Bot ↔ 执行人），不只 `@`。

### 5. 角标（client.js）

- 本机单人：`localStorage` 记每 issue `lastSeenVersion`（或全局 max version）。
- 轮询 `list`/`meta`（15–30s），未读 = `version > lastSeenVersion` 的条数；侧栏图标右上角数字角标；点开该事务清该条。

### 6. skill（provider skill）

- `bot-issue/skills/issue-workflow/SKILL.md`，frontmatter `description`。
- host 注册 `ctx.skills.registerProvider`，`name='bot-issue-workflow'`，skill `name='issue-workflow'`（显示名「事务规则」），`modelInvocable: true`。
- 内容覆盖：起点（主 Bot 出发 / 讨论点名）、派工（专才 + 负载 + 用量窗口）、执行（自行处理）、
  协作（忙→请求改派；太大→请求拆子任务）、闭环（主动知会主 Bot，主 Bot 验收/打回）、评论同步、不得越级。

### 7. 面板（client.js）

- 详情页显示执行人。
- `in_review` 动作：`done`（验收通过）/ `reject`（打回重做，弹意见框，必填）。
- `open` / `discussing` 动作：`start`（派工）。

## 已知边界（诚实声明）

- 确定路由只覆盖 `state.json` 本机同事（伟峰/玉清/尚锦/kiki）；跨机（146）仍走主 Bot `list_bots`。
- `inputModalities` 缺省 = unknown → 按不能看图（保守，宁可少派）。
- 「负载」= 本库在手事务数；拿不到 bot 的其它系统用量窗口，用量窗口靠 skill 提醒主 Bot 保守派工。
- 历史事务 `assignee` 为空，路由/负载只从本轮起算。
- 主 Bot 仍是 `message_bot` 的实际发送方；若它发送失败，回 `dispatched:false`，不静默标「进行中」。

## 验收标准（测试先行）

- store：`assign`/`reassign` 门、`in_review → dispatched` 门、打回必带意见、`done` 仅主 Bot、`loads()` 计数、历史迁移。
- handler：`assign`/`reject` 动作、`meta` 带 roster+能力+负载、`start` 路由选 vision / 无 vision 者拒绝。
- host：`start` 对图任务只派 vision 同事、无人时拒绝。
- client：角标未读计算（纯函数可测）。
