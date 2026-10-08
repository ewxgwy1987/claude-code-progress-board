# progress-board

A Claude Code mod that adds a **Progress** pane. It shows what Claude is doing right now as coloured
progress bars, with a percentage, a start or finish time (to the second) and an estimate of the time left.

For everyday use, read the [user manual](MANUAL.md). This README is the full reference.

The pane has five sections, each shown only when it has something in it:

| Section | What it lists |
|---|---|
| **Goal** | The current goal, set by you (`/goal`) or proposed by Claude |
| **Tasks** | Claude's task list for the current piece of work |
| **Subagents** | Every subagent Claude starts, with its type and description |
| **Workflows** | Every workflow run, with one child row per workflow agent |
| **Activity** | The tool calls of the current turn |

Rows are newest first. Unfinished items are always shown, plus the 15 most recent finished ones.

What the pane looks like in a terminal (the desktop app draws the same rows with graphic bars):

```
10-09 14:02:11 ▶ Goal · All tests pass           ███████░░░░░░░   47%  active · plan 2/5 · 3 turns · 6m 10s

Tasks 2/5                                        ███████░░░░░░░   47%  ~4m 20s left
10-09 14:08:40 ▶ #3 Writing the migration        █████████░░░░░   61%  ~1m 05s left
10-09 14:07:02 ✓ #2 Add the schema               ██████████████  100%  done · took 3m 12s
10-09 14:03:55 ✓ #1 Read the current code        ██████████████  100%  done · took 1m 40s
10-09 14:02:15 ○ #4 Update the docs              ░░░░░░░░░░░░░░    0%  pending

Subagents 1/2                                    ██████████░░░░   72%  1 running · 1 done · ~50s left
10-09 14:09:30 ▶ Explore · Find call sites       ██████░░░░░░░░   45%  ~50s left · 7 tool calls · Grep
10-09 14:06:01 ✓ Plan · Design the migration     ██████████████  100%  done · took 2m 03s

Activity 3/4                                     ████████░░░░░░   58%  4 tool calls · ~2m 10s left
10-09 14:10:02 ▶ Bash · Run the test suite       ██████████████   99%  1m 12s elapsed · over estimate by 9s
10-09 14:09:12 ✓ Edit · migration.sql            ██████████████  100%  took 1s

Newest first · times are start or finish · estimates: median of 42 past durations
```

## Requirements

- A Claude Code build that supports function-hook plugins (plugins whose `hooks/hooks.json` lists
  TypeScript `modules`). This API is early access and may change between releases.
- Built and tested with Claude Code **2.1.289**.
- Nothing else. There is no build step and no npm install.

## Install

The repository root is the plugin. Clone it first:

```sh
git clone https://github.com/ewxgwy1987/claude-code-progress-board.git
```

Then pick one way of loading it.

**A. One session.** Start Claude Code with:

```sh
claude --plugin-dir /path/to/claude-code-progress-board
```

**B. Every session**, including the desktop app and Remote Control sessions started on that machine.
Add this to your **user** settings, `~/.claude/settings.json`. Project settings are ignored for this
setting.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-code-progress-board"
  }
}
```

- The path must be absolute; `~` is allowed.
- On Windows forward slashes work, for example `C:/src/claude-code-progress-board`.
- Separate several paths with `;` on Windows and `:` elsewhere.
- You can also name a folder that holds several mod clones side by side. That loads each one.
- Start a new session afterwards.

**C. Plugin marketplace.** The repository is also a marketplace with this one plugin:

```
/plugin marketplace add ewxgwy1987/claude-code-progress-board
/plugin install progress-board@claude-code-progress-board
```

To check that it loaded, start a new session and type `/progress-board`.

## Usage

### The command

| Command | What it does |
|---|---|
| `/progress-board` | Opens the pane and prints a text summary of the board in the transcript |
| `/progress-board clear` | Removes finished items. Running and pending items stay. Prints how many are left |
| `/progress-board wrap` | Toggles between one-line and multi-line descriptions |
| `/progress-board wrap on` / `wrap off` | Sets wrapping on or off |

The pane opens by itself, once per session, the first time a task, subagent, workflow or goal appears,
or when a saved board is restored. Tool calls alone do not open it. If you close the pane,
`/progress-board` opens it again.

### Columns

Each row has, from left to right:

| Column | Meaning |
|---|---|
| Time | `MM-DD HH:MM:SS`. The finish time of a finished item, otherwise its start time. For tasks it is the time of the last status change |
| Icon | `✓` done, `▶` running, `○` waiting, `✗` failed |
| Description | The item's name. This column takes about 60% of the free width, so it grows as you widen the pane |
| Bar | The progress bar |
| Percent | The same progress as a number |
| Note | Time left, elapsed time, tool counts and other detail |

Each section starts with a header row: the section name, `done/total`, an overall bar and a note.

### Colours

| Colour | Meaning |
|---|---|
| Green | Done |
| Cyan | Running, within its estimate |
| Yellow | Running longer than its estimate (the bar stops at 99%) |
| Dim / grey | Waiting: pending, blocked, paused between turns, or an idle agent |
| Red | Failed, killed or interrupted, or a goal that was declined |

A header bar is green when everything in its section is done, otherwise cyan.

### How the percentage works

Claude Code does not report progress, so the mod uses time. A running item's percentage is its elapsed
time divided by its estimate, capped at 95% until it really finishes. With no estimate yet, the bar
stays at 0% and the note says `no estimate yet`. A header's percentage is the average of its rows.

### The sections in detail

**Goal.** Appears when you run `/goal <condition>` or when Claude proposes a goal and you accept it.
The note shows who set it, how many turns it has run, and how far the task list is. `/goal clear`
(or `stop`, `off`, `cancel`) marks it cleared. A declined proposal shows in red.

**Tasks.** Filled from Claude's built-in task tools (`TodoWrite`, `TaskCreate`, `TaskUpdate`) and from
the tool this mod adds, `tasks` (full name `mcp__progress-board__tasks`). Claude sends the whole list,
in order, each time a status changes. A task shows its present-tense form (for example
"Writing the migration") while it is in progress. A task in progress is **paused** while Claude waits
for you between turns, and that waiting time does not count towards its duration. A task blocked by
another one says `blocked by #N`.

> **Tip:** Claude only sends a task list when it decides to. For multi-step work, ask for one:
> "post a task list to the progress board, then start".

**Subagents.** One row per subagent: `type · description`. While it runs, the note adds its tool call
count and its last tool. It ends as done, failed or killed.

**Workflows.** One row per run of the Workflow tool, `Workflow · <name>`, with a child row `↳` per agent
in the run. A child row shows the agent's task title and workflow phase when they can be found
(see [Workflow agent titles](#workflow-agent-titles)), otherwise `agent 1`, `agent 2` and so on.
Agents that finished long ago fold into a `… N earlier agents finished` line.

**Activity.** The tool calls Claude makes in the current turn, for example `Bash · Run the test suite`
or `Edit · migration.sql`. Calls made by subagents count towards the subagent's row instead. The last
50 calls are kept; older ones fold into a count. When the turn ends, the header reads
`last turn · N tool calls · took …`. A new turn starts a fresh list.

### Wrapping

Long descriptions are cut to one line by default. You can change this in three ways:

- the **Wrap descriptions** / **Single-line descriptions** button under the board (where the
  surface draws buttons);
- `/progress-board wrap`;
- the `wrapText` option below, which sets the default.

The button and the command change the current session only.

### Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `wrapText` | boolean | `false` | Show every description in full, on several lines |

Change it in `/config`. It is stored in `settings.json` under `pluginConfigs` for this plugin
(`progress-board`, or `progress-board@inline` when loaded with `--plugin-dir`).

### Terminal and desktop

- In the **terminal**, bars are text (`█` filled, `░` empty), 8 to 20 characters wide depending on the
  pane width.
- In the **desktop app**, bars are small fixed-size graphics (140 × 10 px) in the same colours,
  with the percentage drawn as text next to them.

## How it works

### Hooks and events

| Event | Used for |
|---|---|
| `session.start` | Registers the command and the `tasks` tool, loads estimates, restores the saved board, starts the timers |
| `session.end` | Saves the board one last time |
| `tool.call` | Task tools, the `tasks` tool, `Workflow`, `ProposeGoal`, and every other call for Activity and for agent tool counts |
| `agent.spawn` | Adds a subagent row, or a workflow child row when the type is `workflow-subagent` |
| `turn.start` / `turn.complete` | Starts and ends the Activity list, pauses and resumes tasks, ends subagents |
| `turn.step` | Notices workflow agents that have not made a tool call yet |
| `prompt.submit` | Reads background-task notifications to finish workflows and background agents |
| `ui.render` (`UserMessage`) | Same, from the task card drawn in the transcript |
| `classic.Stop` | Closes a workflow that is no longer in the list of background tasks |
| `command.run` | `/progress-board` and `/goal` |
| `ui.render` (`Pane`) | Draws the pane |

Two timers run: every 2 seconds the pane's clock ticks (only while something is running) and the list
of live agents is refreshed; every 3 seconds the board is saved. Neither timer calls a model.

### Where each section's data comes from

| Section | Source |
|---|---|
| Goal | `ProposeGoal` tool calls and the `/goal` command |
| Tasks | `TodoWrite`, `TaskCreate`, `TaskUpdate`, and the `tasks` tool |
| Subagents | `agent.spawn`, the live agent list, and the end of each agent's turn |
| Workflows | `Workflow` tool calls; agents from `agent.spawn` with type `workflow-subagent` (the terminal CLI raises these) or from tool calls and steps of agents that are not ordinary subagents, filed under the newest running workflow; the end from task notifications |
| Activity | `tool.call` on the main thread |

### Estimates

When an item finishes, its duration is saved. The estimate for a new item is the **median** of the
last 30 durations of its kind:

| Kind | Grouped by |
|---|---|
| Task | All tasks together (paused time left out) |
| Subagent | Agent type, falling back to all agents |
| Workflow | Workflow name, falling back to all workflows |
| Workflow agent | All workflow agents together |
| Tool call | Tool name |
| Turn | All turns that made at least one tool call and were not aborted |

The section headers add up the time left: tasks one after another (a sum), subagents and workflows in
parallel (the longest). Workflows closed by a guess and restored runs are not used as samples.

### Storage

The mod keeps its data in its own plugin store, a JSON file under your Claude Code configuration
directory, shared by all sessions.

| Key | Holds |
|---|---|
| `durations` | Past durations used for estimates |
| `board:<session id>` | The board of one session |
| `boards` | An index of saved boards. Only the 20 most recent sessions are kept; older boards are deleted |
| `alive` | A heartbeat per open window: which session it shows and when it was last seen |

The board is saved every 3 seconds when it has changed, and at session end. When you resume a session,
its board comes back. Runs that were still going when the session stopped are shown as
`interrupted` and in-progress tasks as paused, unless another window of the same session is still
open (seen in the last 10 seconds), in which case the board is taken as it is.

### Sync between windows

The desktop app and a terminal CLI can show the same session at once. Each one writes its board to the
same `board:<session id>` key. On each save, a window that finds a newer copy from the other window
merges it in item by item and writes the result back. When both copies have the same item, the more
finished copy wins (a completed task beats one in progress, a finished agent beats a running one),
then the more recent one.

### Workflow agent titles

To name a workflow agent, the mod looks in the run's folder, in this order:

1. the agent's metadata file, `agent-<id>.meta.json` (its description and workflow phase);
2. the run's `journal.jsonl` (the agent's label and phase);
3. only on the third attempt, if both failed: **one small Haiku call**, given the start of these
   files and the agent's transcript (at most 6,000 characters). The text is passed as untrusted data
   and the reply must be a small JSON object.

Each agent gets at most three attempts and at most one model call (per Claude Code process).
In the terminal CLI, the description given when the agent is spawned is used as the title directly.
Titles are cut to 60 characters.

## Tokens and privacy

**Tokens.**

- The mod calls a model (Haiku) for one thing only: naming a workflow agent when neither its metadata
  file nor the run's journal gives a title. That is at most one call per agent per Claude Code process.
  The call is capped at 120 output tokens and a 20-second time limit.
- The `tasks` tool's name, description and schema are part of the tool list Claude sees, like any
  tool. Its reply is one short line.
- Nothing else uses the model. Drawing the pane, timers, saving and syncing cost no tokens.

**What is sent and stored.**

- The Haiku call sends the start of that agent's transcript and run files (at most 6,000 characters).
  It goes through your normal Claude Code login, like any other request, and counts toward your usage.
- Board snapshots for the last 20 sessions, plus past durations for estimates, are kept in the plugin
  store on your machine (see [Storage](#storage)). The mod sends nothing anywhere else.

## Limitations and troubleshooting

| Symptom | Explanation |
|---|---|
| The Tasks or Subagents section is missing | Nothing of that kind exists yet. Tasks appear only when Claude sends a task list; ask for one |
| "Nothing running yet." | The board is empty. Items appear as soon as Claude works |
| `no estimate yet` and 0% | Nothing of that kind has finished yet. Estimates appear after the first one |
| A bar sits at 99% in yellow | The item is taking longer than usual. It is still running |
| Items come back after `/progress-board clear` | Known gap: with two windows on the same session, the other window still has the finished items and merges them back. Run `clear` in both windows, or close one first |
| A workflow agent shows as `agent N` | Its run folder had no usable title yet, and the model call (if made) gave none |
| Old runs show as `interrupted` | They were running when the session stopped and are no longer alive |
| Renaming a task makes it start over | Lists sent with `TodoWrite` or `tasks` match tasks by their text, so a new text is a new task |
| The pane did not open | It opens itself once per session. Run `/progress-board` |

Other notes:

- A list sent with `TodoWrite` or `tasks` replaces the whole task list.
- The wrap setting from the button or the command is not saved. Use the `wrapText` option for a
  lasting default.
- The plugin store is limited to 4 MiB in total; the mod keeps boards for 20 sessions to stay small.

## Development

The mod is plain TypeScript and TSX, loaded by Claude Code directly. Hot reload applies while a session
runs with the plugin loaded.

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json` | Manifest and the `wrapText` option |
| `hooks/hooks.json` | Lists the hooks module |
| `hooks/register.tsx` | Hooks, the command, the `tasks` tool, storage and the pane |
| `hooks/model.ts` | Pure logic: progress, estimates, merging, restoring |
| `hooks/titles.ts` | Workflow agent titles |
| `types/index.d.ts` | The mod's own types and its plugin state |
| `tests/` | Tests for the engine's test runner |

Commands, run from the repository root:

```sh
# check the manifest and hooks
claude plugin validate .

# run the tests
claude plugin test .

# type-check
npx -p typescript tsc -p . --noEmit
```

`tsconfig.json` extends `./.claude-plugin/types/tsconfig.json`. Claude Code writes that folder (its own
API declarations for the running build) into the plugin when it loads it, and it is git-ignored. Load the
plugin once before you type-check.

## See also

- [claude-code-usage-meter](https://github.com/ewxgwy1987/claude-code-usage-meter): a band above the
  prompt with plan rate limits, context fill, session cost and per-task tokens.
- [claude-code-session-toc](https://github.com/ewxgwy1987/claude-code-session-toc): a pane with a
  table of contents of the whole session, grouped into topics.
- [claude-code-mods](https://github.com/ewxgwy1987/claude-code-mods): the collection, to install all
  three at once.

## License

[MIT](LICENSE) © 2026 Rain Guo
