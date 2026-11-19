/**
 * Structured retrospect helpers for active, MCP-driven skill proposals.
 *
 * Replaces blind time-based review with explicit negative-feedback/rejection
 * triggers, read-only issue rejection lookups, and a clean gate extension point
 * for future decision models.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const RETROSPECT_TOOL_NAME = 'skill_retrospect';
export const RETROSPECT_TRIGGERS = ['issue_rejected', 'negative_feedback'];

export const SKILL_RETROSPECT_PARAMETERS = {
  trigger_type: {
    type: 'string',
    required: true,
    enum: RETROSPECT_TRIGGERS,
    description: 'Why this retrospect is triggered: issue_rejected (task bounced back) or negative_feedback (strong negative user correction).',
  },
  summary: {
    type: 'string',
    required: true,
    description: 'Concise summary of what went wrong, what the user rejected or criticized, and the reusable lesson to evaluate.',
  },
  issue_id: {
    type: 'string',
    description: 'Optional issue ID (e.g. I-4d076aa4) or number (#10) so the host attaches actual rejection records.',
  },
  focus_skill: {
    type: 'string',
    description: 'Optional existing learned skill name to update instead of creating a new one.',
  },
};

export const SKILL_RETROSPECT_DESCRIPTION = [
  'Trigger a post-task skill retrospective only after a task finishes AND either an issue was rejected (issue_rejected) or you received strong negative feedback/correction from the user (negative_feedback).',
  'Do NOT call this mid-task, on routine tool errors, or just because a turn took long.',
  'Generates a skill proposal card for user approval if a genuinely reusable convention was learned; otherwise returns why no skill is needed.',
].join(' ');

const trimOptional = value => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** Validate and normalize arguments passed to the skill_retrospect tool. */
export function normalizeRetrospectArgs(args) {
  if (!args || typeof args !== 'object') {
    return { ok: false, error: '参数必须是对象，且包含 trigger_type 与 summary。' };
  }
  const triggerType = trimOptional(args.trigger_type);
  if (!triggerType || !RETROSPECT_TRIGGERS.includes(triggerType)) {
    return {
      ok: false,
      error: `trigger_type 必须是 ${RETROSPECT_TRIGGERS.join(' 或 ')}。`,
    };
  }
  const summary = trimOptional(args.summary);
  if (!summary) {
    return { ok: false, error: 'summary 不能为空：请概括被驳回或负反馈的具体问题与复盘要点。' };
  }
  return {
    ok: true,
    value: {
      triggerType,
      summary: summary.slice(0, 1200),
      issueId: trimOptional(args.issue_id),
      focusSkill: trimOptional(args.focus_skill),
    },
  };
}

/**
 * Default admission gate before invoking the skill extractor.
 *
 * Future JEV-like decision models plug in here without changing the MCP contract.
 */
export async function evaluateRetrospectGate({ waitingProposals = [], args, issueEvidence }) {
  if (Array.isArray(waitingProposals) && waitingProposals.length > 0) {
    const names = waitingProposals.map(item => item.name).filter(Boolean).join(', ');
    return {
      allow: false,
      reason: `你当前已有待用户审批的学习提案（${names || waitingProposals.length}），请先由用户在界面处理后再发起新的复盘。`,
      metadata: {
        triggerType: args.triggerType,
        hasIssueEvidence: Boolean(issueEvidence?.found),
      },
    };
  }
  return {
    allow: true,
    metadata: {
      triggerType: args.triggerType,
      hasIssueEvidence: Boolean(issueEvidence?.found),
    },
  };
}

/** Read issue details and rejection comments from $DSH_HOME/bot/issue/issue.sqlite safely. */
export function readIssueEvidence({ home, issueId }) {
  const requested = trimOptional(issueId);
  if (!requested) {
    return { requested: null, found: false, issue: null, rejectComments: [], statusComments: [], note: null };
  }
  if (!home) {
    return { requested, found: false, issue: null, rejectComments: [], statusComments: [], note: '未提供运行目录，无法查询事务库。' };
  }
  const dbPath = join(home, 'issue', 'issue.sqlite');
  if (!existsSync(dbPath)) {
    return { requested, found: false, issue: null, rejectComments: [], statusComments: [], note: '事务数据库不存在，跳过事务取证。' };
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const numMatch = requested.match(/^#?(\d+)$/);
    const row = numMatch
      ? db.prepare('SELECT id, number, title, status, assigneeName FROM issues WHERE number = ?').get(Number(numMatch[1]))
      : db.prepare('SELECT id, number, title, status, assigneeName FROM issues WHERE id = ?').get(requested);

    if (!row) {
      return { requested, found: false, issue: null, rejectComments: [], statusComments: [], note: `未找到事务 ${requested} 的记录。` };
    }

    const comments = db
      .prepare("SELECT authorKind, authorName, body, kind, at FROM comments WHERE issueId = ? AND kind IN ('reject', 'status') ORDER BY at ASC, id ASC")
      .all(row.id);

    const rejectComments = comments.filter(c => c.kind === 'reject').slice(-5);
    const statusComments = comments.filter(c => c.kind === 'status').slice(-5);

    return {
      requested,
      found: true,
      issue: {
        id: row.id,
        number: typeof row.number === 'number' ? row.number : null,
        title: row.title,
        status: row.status,
        assigneeName: row.assigneeName || null,
      },
      rejectComments,
      statusComments,
      note: null,
    };
  } catch (error) {
    return {
      requested,
      found: false,
      issue: null,
      rejectComments: [],
      statusComments: [],
      note: `只读查询事务库失败：${error?.message ?? error}`,
    };
  } finally {
    try { db?.close(); } catch {}
  }
}

/** Combine structured trigger info, verified issue rejection evidence, and recent chat lines. */
export function buildRetrospectLines({ triggerType, summary, issueEvidence, chatLines = [], focusSkill }) {
  const header = [
    `[Retrospect Trigger] type=${triggerType}`,
    `[Trigger Summary] ${summary}`,
  ];
  if (focusSkill) header.push(`[Focus Learned Skill] ${focusSkill}`);
  if (issueEvidence?.found && issueEvidence.issue) {
    const { id, number, title, status, assigneeName } = issueEvidence.issue;
    const tag = number !== null ? `#${number} (${id})` : id;
    header.push(`[Issue] ${tag} "${title}" | status=${status}${assigneeName ? ` | assignee=${assigneeName}` : ''}`);
    for (const c of issueEvidence.rejectComments ?? []) {
      header.push(`[Issue Rejection by ${c.authorName || c.authorKind || 'reviewer'}] ${c.body}`);
    }
    for (const s of issueEvidence.statusComments ?? []) {
      header.push(`[Issue Status] ${s.body}`);
    }
  } else if (issueEvidence?.requested) {
    header.push(`[Issue Lookup Note] ${issueEvidence.requested}: ${issueEvidence.note || '未找到'}`);
  }
  const normalizedChat = Array.isArray(chatLines) ? chatLines.filter(line => typeof line === 'string' && line.trim() !== '') : [];
  return [...header, ...normalizedChat];
}
