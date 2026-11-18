import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openIssueStore } from '../lib/store.js';
import { startWriteback } from '../lib/writeback.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-'));
  const store = openIssueStore({ dbPath: ':memory:' });
  const issue = store.create({ title: 'X' });
  const nodesRoot = join(dir, 'nodes');
  const hostDir = join(nodesRoot, 'host1');
  mkdirSync(hostDir, { recursive: true });
  const bridge = tasks => writeFileSync(join(hostDir, 'native-bridge.json'), JSON.stringify({ version: 1, tasks }));
  return { dir, store, issue, nodesRoot, bridge };
}

test('writeback syncs a terminal task to its issue', () => {
  const { store, issue, nodesRoot, bridge } = setup();
  bridge({ 'T-1': { id: 'T-1', status: 'done', origin: { issueId: issue.id }, sessionId: 's1', reply: '做完了' } });
  const handle = startWriteback({ store, nodesRoot });
  handle.stop();
  const full = store.get(issue.id);
  assert.equal(full.status, 'in_review');
  assert.ok(full.comments.some(c => c.kind === 'result' && /做完了/.test(c.body)));
  assert.equal(full.dispatches[0].taskId, 'T-1');
  store.close();
});

test('writeback records a live task as dispatched', () => {
  const { store, issue, nodesRoot, bridge } = setup();
  bridge({ 'T-2': { id: 'T-2', status: 'running', origin: { issueId: issue.id }, sessionId: 's2' } });
  const handle = startWriteback({ store, nodesRoot });
  handle.stop();
  assert.equal(store.get(issue.id).status, 'dispatched');
  store.close();
});

test('writeback ignores tasks without an issueId', () => {
  const { store, issue, nodesRoot, bridge } = setup();
  bridge({ 'T-3': { id: 'T-3', status: 'done', origin: { roomId: '!room' }, sessionId: 's3', reply: '别的' } });
  const handle = startWriteback({ store, nodesRoot });
  handle.stop();
  assert.equal(store.get(issue.id).status, 'open'); // untouched
  store.close();
});

test('writeback tolerates a missing nodesRoot', () => {
  const { store, issue } = setup();
  const handle = startWriteback({ store, nodesRoot: join(tmpdir(), 'definitely-missing-dir') });
  handle.stop();
  assert.equal(store.get(issue.id).status, 'open');
  store.close();
});
