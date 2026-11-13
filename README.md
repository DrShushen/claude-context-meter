# context-meter

This [Claude Code](https://code.claude.com/docs) plugin lets Claude check how full its context window is. Both `/context` and the status line show context usage to you, whereas Claude has no such view and cannot tell how close a long session is to auto-compaction (Claude Code's automatic summarising of the conversation when the context approaches its limit).

The plugin therefore gives Claude the tool `mcp__context-meter__usage`, which reports how many tokens the context holds, the size of the context window and the distance to the auto-compaction threshold. With `breakdown: true`, the tool also lists the tokens per category as `/context` does.

Because Claude might forget to call the tool, the plugin also gives Claude a heads-up the first time the context passes 50%, 75% and 90% of the auto-compaction threshold. Each heads-up arrives as a single line with the result of Claude's next tool call and is visible only to Claude in the main conversation. Once a compaction or `/clear` has shrunk the context, the thresholds apply again.

With these figures, Claude can plan its work around the context, for example by checking the usage before reading large files or by handing bulky tasks to a subagent.

## Example output

A call to the tool returns:

```text
Context: 221,294 of 1,000,000 tokens (22%) as of the last API response.
Auto-compaction threshold: 967,000 tokens (23% used).
Tokens until auto-compaction: 745,706.
```

With `breakdown: true`, the answer continues:

```text
Tokens by category (estimated as in /context):
  System prompt               3.2k
  System tools               20.4k
  MCP tools                    207
  MCP server instructions      722
  MCP tools (deferred)       15.8k  (outside the context until loaded)
  System tools (deferred)    27.9k  (outside the context until loaded)
  Skills                      5.9k
  Messages                  191.0k
  Autocompact buffer         33.0k
  Free space                745.7k
```

A heads-up looks like this:

```text
Heads-up from context-meter: the context holds 483,912 tokens, which is 50% of the auto-compaction threshold (967,000 tokens). Call mcp__context-meter__usage for details.
```

## Installation

The plugin relies on Claude Code's plugin function hooks, which are in early access and may change between releases (the plugin is tested with Claude Code 2.1.323).

To install it, enter this command at the prompt of a Claude Code session in a terminal:

```text
/plugin install context-meter --marketplace DrShushen/claude-context-meter
```

Claude Code then prompts you to confirm the new marketplace with `y`, choose a scope and confirm the settings. The plugin works in the current session as soon as the installation finishes. With the user scope, it also loads in all later sessions in every project.

From a shell, the equivalent command is:

```bash
claude plugin install context-meter --marketplace DrShushen/claude-context-meter
```

In the desktop app, click **+** next to the prompt box and choose **Plugins**. Then add the marketplace `DrShushen/claude-context-meter` with **Add marketplace** and install the plugin with **Add plugin**.

To uninstall the plugin, run:

```bash
claude plugin uninstall context-meter@claude-context-meter
```

To remove the marketplace as well, run `claude plugin marketplace remove claude-context-meter`.

## Usage

Claude calls the tool on its own whenever it needs the figures. You can also ask Claude for them directly with a question such as "How much context are we using?"

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `headsUpAt` | `50,75,90` | Comma-separated percentages of the auto-compaction threshold at which Claude receives a heads-up (`off` disables heads-ups) |

During `/plugin install`, Claude Code prompts for this setting and uses the default when the field is left empty. To change the setting later, run `/plugin configure context-meter@claude-context-meter` in Claude Code. From a shell, this command sets the thresholds to 60% and 85%:

```bash
echo '{"headsUpAt": "60,85"}' | claude plugin configure context-meter@claude-context-meter --values-stdin
```

A setting changed from the shell takes effect after Claude Code restarts.

## How it works

When a session starts, the plugin registers the tool with Claude Code. Each call to the tool returns the usage figures that Claude Code keeps for the session, which are also the figures behind the status line and `/context`. After each tool call in the main conversation, the plugin checks the figures again and, if the context has just passed a heads-up threshold, attaches the heads-up to the tool result as context that only Claude receives.

The plugin takes all its data from Claude Code and keeps its state in memory for the length of a session. Claude Code lists the tool's description in the prompt from the start of every session, which takes up about 200 tokens of context.

## Limitations

- The figures describe the context as of the last API response, so a large tool result that Claude has just received counts only from its next request onwards.
- When a subagent calls the tool, it receives the main conversation's figures with a note to that effect.

## Development

To work on the plugin, clone the repository and use the plugin commands of the Claude Code CLI:

```bash
git clone https://github.com/DrShushen/claude-context-meter
cd claude-context-meter
claude plugin validate .   # Checks the manifests and the hooks module
claude plugin test .       # Runs tests/*.test.ts against the Claude Code engine
claude --plugin-dir .      # Starts a session with the plugin loaded from this folder
```

Type checking needs the plugin API types, which Claude Code writes to `.claude-plugin/types/` when an interactive session loads the plugin through `claude --plugin-dir .`. After such a session, run `npx -p typescript tsc -p .`.

To make a clone your installed copy, add it as a marketplace and install the plugin from it. Claude Code then loads the plugin directly from the clone, so your changes take effect after `/reload-plugins`:

```bash
claude plugin marketplace add /path/to/claude-context-meter
claude plugin install context-meter@claude-context-meter
```

## Licence

The plugin is available under the [MIT License](LICENSE).
