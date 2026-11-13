import type { SessionUsage } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const TOOL = 'mcp__context-meter__usage'
const WINDOW = 1_000_000
const COMPACT_AT = 950_000

// Builds the value that $.session.usage() returns, with the /context breakdown
// when the caller requests it.
const usage = (tokens: number | undefined, withBreakdown: boolean): SessionUsage => ({
  startedAt: 0,
  rateLimits: [],
  context: {
    tokens,
    window: WINDOW,
    percent: tokens === undefined ? undefined : Math.round((100 * tokens) / WINDOW),
    breakdown: withBreakdown
      ? {
          categories: [
            { name: 'System prompt', tokens: 6_100, color: 'promptBorder', isDeferred: false, kind: 'used' },
            { name: 'Messages', tokens: 52_300, color: 'permission', isDeferred: false, kind: 'used' },
            { name: 'MCP tools', tokens: 12_000, color: 'inactive', isDeferred: true, kind: 'deferred' },
            { name: 'Free space', tokens: 854_000, color: 'inactive', isDeferred: false, kind: 'free' },
            { name: 'Autocompact buffer', tokens: 50_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
          ],
          totalTokens: tokens ?? 0,
          maxTokens: WINDOW,
          rawMaxTokens: WINDOW,
          autocompactSource: 'auto',
          percentage: 10,
          gridRows: [],
          model: 'Opus 5.5',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          autoCompactThreshold: COMPACT_AT,
          isAutoCompactEnabled: true,
          apiUsage: null,
        }
      : undefined,
  },
})

test('Registers the tool at session start and lists it in the prompt', async ($, on) => {
  const specs: unknown[] = []
  on('tool.register', (_, e) => {
    specs.push(e)

    return { value: { tool: TOOL } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(specs).toHaveLength(1)
  expect(specs[0]).toMatchObject({ name: 'usage', isDeferred: false })
})

test('Reports the token count and the distance to auto-compaction', async ($, on) => {
  on('session.usage', (_, e) => ({ value: usage(95_415, e?.breakdown !== undefined) }))

  const brief = await $.tool.call({ tool: TOOL })
  expect(brief.result).toBe(
    'Context: 95,415 of 1,000,000 tokens (9.5%) as of the last API response.\n' +
      'Auto-compaction threshold: 950,000 tokens (10% used).\n' +
      'Tokens until auto-compaction: 854,585.',
  )

  const full = await $.tool.call({ tool: TOOL, breakdown: true })
  expect(full.result).toContain('Tokens by category (estimated as in /context):')
  expect(full.result).toContain('Messages')
  expect(full.result).toContain('MCP tools')
  expect(full.result).toContain('(outside the context until loaded)')
})

test('Reports an unknown context before the first API response', async ($, on) => {
  on('session.usage', (_, e) => ({ value: usage(undefined, e?.breakdown !== undefined) }))

  const r = await $.tool.call({ tool: TOOL })
  expect(r.result).toContain('Context: unknown until the next API response')
  expect(r.result).toContain('Context window: 1,000,000 tokens.')
  expect(r.result).toContain('Auto-compaction threshold: 950,000 tokens.')
})

test('Gives one heads-up per threshold and starts again after the context shrinks', async ($, on) => {
  let tokens = 100_000
  on('session.usage', (_, e) => ({ value: usage(tokens, e?.breakdown !== undefined) }))
  on('tool.call', () => ({ result: {} }))
  const bash = async () => (await $.tool.call({ tool: 'Bash', command: 'ls' })).context

  expect(await bash()).toBeUndefined()

  tokens = 500_000
  expect((await bash())?.[0]).toBe(
    'Heads-up from context-meter: the context holds 500,000 tokens, which is 53% of the auto-compaction ' +
      'threshold (950,000 tokens). Call mcp__context-meter__usage for details.',
  )
  expect(await bash()).toBeUndefined()

  // Passing 75% and 90% in one step produces a single heads-up.
  tokens = 900_000
  const jumped = await bash()
  expect(jumped).toHaveLength(1)
  expect(jumped?.[0]).toContain('95% of the auto-compaction threshold')
  expect(await bash()).toBeUndefined()

  // After a compaction, the next heads-up comes when the context passes a
  // threshold again.
  tokens = 40_000
  expect(await bash()).toBeUndefined()
  tokens = 480_000
  expect((await bash())?.[0]).toContain('51% of the auto-compaction threshold')
})

test('Gives no heads-up on subagent tool calls', async ($, on) => {
  on('session.usage', (_, e) => ({ value: usage(900_000, e?.breakdown !== undefined) }))
  on('tool.call', () => ({ result: {} }))

  const r = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  expect(r.context).toBeUndefined()
})

test('Takes the thresholds from the headsUpAt setting', { options: { headsUpAt: '20, 40%' } }, async ($, on) => {
  let tokens = 200_000
  on('session.usage', (_, e) => ({ value: usage(tokens, e?.breakdown !== undefined) }))
  on('tool.call', () => ({ result: {} }))
  const bash = async () => (await $.tool.call({ tool: 'Bash', command: 'ls' })).context

  expect((await bash())?.[0]).toContain('21% of the auto-compaction threshold')
  tokens = 300_000
  expect(await bash()).toBeUndefined()
  tokens = 400_000
  expect((await bash())?.[0]).toContain('42% of the auto-compaction threshold')
})

test('Gives no heads-ups when headsUpAt is off', { options: { headsUpAt: 'off' } }, async ($, on) => {
  on('session.usage', (_, e) => ({ value: usage(900_000, e?.breakdown !== undefined) }))
  on('tool.call', () => ({ result: {} }))

  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context).toBeUndefined()
})

test('Falls back to the default thresholds when headsUpAt is invalid', { options: { headsUpAt: 'soon' } }, async ($, on) => {
  on('session.usage', (_, e) => ({ value: usage(500_000, e?.breakdown !== undefined) }))
  on('tool.call', () => ({ result: {} }))

  const note = (await $.tool.call({ tool: 'Bash', command: 'ls' })).context
  expect(note?.[0]).toContain('53% of the auto-compaction threshold')
})
