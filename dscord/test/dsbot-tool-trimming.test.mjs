import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

test('tools.js omits MAIN_ONLY_TOOLS for non-main Bots and masks redundant DSH native tools for local CLI Bots', async () => {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@deepseek-ai/dsh-tools') return { url: 'data:text/javascript,export const defineTool = x => x;', shortCircuit: true };
      if (specifier === 'deep-view/core') return { url: 'data:text/javascript,export const checkShownView = () => ({}); export const showViewDescription = () => ""; export const showViewParameters = {};', shortCircuit: true };
      return next(specifier, context);
    },
  });
  try {
    const { install } = await import('../vendor/ds-bot/src/host/tools.js');

    const listeners = new Map();
    const servedBase = [
      'bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_fetch', 'read_image',
      'spawn_teammate', 'wait_agent', 'team_task_update',
      'issue_get', 'issue_update', 'issue_create', 'issue_assign', 'issue_link', 'issue_unlink',
    ];
    const ctx = {
      on(event, fn) {
        (listeners.get(event) ?? listeners.set(event, []).get(event)).push(fn);
        return () => {};
      },
      effect() { return () => {}; },
      tools: {
        guard() { return () => {}; },
        schemas() { return servedBase.map(name => ({ name })); },
      },
      get() { return undefined; },
    };

    const bots = {
      'bot-main': { id: 'bot-main', name: '小欣', model: 'deepseek-official/deepseek-flash' },
      'bot-cli': { id: 'bot-cli', name: '真莹', model: 'codex-cli/gpt-6.1-sol' },
    };
    const shadowedAgents = [];
    const rt = {
      ctx,
      state: { bots, rooms: {} },
      config: { preserveNativeTools: true },
      teamTools: [],
      localAgentTools: [{ name: 'approve_agent_action', execute: async () => '' }],
      warn() {},
      load: async () => {},
      isBotSession: (id) => Boolean(bots[id]),
      selfOf: (id) => id,
      botOf: (id) => bots[id],
      roomOf: () => undefined,
      isMain: (id) => id === 'bot-main',
      isLocalAgentRef: (ref) => typeof ref === 'string' && ref.startsWith('codex-cli/'),
      shadowShells: (agent) => { shadowedAgents.push(agent.session.id); return []; },
    };

    install(rt);

    function makeAgent(id) {
      const registered = new Set();
      const denied = new Set();
      const agent = {
        id,
        session: { id },
        ctx: {
          on() { return () => {}; },
          tools: {
            register(def) {
              registered.add(def.name);
              return () => registered.delete(def.name);
            },
            restrict({ deny }) {
              for (const n of deny) denied.add(n);
              return () => { for (const n of deny) denied.delete(n); };
            },
          },
        },
      };
      return { agent, registered, denied };
    }

    const main = makeAgent('bot-main');
    const cli = makeAgent('bot-cli');

    for (const fn of listeners.get('agent/created') ?? []) {
      await fn({ agent: main.agent });
      await fn({ agent: cli.agent });
    }

    // 1. Main Bot receives MAIN_ONLY_TOOLS; non-main Bot does NOT
    for (const name of ['create_bot', 'stop_bot', 'create_group', 'delete_group']) {
      assert.ok(main.registered.has(name), `main bot should have ${name}`);
      assert.equal(cli.registered.has(name), false, `non-main bot should NOT have ${name}`);
    }
    assert.ok(cli.registered.has('message_bot'), 'non-main bot still has collaboration tools');
    assert.ok(cli.registered.has('approve_agent_action'), 'local CLI bot receives localAgentTools');

    // 2. Local CLI Bot masks redundant DSH native tools and skips shadowShells
    assert.deepEqual(shadowedAgents, ['bot-main'], 'shadowShells should run only on native-model Bot, not local CLI Bot');
    for (const name of ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_fetch', 'read_image', 'spawn_teammate', 'wait_agent', 'team_task_update']) {
      assert.ok(cli.denied.has(name), `local CLI bot should mask redundant DSH tool: ${name}`);
      assert.equal(main.denied.has(name), false, `native-model bot should NOT mask ${name}`);
    }
    assert.equal(cli.denied.has('issue_get'), false, 'local CLI bot keeps issue_get');
    assert.equal(cli.denied.has('issue_update'), false, 'local CLI bot keeps issue_update');
    for (const name of ['issue_create', 'issue_assign', 'issue_link', 'issue_unlink']) {
      assert.ok(cli.denied.has(name), `non-main bot should mask main-only global tool: ${name}`);
      assert.equal(main.denied.has(name), false, `main bot should keep ${name}`);
    }

    // 3. Switching CLI Bot back to a native LLM lifts redundant local-agent masks while keeping main-only masks
    bots['bot-cli'].model = 'deepseek-official/deepseek-flash';
    rt.syncScopedTools();
    for (const fn of listeners.get('tools/change') ?? []) fn();
    for (const fn of listeners.get('agent/created') ?? []) {
      await fn({ agent: cli.agent });
    }
    assert.deepEqual([...cli.denied].sort(), ['issue_assign', 'issue_create', 'issue_link', 'issue_unlink']);
  } finally {
    hooks.deregister();
  }
});

test('steward linesFor triggers compaction at 45% and caps 1M-window models at 120K/160K', async () => {
  const { linesFor, DEFAULT_CHECK_RATIO, MAX_CHECK_TOKENS, MAX_HARD_TOKENS } = await import('../vendor/ds-bot/src/host/steward.js');
  assert.equal(DEFAULT_CHECK_RATIO, 0.45);
  assert.equal(MAX_CHECK_TOKENS, 120_000);
  assert.equal(MAX_HARD_TOKENS, 160_000);

  // 128K model (DeepSeek): 45% check / 65% hard
  const ds = linesFor({ window: 128_000, reserve: 8_000 });
  assert.equal(ds.usable, 120_000);
  assert.equal(ds.check, 54_000);
  assert.equal(ds.hard, 78_000);

  // 200K model: 45% check / 65% hard
  const mid = linesFor({ window: 200_000, reserve: 16_000 });
  assert.equal(mid.usable, 184_000);
  assert.equal(mid.check, Math.floor(184_000 * 0.45));
  assert.equal(mid.hard, Math.floor(184_000 * 0.65));

  // 1M model (Kimi / Gemini): capped at 120K check / 160K hard instead of 450K/800K
  const huge = linesFor({ window: 1_000_000, reserve: 32_000 });
  assert.equal(huge.check, 120_000);
  assert.equal(huge.hard, 160_000);

  // Explicit Infinity disables absolute cap (percent-only mode when user sets compactMaxK = 0)
  const uncapped = linesFor({ window: 1_000_000, reserve: 0, checkRatio: 0.45, maxCheckTokens: Infinity, maxHardTokens: Infinity });
  assert.equal(uncapped.check, 450_000);
  assert.equal(uncapped.hard, 650_000);
});

test('WorkCore.guard enforces configurable frontMaxToolCalls from state.prefs and resets on turn/start', async () => {
  const { WorkCore } = await import('../dsh-connect/work-core.mjs');
  const prefs = { frontMaxToolCalls: 3 };
  let turnListener = null;
  const ctx = {
    tools: { guard: () => () => {} },
    on: (ev, fn) => { if (ev === 'session/event') turnListener = fn; return () => {}; },
  };
  const core = new WorkCore({
    ctx,
    native: { runtime: { state: { prefs } } },
    node: { id: 'n1', nativeBotId: 'bot-1' },
    state: {},
    save: () => {},
  });
  core.frontSessions.add('s-front');

  const execOf = (name) => ({ name, agent: { session: { id: 's-front' } } });
  // FRONT_TOOLS never consume the budget
  assert.equal(core.guard(execOf('issue_get')), undefined);
  assert.equal(core.guard(execOf('dispatch_work')), undefined);
  // First 3 execution calls pass; 4th is blocked with dispatch_work guidance
  assert.equal(core.guard(execOf('bash')), undefined);
  assert.equal(core.guard(execOf('edit')), undefined);
  assert.equal(core.guard(execOf('bash')), undefined);
  const blocked = core.guard(execOf('bash'));
  assert.match(blocked, /上限（3 次）/);
  assert.match(blocked, /dispatch_work/);

  // New turn resets counter
  turnListener({ id: 's-front' }, { type: 'turn/start' });
  assert.equal(core.guard(execOf('bash')), undefined);

  // Setting frontMaxToolCalls = 0 disables the guard live without restart
  prefs.frontMaxToolCalls = 0;
  for (let i = 0; i < 10; i++) assert.equal(core.guard(execOf('bash')), undefined);
  core.dispose();
});
