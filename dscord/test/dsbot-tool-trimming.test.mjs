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
      'spawn_teammate', 'wait_agent', 'team_task_update', 'issue_get', 'issue_update',
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

    // 3. Switching CLI Bot back to a native LLM lifts redundant tool masks automatically
    bots['bot-cli'].model = 'deepseek-official/deepseek-flash';
    rt.syncScopedTools();
    for (const fn of listeners.get('tools/change') ?? []) fn();
    // Simulate agent resolution via system-prompt/assemble or hideBotUnusedTools path
    for (const fn of listeners.get('agent/created') ?? []) {
      await fn({ agent: cli.agent });
    }
    assert.equal(cli.denied.size, 0, 'switching back to native model lifts all local-agent tool masks');
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
});
