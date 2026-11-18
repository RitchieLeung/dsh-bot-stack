import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkCore } from '../dsh-connect/work-core.mjs';

function coreWithWorker() {
  const core = new WorkCore({
    ctx: { tools: { guard: () => () => {} } },
    native: {},
    node: { nativeBotId: 'native-test' },
    state: { tasks: { 'task-1': { id: 'task-1', sessionId: 'worker-session', status: 'dispatched' } } },
  });
  // 构造函数会把重启前未结束的任务标为 unknown；这里模拟本次运行中新登记的活动任务。
  core.state.tasks['task-1'].status = 'dispatched';
  return core;
}

test('worker can read, comment, and submit an issue for review', () => {
  const core = coreWithWorker();
  for (const name of ['issue_list', 'issue_get', 'issue_comment', 'issue_update']) {
    assert.equal(core.guard({ agent: { session: { id: 'worker-session' } }, name }), undefined, `${name} 不应被 worker 拒绝`);
  }
});

test('worker still cannot create, assign, or change issue dependencies', () => {
  const core = coreWithWorker();
  for (const name of ['issue_create', 'issue_assign', 'issue_link', 'issue_unlink']) {
    assert.equal(typeof core.guard({ agent: { session: { id: 'worker-session' } }, name }), 'string', `${name} 必须继续被禁止`);
  }
});

test('main front can assign and manage issue dependencies', () => {
  const core = coreWithWorker();
  core.frontSessions.add('main-session');
  for (const name of ['issue_create', 'issue_assign', 'issue_link', 'issue_unlink', 'issue_comment', 'issue_update']) {
    assert.equal(core.guard({ agent: { session: { id: 'main-session' } }, name }), undefined, `主 Bot 前台应允许 ${name}`);
  }
});
