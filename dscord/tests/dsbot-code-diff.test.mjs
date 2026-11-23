import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

test('diff-activity formats and parses single-line DIFF activity payloads and computes diff rows', async () => {
  const mod = await import('../vendor/ds-bot/src/host/local-agents/diff-activity.js');

  const line = mod.formatDiffActivity({
    tool: 'edit',
    path: 'src/app.js',
    oldText: 'const a = 1;\nconst b = 2;',
    newText: 'const a = 1;\nconst b = 3;\nconst c = 4;',
  });
  assert.ok(line.startsWith('▸ DIFF '), 'activity line should start with ▸ DIFF ');
  assert.equal(line.includes('\n'), false, 'activity line must be single-line');

  const parsed = mod.parseDiffActivity(line);
  assert.ok(parsed);
  assert.equal(parsed.tool, 'edit');
  assert.equal(parsed.path, 'src/app.js');
  assert.equal(parsed.added, 2);
  assert.equal(parsed.removed, 1);

  const rows = mod.diffRowsOf(parsed);
  assert.ok(rows.some(r => r.k === ' ' && r.s === 'const a = 1;'));
  assert.ok(rows.some(r => r.k === '-' && r.s === 'const b = 2;'));
  assert.ok(rows.some(r => r.k === '+' && r.s === 'const b = 3;'));
  assert.ok(rows.some(r => r.k === '+' && r.s === 'const c = 4;'));

  const unified = mod.formatDiffActivity({
    tool: 'apply_patch',
    path: 'lib/util.js',
    diff: '@@ -1,2 +1,2 @@\n-oldLine\n+newLine\n sameLine',
  });
  const parsedUnified = mod.parseDiffActivity(unified);
  assert.equal(parsedUnified.path, 'lib/util.js');
  assert.equal(parsedUnified.added, 1);
  assert.equal(parsedUnified.removed, 1);
  const uRows = mod.diffRowsOf(parsedUnified);
  assert.deepEqual(uRows, [
    { k: '@', s: '@@ -1,2 +1,2 @@' },
    { k: '-', s: 'oldLine' },
    { k: '+', s: 'newLine' },
    { k: ' ', s: 'sameLine' },
  ]);

  const claudeLines = mod.claudeDiffActivities({
    type: 'tool_use',
    name: 'Edit',
    input: { file_path: 'a.js', old_string: 'x', new_string: 'y' },
  });
  assert.equal(claudeLines.length, 1);
  assert.equal(mod.parseDiffActivity(claudeLines[0]).path, 'a.js');

  const acpLines = mod.acpDiffActivities({
    kind: 'edit',
    title: 'Edit b.js',
    locations: [{ path: 'b.js' }],
    rawInput: { old_string: '1', new_string: '2\n3' },
  });
  assert.equal(acpLines.length, 1);
  assert.equal(mod.parseDiffActivity(acpLines[0]).added, 2);
});

test('local-agents (codex, claude, acp) emit ▸ DIFF {...} activities on file modifications', async () => {
  const { CodexEngine } = await import('../vendor/ds-bot/src/host/local-agents/codex.js');
  const { parseDiffActivity } = await import('../vendor/ds-bot/src/host/local-agents/diff-activity.js');

  const codex = new CodexEngine('codex', { name: 'Codex', command: 'codex' }, { findExecutable: () => '/bin/echo' });
  const events = [];
  codex.threads.set('s1', {
    dshSessionId: 's1',
    threadId: 't1',
    dead: false,
    push: ev => events.push(ev),
  });

  codex.onNotice('item/completed', {
    threadId: 't1',
    item: {
      type: 'fileChange',
      changes: [
        {
          path: 'src/index.js',
          kind: 'update',
          diff: '@@ -1,2 +1,2 @@\n-const oldVal = 1;\n+const newVal = 2;\n export default newVal;',
        },
      ],
    },
  });

  const diffEvent = events.find(e => e.type === 'activity' && e.text.startsWith('▸ DIFF '));
  assert.ok(diffEvent, 'CodexEngine should emit a ▸ DIFF activity when fileChange item completes');
  const parsed = parseDiffActivity(diffEvent.text);
  assert.equal(parsed.path, 'src/index.js');
  assert.equal(parsed.added, 1);
  assert.equal(parsed.removed, 1);

  // Verify claude.js and acp.js wire formatDiffActivity
  const claudeSrc = readFileSync(join(rootDir, 'vendor/ds-bot/src/host/local-agents/claude.js'), 'utf8');
  const acpSrc = readFileSync(join(rootDir, 'vendor/ds-bot/src/host/local-agents/acp.js'), 'utf8');
  assert.match(claudeSrc, /formatDiffActivity/);
  assert.match(acpSrc, /formatDiffActivity/);
});

test('vendor/ds-bot/client.js draws file edit tool calls and DIFF activity rows with FileDiffCard', () => {
  const clientSrc = readFileSync(join(rootDir, 'vendor/ds-bot/client.js'), 'utf8');
  for (const toolName of ['edit', 'write', 'apply_patch', 'str_replace_editor', 'edit_file', 'write_file']) {
    assert.ok(
      clientSrc.includes(`"${toolName}"`),
      `DRAWN / renderCall in vendor/ds-bot/client.js must support "${toolName}"`,
    );
  }
  assert.match(clientSrc, /function FileDiffCard\(/, 'client.js should define FileDiffCard component');
  assert.match(clientSrc, /parseDiffActivityLine\(/, 'client.js should parse DIFF activity lines in AssistantCell');
});
