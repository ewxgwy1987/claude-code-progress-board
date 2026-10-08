# progress-board user manual

This manual covers everyday use. The [README](README.md) is the full reference, including how the
mod works inside.

## 1. Get started

1. **Install** the mod as the [README](README.md#install) describes. The quickest way is
   `claude --plugin-dir /path/to/claude-code-progress-board`.
2. **Start a new session** and type `/progress-board`. The **Progress** pane opens and a short text
   summary appears in the transcript. This also shows that the mod loaded.
3. **Ask Claude for multi-step work**, such as "add a dark mode, with tests". For a visible plan, add
   "post a task list to the progress board, then start".
4. **Watch the pane.** Tasks, subagents, workflow runs and tool calls appear as bars with a percentage
   and the time left.

You do not have to open it by hand. The pane opens by itself once per session, when the first task, subagent,
workflow or goal appears, or when a saved board is restored. Tool calls alone do not open it.

## 2. Where the pane appears

| | Terminal | Desktop app | Phone (Remote Control) |
|---|---|---|---|
| Pane | Docked beside the chat in fullscreen from 110 columns, otherwise above the prompt | Side panel with tabs | Where the app places panes |
| Bars | Block characters `███░░`, 8 to 20 wide | Small graphic bars in the same colours | As the app draws them |

In the desktop app, the pane shares one panel with other panes as tabs. Click **Progress** to show it.
If you close the pane, `/progress-board` opens it again.

## 3. Commands

| Command | What it does |
|---|---|
| `/progress-board` | Opens the pane and prints a text summary of the board |
| `/progress-board clear` | Removes finished items. Running and pending items stay |
| `/progress-board wrap` | Switches between one-line and multi-line descriptions |
| `/progress-board wrap on` / `wrap off` | Sets wrapping on or off |

The wrap command, and the **Wrap descriptions** / **Single-line descriptions** button under the board,
change the current session only.

## 4. The `wrapText` option

| Option | Default | Meaning |
|---|---|---|
| `wrapText` | off | Show every description in full, on several lines, by default |

Change it in Claude Code's config menu (`/config`), where plugin options are listed under the plugin's
name. Use this option for a lasting default; the button and the command are not saved.

## 5. Reading the pane

### Sections

Each section shows only when it has something in it.

| Section | Shows |
|---|---|
| **Goal** | The current `/goal`, set by you or proposed by Claude and accepted |
| **Tasks** | The task list Claude posts for multi-step work |
| **Subagents** | Each subagent, with its type and description |
| **Workflows** | Each workflow run, with one indented `↳` row per agent |
| **Activity** | The tool calls of the current turn |

Each section starts with a header row: its name, `done/total`, an overall bar and a note.

### Rows

A row reads, from left to right: time, symbol, description, bar, percentage, note.

| Symbol | Meaning |
|---|---|
| `▶` | Running |
| `✓` | Done |
| `○` | Waiting: pending, blocked or paused |
| `✗` | Failed |

| Colour | Meaning |
|---|---|
| Green | Done |
| Cyan | Running, within its estimate |
| Yellow | Running longer than its estimate. The bar stops at 99% |
| Grey | Waiting |
| Red | Failed, killed or interrupted, or a declined goal |

- The time is the finish time of a finished item, otherwise its start time.
- Unfinished rows always show, plus the 15 most recent finished ones, newest first.
- A task in progress is paused while Claude waits for you between turns. That time does not count.
- A blocked task says `blocked by #N`.
- In Workflows, agents that finished long ago fold into a `… N earlier agents finished` line.

### Estimates

Claude Code does not report progress, so the mod uses time. A running item's percentage is its elapsed
time divided by its estimate. The estimate is the median of your own past durations of the same kind,
so it improves with use. Until something of that kind has finished once, the bar stays at 0% and the
note says `no estimate yet`.

> **Tip:** Tasks appear only when Claude decides to post a list. For multi-step work, ask Claude to
> "post a task list" at the start.

## 6. Using several windows

You can open the same session in the desktop app and in a terminal (`claude --resume <session-id>`).

- The boards sync between the windows every few seconds.
- When the same item differs, the more finished copy wins.
- If a window closes mid-run, its runs show as *interrupted* when the session resumes.
- A `clear` in one window can be brought back by the other window's copy, so clear in both.

## 7. Token cost

| Action | Model calls |
|---|---|
| Drawing the pane, timers, saving, syncing | None |
| The `tasks` tool | None. Its description is part of Claude's tool list, and its reply is one short line |
| Naming a workflow agent with no title | At most one small Haiku call per agent, and only after the metadata file and journal both failed |

The Haiku call sends the start of that agent's transcript. Board snapshots for the last 20 sessions are
kept in the plugin store on your machine.

## 8. Troubleshooting

| Symptom | What to do |
|---|---|
| No pane and no `/progress-board` command | Run `claude plugin validate` on the plugin folder. For `CLAUDE_CODE_PLUGIN_DIRS`, use an absolute path, put it in **user** settings, and start a new session |
| The pane did not open | It opens itself once per session. Run `/progress-board` |
| "Nothing running yet." | The board is empty. Items appear as soon as Claude works |
| Tasks or Subagents missing | Claude has not created any. Ask it to post a task list |
| `no estimate yet` and 0% | Nothing of that kind has finished yet |
| A bar sits at 99% in yellow | The item is taking longer than usual. It is still running |
| Items come back after `clear` | Another window on the same session merged them back. Clear in both windows |
| A workflow agent shows as `agent N` | No title could be found for it yet |
| A renamed task starts over | Tasks are matched by their text, so a new text is a new task |
| The desktop app shows the mod twice | Two folders load it, for example an old copy plus `CLAUDE_CODE_PLUGIN_DIRS`. Keep one |

## See also

[claude-code-mods](https://github.com/ewxgwy1987/claude-code-mods) lists this mod with its two
siblings, usage-meter and session-toc.
