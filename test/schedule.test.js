import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureDailyReportSchedules, normalizeTime, reportPrompt, reportTitle, REPORT_PREDICATE } from '../lib/schedule.js';

const BOTS = [
  { id: 'A', name: '甲', sessionId: 'session-a' },
  { id: 'B', name: '乙', sessionId: 'session-b' },
];

function fakeSchedule(items = []) {
  const calls = { create: [], edit: [], list: 0 };
  return {
    calls,
    async list() { calls.list += 1; return { items, shown: items.length, total: items.length, limit: 500, offset: 0 }; },
    async create(request) { calls.create.push(request); return { id: `new-${calls.create.length}`, ...request }; },
    async edit(request) { calls.edit.push(request); return { id: request.id, ...(request.patch || {}) }; },
  };
}

function existing(botId, { sessionId, prompt }) {
  return {
    id: `sched-${botId}`,
    title: reportTitle(botId),
    prompt,
    kind: 'daily',
    time: '19:00:00',
    timeZone: 'Asia/Shanghai',
    target: { kind: 'session', sessionId },
    status: 'active',
  };
}

test('an empty catalogue arms one daily task per bot', async () => {
  const schedule = fakeSchedule();
  const results = await ensureDailyReportSchedules({ schedule, bots: BOTS });
  assert.equal(schedule.calls.create.length, 2);
  assert.deepEqual(results.map(r => r.action), ['created', 'created']);
  const request = schedule.calls.create[0];
  assert.equal(request.title, reportTitle('A'));
  assert.deepEqual(request.timing, { kind: 'daily', daily: { time: '19:00:00', time_zone: 'Asia/Shanghai' } });
  assert.deepEqual(request.target, { kind: 'session', sessionId: 'session-a' });
});

test('matching tasks are left alone', async () => {
  const schedule = fakeSchedule([
    existing('A', { sessionId: 'session-a', prompt: reportPrompt({ botName: '甲' }) }),
    existing('B', { sessionId: 'session-b', prompt: reportPrompt({ botName: '乙' }) }),
  ]);
  const results = await ensureDailyReportSchedules({ schedule, bots: BOTS });
  assert.deepEqual(results.map(r => r.action), ['unchanged', 'unchanged']);
  assert.equal(schedule.calls.create.length, 0);
  assert.equal(schedule.calls.edit.length, 0);
});

test('a changed session is edited, never created a second time', async () => {
  const prompt = reportPrompt({ botName: '甲' });
  const schedule = fakeSchedule([existing('A', { sessionId: 'session-old', prompt })]);
  const results = await ensureDailyReportSchedules({ schedule, bots: [BOTS[0]] });
  assert.equal(results[0].action, 'updated');
  assert.equal(schedule.calls.create.length, 0, 'must not create a duplicate 19:00 task');
  assert.equal(schedule.calls.edit.length, 1);
  assert.equal(schedule.calls.edit[0].id, 'sched-A');
  assert.equal(schedule.calls.edit[0].action, 'update');
  assert.deepEqual(schedule.calls.edit[0].patch.target, { kind: 'session', sessionId: 'session-a' });
});

test('a changed prompt is refreshed too', async () => {
  const schedule = fakeSchedule([existing('A', { sessionId: 'session-a', prompt: 'old wording' })]);
  const results = await ensureDailyReportSchedules({ schedule, bots: [BOTS[0]] });
  assert.equal(results[0].action, 'updated');
  assert.equal(schedule.calls.create.length, 0);
});

test('a bot without a session is skipped instead of failing the run', async () => {
  const schedule = fakeSchedule();
  const results = await ensureDailyReportSchedules({ schedule, bots: [{ id: 'C', name: '丙', sessionId: null }] });
  assert.deepEqual(results, [{ botId: 'C', scheduleId: null, action: 'skipped' }]);
  assert.equal(schedule.calls.create.length, 0);
});

test('the prompt tells the bot exactly how to write the report', () => {
  const prompt = reportPrompt({ botName: '鲸鱼' });
  assert.match(prompt, /daily-report/);
  assert.match(prompt, /YYYY-MM-DD/);
  assert.match(prompt, /今天做了什么/);
  assert.match(prompt, /卡在哪/);
  assert.match(prompt, /明天/);
  assert.match(prompt, /不要.*回复|不需要.*回复/);
  assert.equal(REPORT_PREDICATE, 'daily-report');
});

test('a short HH:mm time is normalised to HH:mm:ss', async () => {
  const schedule = fakeSchedule();
  await ensureDailyReportSchedules({ schedule, bots: [BOTS[0]], time: '19:00' });
  assert.equal(schedule.calls.create[0].timing.daily.time, '19:00:00');
});

test('malformed times fall back to the default instead of reaching the schedule service', () => {
  for (const bad of ['25:00', '19:60', 'noon', '', null, undefined, 19]) {
    assert.equal(normalizeTime(bad), '19:00:00');
  }
  assert.equal(normalizeTime('7:05'), '07:05:00');
  assert.equal(normalizeTime('19:00:30'), '19:00:30');
});

test('an ended task is recreated instead of reported as unchanged', async () => {
  const schedule = fakeSchedule([
    { ...existing('A', { sessionId: 'session-a', prompt: reportPrompt({ botName: '甲' }) }), status: 'ended' },
  ]);
  const results = await ensureDailyReportSchedules({ schedule, bots: [BOTS[0]] });
  assert.equal(results[0].action, 'created');
  assert.equal(schedule.calls.create.length, 1);
});

test('a paused task is respected and not recreated', async () => {
  const schedule = fakeSchedule([
    { ...existing('A', { sessionId: 'session-a', prompt: reportPrompt({ botName: '甲' }) }), status: 'paused' },
  ]);
  const results = await ensureDailyReportSchedules({ schedule, bots: [BOTS[0]] });
  assert.equal(results[0].action, 'unchanged');
  assert.equal(schedule.calls.create.length, 0);
});
