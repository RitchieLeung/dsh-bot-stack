# 为什么 `contacts` 查不到「鲸鱼」的稳定 ID

日期：2026-11-11
状态：**已修复**（2026-11-11 14:55，见文末「修复实施」）。

## 现象

kiki 调 `contacts(query:"鲸鱼")` 返回：

```json
[{"id":"鲸鱼","kind":"unknown","name":"鲸鱼","aliases":[],"retainedObservationCount":0}]
```

`id` 是名字本身、`kind` 是 `unknown`、观测数为 0 —— 这是 `memory/contacts.mjs:23` 的**回退记录**：注册表里找不到这个 id 时合成一条。

## 根因（查 knowledge.sqlite 得出）

1. **`contacts` 表没有 6 只 dscord 团队 Bot**。表里只有：
   - `matrix:@bot-cf6da1fd…` 文档助手（matrix bot）
   - `matrix:@dscord:…` DSCord 管理员（human）
   - `matrix:!o7LJpu…` 一起干活（group）
   - `native:session-bd524f09-…` 赛博算法组（group）
   - `native:user-2c011e88…` Local user（human）

   鲸鱼/真莹/鹤鸣/小欣/伟峰/徐鹏**一条都没有**。

2. **Bot 消息没被记成 source 的作者**。`sources` 表里 `authorId` 是 `session-*` 的记录数为 **0**；作者只有 `native:user-…`（人类）、`tool:*`、以及两个 `matrix:*`。也就是说 dscord 原生 Bot 的消息没有以「该 Bot 的身份」进入观测/来源记录（`contacts` 正是从这些观测建的）。

3. **记忆把 Bot 名字当成了 ID**。`memories` 里存在 `subjectId:"鲸鱼"`（1 条）、`saidBy:"鲸鱼"`（12 条）、`subjectId:"鹤鸣"`（2 条）——自动整理在写记忆时用了名字而不是稳定 session id。

因此 `contacts("鲸鱼")` 的 `knownIds` 里有「鲸鱼」（来自这些记忆），但 `contacts` 表里没有对应记录，只能回退成 `kind:unknown / 0 观测`。

## 修复方向（待定）

- **A. 注册 Bot 身份**：把 roster 里的每只 Bot（`session-*` + 名字）登记进 contacts 观测，让 `contacts` 能解析名字→稳定 ID。
- **B. 修观测管线**：让 dscord 原生 Bot 的消息以 Bot 自身 authorId 进入 `sources`（这是更根本的，但动观测层）。
- **C. 修自动整理**：记忆/审阅写 `subjectId`/`saidBy` 时，用 roster 解析出稳定 session id，而不是落名字。

三者可叠加；A 最局部、见效最快。

## 修复实施（2026-11-11 14:55）

采纳 A + 视图兜底，两处改动：

1. **`memory/native.mjs`**：新增 `ensureRosterContacts()`，在 `contacts` 工具执行前把
   `rt.state.bots` 逐个 `store.contact({ id: 会话 id, name, kind:'bot', source:{eventId:'roster'} })`。
   幂等（同名同 kind 直接跳过）。这样「鲸鱼」→ `session-a05e2e6a-…` 的映射就进了 contacts 表。
2. **`memory/contacts.mjs`**：
   - 带 `source.eventId === 'roster'` 观测的记录视为**团队全员可见**（不受「只露本 Bot 观测过的」过滤）。
   - 老记忆把名字当 id 的 `knownId`，若命中已有记录的 `name/aliases`，不再生成回退记录。

**验证**（DB 副本 + 真莹 botId）：

```
contacts("鲸鱼") → [{ "id":"session-a05e2e6a-b961-400c-94d4-24a40aa867a1",
                      "kind":"bot", "name":"鲸鱼" }]
```

只剩真身份，回退记录消失。**注**：记忆里历史残留的 `saidBy:"鲸鱼"` 仍在（C 方案未做），
但视图层已能把它解析到真记录，不影响 `contacts` 结果。
