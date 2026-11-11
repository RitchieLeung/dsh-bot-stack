#!/usr/bin/env node
/**
 * Patch: give dscord's memory pipeline its own session id.
 *
 * WHY
 * dscord runs automatic memory review as an LLM call that must return one JSON
 * proposal, and it sends that call with the Bot's own chat session id
 * (`rt.chatOf(bot.id)`). On stateless API routes (deepseek, kimi) the session id
 * is bookkeeping only, so this works.
 *
 * On local-agent routes (`codex-cli`, `claude-code`, ACP) ds-bot keeps a durable
 * CLI thread per DSH session id, and it injects the request's system
 * instructions ONLY into a brand-new thread
 * (`instructions: kind === 'codex' && freshCli ? instructions : undefined` in
 * vendor/ds-bot/src/host/local-agents/adapter.js). The Bot's chat thread always
 * exists, so `freshCli` is false, the "answer with JSON only" instruction is
 * dropped, the review lands in the Bot's real conversation as a plain user
 * message, and the agent answers conversationally ("收到，索引仍与上一条相同。")
 * instead of JSON. Result: no memories are ever produced for those Bots, and the
 * Bot's own thread is polluted with review payloads.
 *
 * WHAT
 * Send memory calls to a dedicated `memory:<botId>` session, which produces a
 * fresh CLI thread that does receive the JSON instruction and stays isolated
 * from the Bot's chat. Token accounting still uses the Bot's chat session.
 *
 * Usage:
 *   node patches/dscord-memory-session.mjs [--check] [dscord-dir]
 *   (default dscord-dir: /Users/ritchie_leung/.dsh/profiles/web/node_modules/dscord)
 *
 * Re-run this after any dscord upgrade or reinstall.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_DSCORD =
  '/Users/ritchie_leung/.dsh/profiles/web/node_modules/dscord'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const dir = args.find(argument => !argument.startsWith('--')) ?? DEFAULT_DSCORD
const file = path.join(dir, 'memory', 'native.mjs')

const ANCHOR = '  async function oneShot(bot, system, text, tag = {}) {'
const HELPER = `  // Memory review must not ride the Bot's own conversation. On CLI-agent routes
  // (codex, claude, acp) the JSON instruction is injected only into a brand-new CLI
  // thread; a review sent into the existing chat thread is answered
  // conversationally and never parses. A dedicated session id gives the memory
  // pipeline its own thread, isolated from the Bot's chat.
  const memorySessionId = bot => \`memory:\${bot.id}\`;
`
const BEFORE = "      sessionId: tag.sessionId || rt.chatOf(bot.id), purpose: 'memory', system, messages, maxTokens,"
const AFTER = "      sessionId: tag.sessionId || memorySessionId(bot), purpose: 'memory', system, messages, maxTokens,"

const source = readFileSync(file, 'utf8')
const patched = source.includes('const memorySessionId = bot =>') && source.includes(AFTER)

if (checkOnly) {
  if (!patched) {
    console.error(`NOT PATCHED: ${file}`)
    process.exit(1)
  }
  console.log(`OK: memory sessions are isolated in ${file}`)
  process.exit(0)
}

if (patched) {
  console.log(`Already patched: ${file}`)
  process.exit(0)
}
if (!source.includes(BEFORE)) {
  console.error(`Cannot patch: expected call site not found in ${file}`)
  console.error('dscord changed; re-read memory/native.mjs and update this patch.')
  process.exit(1)
}

const helperAlreadyThere = source.includes('const memorySessionId = bot =>')
let next = source.replace(BEFORE, AFTER)
if (!helperAlreadyThere) {
  if (!next.includes(ANCHOR)) {
    console.error(`Cannot patch: anchor not found in ${file}`)
    process.exit(1)
  }
  next = next.replace(ANCHOR, `${HELPER}\n${ANCHOR}`)
}

writeFileSync(file, next)
console.log(`Patched: ${file}`)
