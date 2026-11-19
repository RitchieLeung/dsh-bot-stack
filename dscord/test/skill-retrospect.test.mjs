import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { flattenSchema } from '../vendor/ds-bot/src/host/local-agents/mcp.js';
import {
  RETROSPECT_TOOL_NAME,
  RETROSPECT_TRIGGERS,
  SKILL_RETROSPECT_PARAMETERS,
  normalizeRetrospectArgs,
  evaluateRetrospectGate,
  readIssueEvidence,
  buildRetrospectLines,
} from '../vendor/ds-bot/src/host/skill-retrospect.js';

function createIssueDb(home) {
  const dir = join(home, 'issue');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'issue.sqlite'));
  db.exec(`
    CREATE TABLE issues (
      id TEXT PRIMARY KEY,
      number INTEGER,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'P2',
      parentId TEXT,
      type TEXT,
      createdBy TEXT NOT NULL,
      createdByName TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      closedAt INTEGER,
      result TEXT,
      assigneeSessionId TEXT,
      assigneeName TEXT,
      assignedAt INTEGER
    );
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issueId TEXT NOT NULL,
      authorKind TEXT NOT NULL DEFAULT 'user',
      authorName TEXT NOT NULL DEFAULT '',
      authorSessionId TEXT,
      body TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'comment',
      replyToId INTEGER,
      at INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO issues (id, number, title, body, status, createdBy, createdByName, version, createdAt, updatedAt, assigneeName)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('I-4d076aa4', 10, '测试一下新版事务', '获取公网和内网 IP', 'dispatched', 'user-1', '管理员', 4, 1000, 2000, '尚锦');
  const insertComment = db.prepare(`
    INSERT INTO comments (issueId, authorKind, authorName, body, kind, at) VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertComment.run('I-4d076aa4', 'system', 'system', '状态：待验收 → 进行中', 'status', 1500);
  insertComment.run('I-4d076aa4', 'user', '管理员', '不要只输出命令文本，要实际跑出真实 IP 再提交', 'reject', 1600);
  insertComment.run('I-4d076aa4', 'bot', '尚锦', '已补充真实 IP 结果并提交重验', 'comment', 1700);
  db.close();
}

test('TOOL metadata and flattened MCP schema are valid', () => {
  assert.equal(RETROSPECT_TOOL_NAME, 'skill_retrospect');
  assert.deepEqual(RETROSPECT_TRIGGERS, ['issue_rejected', 'negative_feedback']);
  const rawSchema = {
    type: 'object',
    additionalProperties: false,
    required: Object.entries(SKILL_RETROSPECT_PARAMETERS)
      .filter(([, def]) => def.required)
      .map(([name]) => name),
    properties: Object.fromEntries(
      Object.entries(SKILL_RETROSPECT_PARAMETERS).map(([name, def]) => {
        const { required: _req, ...rest } = def;
        return [name, rest];
      }),
    ),
  };
  const flat = flattenSchema(rawSchema);
  assert.deepEqual(flat.required, ['trigger_type', 'summary']);
  assert.deepEqual(flat.properties.trigger_type.enum, ['issue_rejected', 'negative_feedback']);
  assert.equal(flat.properties.issue_id.type, 'string');
  assert.equal(flat.properties.focus_skill.type, 'string');
});

test('normalizeRetrospectArgs validates required trigger_type and non-empty summary', () => {
  assert.equal(normalizeRetrospectArgs({ trigger_type: 'timeout', summary: '超时' }).ok, false);
  assert.equal(normalizeRetrospectArgs({ trigger_type: 'negative_feedback', summary: '   ' }).ok, false);
  const valid = normalizeRetrospectArgs({
    trigger_type: 'issue_rejected',
    summary: '未跑真实命令只贴猜想导致打回',
    issue_id: ' #10 ',
    focus_skill: ' ',
  });
  assert.deepEqual(valid, {
    ok: true,
    value: {
      triggerType: 'issue_rejected',
      summary: '未跑真实命令只贴猜想导致打回',
      issueId: '#10',
      focusSkill: undefined,
    },
  });
});

test('evaluateRetrospectGate blocks when waiting proposals exist and passes otherwise', async () => {
  const blocked = await evaluateRetrospectGate({
    bot: { id: 'b1', name: '尚锦' },
    waitingProposals: [{ id: 'p1', name: 'old-skill' }],
    args: { triggerType: 'issue_rejected', summary: '被打回' },
    issueEvidence: { found: true },
  });
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /审批/);

  const allowed = await evaluateRetrospectGate({
    bot: { id: 'b1', name: '尚锦' },
    waitingProposals: [],
    args: { triggerType: 'negative_feedback', summary: '用户明确否定做法' },
    issueEvidence: { found: false },
  });
  assert.equal(allowed.allow, true);
  assert.equal(allowed.metadata.triggerType, 'negative_feedback');
  assert.equal(allowed.metadata.hasIssueEvidence, false);
});

test('readIssueEvidence resolves #N and I-xxxx safely and degrades when missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'retro-home-'));
  try {
    const missingDb = readIssueEvidence({ home, issueId: '#10' });
    assert.equal(missingDb.found, false);
    assert.equal(missingDb.issue, null);
    assert.match(missingDb.note, /不存在|未找到/);

    createIssueDb(home);
    const byNum = readIssueEvidence({ home, issueId: '#10' });
    assert.equal(byNum.found, true);
    assert.equal(byNum.issue.id, 'I-4d076aa4');
    assert.equal(byNum.issue.number, 10);
    assert.equal(byNum.issue.title, '测试一下新版事务');
    assert.equal(byNum.rejectComments.length, 1);
    assert.match(byNum.rejectComments[0].body, /真实 IP/);

    const byId = readIssueEvidence({ home, issueId: 'I-4d076aa4' });
    assert.equal(byId.found, true);
    assert.equal(byId.issue.number, 10);

    const notFound = readIssueEvidence({ home, issueId: '#999' });
    assert.equal(notFound.found, false);
    assert.match(notFound.note, /未找到/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('buildRetrospectLines preserves structured context even when chatLines is empty', () => {
  const lines = buildRetrospectLines({
    triggerType: 'issue_rejected',
    summary: '未实际验证就被打回',
    focusSkill: 'verify-before-submit',
    issueEvidence: {
      requested: '#10',
      found: true,
      issue: { id: 'I-4d076aa4', number: 10, title: '测试一下新版事务', status: 'dispatched', assigneeName: '尚锦' },
      rejectComments: [{ authorName: '管理员', body: '必须跑出真实输出再提交', at: 1600 }],
      statusComments: [{ body: '状态：待验收 → 进行中', at: 1500 }],
      note: null,
    },
    chatLines: [],
  });
  assert.ok(lines.length >= 4);
  const joined = lines.join('\n');
  assert.match(joined, /issue_rejected/);
  assert.match(joined, /未实际验证就被打回/);
  assert.match(joined, /verify-before-submit/);
  assert.match(joined, /必须跑出真实输出再提交/);
});
