#!/usr/bin/env node
/**
 * Patch: make dscord's memory review survive CLI-agent Bot routes.
 *
 * Two independent defects, both in `memory/native.mjs`:
 *
 * 1. SESSION — the review call reuses the Bot's own chat session id
 *    (`rt.chatOf(bot.id)`). On local-agent routes (codex-cli, claude-code, ACP)
 *    ds-bot keeps a durable CLI thread per session id and injects the request's
 *    instructions ONLY into a brand-new thread
 *    (`instructions: kind === 'codex' && freshCli ? instructions : undefined` in
 *    vendor/ds-bot/src/host/local-agents/adapter.js). The chat thread always
 *    exists, so the "answer with JSON only" instruction is dropped, the review
 *    lands in the Bot's real conversation, and the agent answers conversationally.
 *    Fix: give memory its own `memory:<botId>` session, which also stops review
 *    payloads from polluting the Bot's chat thread.
 *
 * 2. MODEL — even in a brand-new thread the Codex app-server agent still answers
 *    the review prompt in prose instead of the required JSON proposal, so those
 *    Bots never get any memory at all (measured: 991 failures vs 59 proposals;
 *    真莹 at 0 memories). The same prompt on an API model is fine (鲸鱼 at 54
 *    memories on deepseek-flash). Fix: run the mechanical extraction on a
 *    configured API model. Override with `config.memoryReviewModel` or
 *    `DSCORD_MEMORY_REVIEW_MODEL`; default `deepseek-official/deepseek-flash`.
 *
 * Usage:
 *   node patches/dscord-memory-session.mjs [--check] [dscord-dir]
 *   (default dscord-dir: /Users/ritchie_leung/.dsh/profiles/web/node_modules/dscord)
 *
 * Re-run after any dscord upgrade or reinstall.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_DSCORD = '/Users/ritchie_leung/.dsh/profiles/web/node_modules/dscord'
const REVIEW_MODEL_DEFAULT = 'deepseek-official/deepseek-flash'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const dir = args.find(argument => !argument.startsWith('--')) ?? DEFAULT_DSCORD
const file = path.join(dir, 'memory', 'native.mjs')

const ANCHOR = '  async function oneShot(bot, system, text, tag = {}) {'

const SESSION_HELPER = `  // Memory review must not ride the Bot's own conversation: on CLI-agent routes the
  // JSON instruction is injected only into a brand-new CLI thread, so a review sent
  // into the existing chat thread is answered conversationally and never parses.
  const memorySessionId = bot => \`memory:\${bot.id}\`;
`

const MODEL_HELPER = `  // Local-agent routes answer the review prompt in prose instead of the required JSON
  // proposal, so their Bots would never get a memory. The review is a mechanical
  // extraction job, so run it on a configured API model instead of the answering model.
  const CLI_MODEL_ROUTES = ['codex-cli', 'claude-code', 'opencode', 'devin-cli', 'cursor-cli', 'gemini-cli', 'grok-cli', 'cline', 'qwen-code', 'goose', 'acp'];
  const reviewModelReference = async (bot, signal) => {
    const own = await modelReference(bot, signal);
    const slash = typeof own === 'string' ? own.indexOf('/') : -1;
    if (slash <= 0 || !CLI_MODEL_ROUTES.includes(own.slice(0, slash))) return own;
    return config.memoryReviewModel || process.env.DSCORD_MEMORY_REVIEW_MODEL || '${REVIEW_MODEL_DEFAULT}';
  };
`

const edits = [
  {
    name: 'session isolation',
    before: "      sessionId: tag.sessionId || rt.chatOf(bot.id), purpose: 'memory', system, messages, maxTokens,",
    after: "      sessionId: tag.sessionId || memorySessionId(bot), purpose: 'memory', system, messages, maxTokens,",
    helper: SESSION_HELPER,
    helperMarker: 'const memorySessionId = bot =>',
  },
  {
    name: 'review model',
    before: '    const reference = await modelReference(bot, tag.signal);',
    after: '    const reference = await reviewModelReference(bot, tag.signal);',
    helper: MODEL_HELPER,
    helperMarker: 'const reviewModelReference = async (bot, signal) =>',
  },
]

const source = readFileSync(file, 'utf8')
const pending = edits.filter(edit => !(source.includes(edit.after) && source.includes(edit.helperMarker)))

if (checkOnly) {
  if (pending.length > 0) {
    console.error(`NOT PATCHED: ${file} — missing: ${pending.map(edit => edit.name).join(', ')}`)
    process.exit(1)
  }
  console.log(`OK: memory review is isolated and off the CLI model in ${file}`)
  process.exit(0)
}

if (pending.length === 0) {
  console.log(`Already patched: ${file}`)
  process.exit(0)
}

let next = source
const helpers = []
for (const edit of pending) {
  if (next.includes(edit.before)) next = next.replace(edit.before, edit.after)
  else if (!next.includes(edit.after)) {
    console.error(`Cannot patch ${edit.name}: call site not found in ${file}`)
    console.error('dscord changed; re-read memory/native.mjs and update this patch.')
    process.exit(1)
  }
  if (!next.includes(edit.helperMarker)) helpers.push(edit.helper)
}
if (helpers.length > 0) {
  if (!next.includes(ANCHOR)) {
    console.error(`Cannot patch: anchor not found in ${file}`)
    process.exit(1)
  }
  next = next.replace(ANCHOR, `${helpers.join('\n')}\n${ANCHOR}`)
}

writeFileSync(file, next)
console.log(`Patched: ${file} (${pending.map(edit => edit.name).join(', ')})`)
