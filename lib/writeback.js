/**
 * Close the loop for issues dispatched through dscord's `dispatch_work`.
 *
 * dscord delivers a worker's result back to the room it came from; nothing
 * gives the issue a turn. This module watches each Bot node's
 * `native-bridge.json` task ledger and syncs the matching issue (by
 * `origin.issueId`): a live task marks the issue dispatched, a terminal task
 * settles it to in_review/failed/cancelled with the worker's own words.
 *
 * The sync is idempotent and one-way; a re-sweep of the same task is a no-op.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ACTIVE_TASK = new Set(['queued', 'running']);
const TERMINAL_TASK = new Set(['done', 'failed', 'cancelled', 'unknown']);

/** Human-readable result text for a settled task. */
function resultText(task) {
  if (task.status === 'done' || task.status === 'failed') {
    return (task.reply ?? task.summary ?? `task ${task.id} ${task.status}`).slice(0, 4000);
  }
  if (task.status === 'cancelled') return '任务已取消。';
  if (task.status === 'unknown') return '宿主重启时任务未结束，结果不确定。';
  return '';
}

/**
 * Start the periodic sweep.
 * @param store - store instance or zero-argument factory.
 * @param nodesRoot - `<dscord>/web/nodes` directory.
 * @param intervalMs - sweep period; defaults to 15s.
 * @returns a handle whose `stop()` clears the timer.
 */
export function startWriteback({ store, nodesRoot, intervalMs = 15_000, workerNameOf = null }) {
  const resolve = () => (typeof store === 'function' ? store() : store);

  const tick = () => {
    let hosts = [];
    try {
      hosts = readdirSync(nodesRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      return;
    }
    for (const host of hosts) {
      const file = join(nodesRoot, host, 'native-bridge.json');
      if (!existsSync(file)) continue;
      let state;
      try {
        state = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      for (const task of Object.values(state.tasks ?? {})) {
        const issueId = task.origin?.issueId;
        if (typeof issueId !== 'string' || !issueId) continue;
        if (!ACTIVE_TASK.has(task.status) && !TERMINAL_TASK.has(task.status)) continue;
        const workerSessionId = typeof task.sessionId === 'string' ? task.sessionId : null;
        try {
          resolve().syncTask(issueId, {
            taskId: task.id,
            workerSessionId,
            status: task.status,
            resultText: resultText(task),
            workerName: (workerNameOf && workerSessionId) ? workerNameOf(workerSessionId) : null,
          });
        } catch {
          // A task whose issue is gone or already closed is not fatal; the next sweep retries.
        }
      }
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
