# 事务需求紧急程度（P0 ~ P3）

日期：2026-11-19
状态：已确认

## 为什么

目前事务只有自由标签 `tags`，没有统一的需求紧急程度分级；高优和低优事务在列表里仅按创建时间混排，既不直观，Bot 调度与列表筛选也无法按紧急程度区分先后。

## 目标

1. 每条事务拥有独立的紧急程度字段 `priority`，固定四档：`P0`（紧急）、`P1`（高）、`P2`（中，默认）、`P3`（低）。
2. 旧数据库迁移后历史事务默认归为 `P2`，且保留原有 `tags` 不受影响。
3. 列表默认按紧急程度优先排序（`P0 → P1 → P2 → P3`，同级按创建时间新→旧），支持按紧急程度筛选。
4. 面板（新建、详情、列表卡片、桌面通知）与 Bot 工具（创建、列表、详情、更新、派工提示）全链路支持设置、修改与展示紧急程度。

## 非目标

- 不自定义第五档或任意文本优先级。
- 不把历史自由标签里的 `P0`~`P3` 自动删改或迁移出 `tags`（两套字段独立，互不破坏）。
- 改变紧急程度不额外写评论时间线噪音（与标题/标签修改保持一致）。

## 设计要点

1. **存储层（`lib/store.js`）**：
   - `issues` 表新增 `priority TEXT NOT NULL DEFAULT 'P2'`，并在打开旧库时通过 `ALTER TABLE` 自动补列。
   - 归一化校验 `normalizePriority` 支持大小写（如 `p0` → `P0`），非法值抛 `INVALID_PRIORITY`；未传时创建默认 `P2`，更新保持原值。
   - `list({ status, parentId, type, priority, query, limit, offset })` 支持 `priority` 过滤，并将列表与子事务排序统一调整为 `P0 → P1 → P2 → P3` 优先、同级按 `createdAt DESC, rowid DESC`。
   - `versions()` 带上 `priority`。
2. **接口与 Bot 工具（`lib/handler.js`、`lib/host.js`、`skills/issue-workflow/SKILL.md`）**：
   - `meta` 返回 `priorities: ['P0', 'P1', 'P2', 'P3']`；`create` / `update` / `list` 接口透传 `priority`。
   - `issue_create` / `issue_update` / `issue_list` / `issue_get` 工具参数与渲染包含 `priority`（JSON Schema 使用单一 `type: 'string'` + `enum`）；主 Bot 派工提示带上紧急程度。
3. **面板 UI（`lib/client.js`）**：
   - 卡片与详情展示颜色区分明显的 `P0`~`P3` 徽标（`P0` 实心红强调）。
   - 新建表单与详情页提供 `P0 紧急` / `P1 高` / `P2 中` / `P3 低` 胶囊选择器（详情页点击即更新并刷新列表）。
   - 列表页顶部提供 `全部 / P0 / P1 / P2 / P3` 筛选栏；高优（`P0` / `P1`）在待验收浏览器通知标题中标注 `[P0]`/`[P1]`。
