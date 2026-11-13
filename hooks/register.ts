import type { EngineInterface, PluginOptions, Register, SessionContextUsage } from 'claude-code'

// Claude Code lists a plugin's tool under the name mcp__<plugin>__<tool>.
const TOOL_NAME = 'usage'
const TOOL = 'mcp__context-meter__usage'

const TOOL_DESCRIPTION =
  'Reports how full your context window is: the tokens in context, the size of the window and the distance to the ' +
  'auto-compaction threshold. The call is fast and adds only its short answer to the context. Call it before ' +
  'reading large files or starting many subagents, and whenever a session has run long.'

// Claude receives a heads-up the first time the context passes each of these
// fractions of the auto-compaction threshold (or of the context window when
// auto-compaction is off). The headsUpAt setting replaces these defaults.
const DEFAULT_THRESHOLDS = [0.5, 0.75, 0.9]

// The plugin caches the auto-compaction threshold. It refreshes the cache when
// the context window changes, as after a model switch, and after this many
// tool calls so that changes to the compaction settings also take effect.
const REFRESH_EVERY = 50

type Limits = {
  /** Size of the model's context window in tokens. */
  window: number
  /** Token count at which auto-compaction runs (undefined when it is off). */
  compactAt?: number
  /** Token count that the heads-up thresholds are fractions of. */
  base: number
}

// Formats a number with thousands separators, as in 95,415.
const num = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

// Formats a token count compactly, as in 3.2k or 1.05M.
const short = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : String(Math.round(n))

// Formats part / whole as a percentage, with one decimal place below 10%.
const pct = (part: number, whole: number) => {
  if (!(whole > 0)) {
    return '?%'
  }
  const p = (100 * part) / whole

  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`
}

/**
 * Parses the headsUpAt setting, which holds comma-separated percentages such
 * as "50,75,90", or "off" to disable heads-ups. Only entries above 0 and up to
 * 100 count, and the defaults apply when no such entry remains.
 */
function thresholdsOf(options: PluginOptions): number[] {
  const raw = options['headsUpAt']
  if (typeof raw !== 'string') {
    return DEFAULT_THRESHOLDS
  }
  if (/^\s*(off|none)\s*$/i.test(raw)) {
    return []
  }
  const fractions = raw
    .split(',')
    .map(part => Number(part.trim().replace(/%$/, '')))
    .filter(p => Number.isFinite(p) && p > 0 && p <= 100)
    .map(p => p / 100)
  const sorted = [...new Set(fractions)].sort((a, b) => a - b)

  return sorted.length > 0 ? sorted : DEFAULT_THRESHOLDS
}

// Derives the auto-compaction threshold and the heads-up base from the usage
// figures of Claude Code.
function limitsOf(context: SessionContextUsage): Limits {
  const b = context.breakdown
  const compactAt = b?.isAutoCompactEnabled ? b.autoCompactThreshold : undefined

  return { window: context.window, compactAt, base: compactAt ?? b?.rawMaxTokens ?? context.window }
}

// Builds the text of the tool's answer.
function report(context: SessionContextUsage, wantsBreakdown: boolean, isSubagent: boolean): string {
  const { tokens, window, breakdown } = context
  const { compactAt } = limitsOf(context)
  const lines: string[] = []

  if (isSubagent) {
    lines.push("These figures belong to the main conversation, whose context is separate from this subagent's.")
  }

  if (tokens === undefined) {
    lines.push(
      'Context: unknown until the next API response, because the session has just started or has just been compacted.',
      `Context window: ${num(window)} tokens.`,
    )
  } else {
    lines.push(`Context: ${num(tokens)} of ${num(window)} tokens (${pct(tokens, window)}) as of the last API response.`)
  }

  if (compactAt === undefined) {
    if (breakdown !== undefined) {
      lines.push('Auto-compaction: off.')
    }
  } else if (tokens === undefined) {
    lines.push(`Auto-compaction threshold: ${num(compactAt)} tokens.`)
  } else {
    lines.push(
      `Auto-compaction threshold: ${num(compactAt)} tokens (${pct(tokens, compactAt)} used).`,
      `Tokens until auto-compaction: ${num(Math.max(0, compactAt - tokens))}.`,
    )
  }

  if (wantsBreakdown && breakdown !== undefined) {
    const rows = breakdown.categories.filter(row => row.tokens > 0)
    const width = Math.max(0, ...rows.map(row => row.name.length))
    lines.push('', 'Tokens by category (estimated as in /context):')
    for (const row of rows) {
      const note = row.kind === 'deferred' ? '  (outside the context until loaded)' : ''
      lines.push(`  ${row.name.padEnd(width)}  ${short(row.tokens).padStart(7)}${note}`)
    }
  }

  return lines.join('\n')
}

// Builds the heads-up that Claude receives with a tool result.
function headsUp(tokens: number, limits: Limits): string {
  const share =
    limits.compactAt === undefined
      ? `${pct(tokens, limits.base)} of the context window (${num(limits.base)} tokens) with auto-compaction off`
      : `${pct(tokens, limits.compactAt)} of the auto-compaction threshold (${num(limits.compactAt)} tokens)`

  return `Heads-up from context-meter: the context holds ${num(tokens)} tokens, which is ${share}. Call ${TOOL} for details.`
}

/**
 * State that the heads-up logic keeps between tool calls. The state lives in
 * memory and starts afresh whenever Claude Code reloads the plugin.
 */
type Meter = {
  /** Heads-up thresholds as ascending fractions (empty when heads-ups are off). */
  thresholds: number[]
  /** Cached limits, refreshed as described at REFRESH_EVERY. */
  limits?: Limits
  /** Tool calls since the last refresh of the limits. */
  callsSinceRefresh: number
  /** Index of the highest threshold already announced, or -1 for none. */
  lastPassed: number
}

/**
 * Returns the heads-up that is due after a tool call in the main
 * conversation, or undefined when none is due.
 */
async function headsUpDue($: EngineInterface, meter: Meter): Promise<string | undefined> {
  if (meter.thresholds.length === 0) {
    return undefined
  }
  const { tokens, window } = (await $.session.usage()).context
  if (tokens === undefined) {
    return undefined
  }

  meter.callsSinceRefresh += 1
  if (meter.limits === undefined || meter.limits.window !== window || meter.callsSinceRefresh >= REFRESH_EVERY) {
    meter.limits = limitsOf((await $.session.usage({ breakdown: 'summary' })).context)
    meter.callsSinceRefresh = 0
  }
  const limits = meter.limits

  // No await separates reading lastPassed from updating it, so parallel tool
  // calls cannot announce the same threshold twice.
  const passed = meter.thresholds.reduce((at, share, i) => (tokens >= share * limits.base ? i : at), -1)
  // A drop below the last announced threshold means that the context has
  // shrunk through a compaction or /clear, so the thresholds apply again.
  if (passed < meter.lastPassed) {
    meter.lastPassed = passed
  }
  if (passed <= meter.lastPassed) {
    return undefined
  }
  meter.lastPassed = passed

  return headsUp(tokens, limits)
}

export const register: Register = (on, options) => {
  const meter: Meter = { thresholds: thresholdsOf(options), callsSinceRefresh: 0, lastPassed: -1 }

  // Claude Code accepts tool registrations once the session has started.
  // Listing the tool in the prompt from the start (isDeferred: false) lets
  // Claude see it immediately.
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          breakdown: {
            type: 'boolean',
            description:
              'Also list the estimated tokens per category (system prompt, tools, memory files, messages and others) as /context does.',
          },
        },
        additionalProperties: false,
      },
      isDeferred: false,
    })

    return next(e)
  })

  // Answers Claude's calls to the tool.
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    meter.limits = limitsOf(context)
    meter.callsSinceRefresh = 0
    const wantsBreakdown = (e as Record<string, unknown>)['breakdown'] === true

    return { result: report(context, wantsBreakdown, e.agentId !== undefined) }
  }).catch(() => ({
    deny: 'The context-meter plugin failed to get the usage figures from Claude Code. The user can run /context to see them.',
  }))

  // Attaches a heads-up to a tool result when one is due. On any failure the
  // tool result passes through unchanged, so a heads-up can never break a
  // tool call.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    // Calls to this plugin's own tool, subagent calls and refused calls get no
    // heads-up.
    if (e.tool === TOOL || e.agentId !== undefined || ran.deny !== undefined) {
      return ran
    }

    const note = await headsUpDue($, meter).catch(() => undefined)

    return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e))
}
