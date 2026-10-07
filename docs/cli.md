# The Kapibala command line (`kapi`)

**English** · [简体中文](./cli.zh.md)

`kapi` is the desktop app's command-line twin: same core package, same vault, same vault list, and both can run at the same time (§6). This document is about using it. Why it exists at all (the M3 gate, and why it ruled Tauri out) is in [`architecture.md` §9](./architecture.md#9-order-of-work); the on-disk details of locks and the vault list are in [`storage.md`](./storage.md) §2.1 and §4.3.

---

## 1. Installing

```bash
make deploy      # install deps → environment check → typecheck + tests → drop kapi into ~/.local/bin
kapi --help
```

`kapi` is a wrapper (`~/.local/bin/kapi`) that points back at the repo source, so edits take effect immediately — there is no build step. You can also run it without installing:

```bash
make run ARGS="add 买菜 --at today"      # same as node apps/cli/src/index.ts …
node apps/cli/src/index.ts today
```

Requires Node 22.18+ (it runs `.ts` directly). The wrapper hardcodes the absolute path of the `node` that was current when it was generated: re-run `make deploy` after switching Node versions, or use `KAPI_NODE=/path/to/node kapi …` for one command. `make unlink` removes just that wrapper.

Environment variables (you never need these in normal use — they exist for tests and spikes):

| Variable | Effect |
| --- | --- |
| `KAPIBALA_USER_DATA` | Overrides the local state folder (vault list, locks, logs). This is how you simulate two Macs on one machine |
| `KAPIBALA_MACHINE_ID` | Overrides the machine fingerprint — the signal that detects a copied vault folder or a migrated machine |
| `KAPIBALA_LABEL` | Display name for this device; defaults to the hostname and shows up in `doctor` |
| `NO_COLOR` | Turns colour off |

## 2. Vaults

| Command | What it does |
| --- | --- |
| `kapi vault create <dir>` | Creates a vault in an **empty** folder and makes it current |
| `kapi vault open <dir>` | Opens an existing vault and makes it current |
| `kapi vault list` | Lists every vault; `●` marks the current one |
| `kapi vault use <name\|path\|id-suffix>` | Switches the current vault |
| `kapi vault forget <name\|path\|id-suffix>` | Removes it from the list (**does not delete the folder**) |

The vault list lives in the local state folder — `~/Library/Application Support/Kapibala/vaults.json` on macOS, `%APPDATA%\Kapibala\vaults.json` on Windows. **It is never inside a vault**: vault folders get synced to other machines, and a vault list travelling along makes no sense ([`storage.md` §2.1](./storage.md#21-the-registry-vaultsjson)). The desktop app and the CLI read the same file, so a vault created in either one shows up in the other. `forget` only drops it from the list; delete the folder yourself if that is what you want.

Every task command (§3) acts on the **current** vault — there is no per-command `--vault`. Opening a vault can print one of two notices:

- The device folder does not belong to this machine (the vault was copied, or the machine was migrated) → `kapi` continues under a fresh device identity and says so ([`storage.md` §4.2](./storage.md#42-the-vault-folder-gets-copied-wholesale-a-trap-that-must-be-handled)).
- The vault format is newer than this CLI → it opens read-only and every write fails with an error.

## 3. Tasks

| Command | What it does |
| --- | --- |
| `kapi add <title> [--at <when>] [--repeat …] [--after]` | Creates a task; the title is every remaining argument joined with spaces |
| `kapi today` | Today plus overdue (unfinished only) |
| `kapi ls [--all]` | The last 7 days; `--all` is every unfinished task |
| `kapi done <id>` | Completes it (a repeating task spawns its next occurrence, whose id is printed) |
| `kapi undone <id>` | Un-completes it |
| `kapi rm <id>` | Moves it to the trash |
| `kapi trash` | Shows the trash |
| `kapi restore <id>` | Restores it from the trash |
| `kapi purge <id>` / `kapi purge --all` | Deletes for good / empties the trash |
| `kapi search <terms>` | Searches titles and notes |
| `kapi doctor` | Vault and sync status |

A few conventions:

- **Any suffix of an id works.** Listings show the last 6 characters of the ULID; commands accept a suffix of any length, and if it is ambiguous they tell you how many tasks matched so you can give more characters. The 6 characters shown are exactly what you can paste back. `vault use` / `vault forget` match on the vault id suffix (uppercase).
- **`today` and `ls` only list unfinished tasks.** Finished ones are not there — there is no proper "show completed" command yet; the debugging-only `done-list` is not in `--help`.
- **`ls` means "the last 7 days", overdue included.** The overdue group is always pinned to the top (in red), then days in ascending order, then "unscheduled".
- **A task created without `--at` is unscheduled** and only appears in `ls --all`.
- **Deleting has two levels.** `rm` moves to the trash (`restore` brings it back); after `purge` it never shows up again — but the storage layer never physically deletes anything, so the log keeps a trace ([`storage.md` §5.1](./storage.md#51-op-format)).
- **`search` splits on spaces and requires all terms to match** (AND) across title and notes — it does not guess. Title matches rank above note matches.
- **`doctor`** prints the vault path, device identity (and how many devices exist), task counts, and log health: bad lines, a dropped unfinished tail line, or files that could not be read (an iCloud placeholder that has not downloaded yet reports as this).

## 4. What `--at` accepts

| Form | Examples | Result |
| --- | --- | --- |
| Today / tomorrow | `today`, `今天`, `tomorrow`, `明天` | 00:00 that day (all-day) |
| Relative | `+3d`, `+2w` | N days / N weeks from today (all-day) |
| Weekday | `fri`, `周五`, `FRI` | **The nearest one** (all-day); if today is that weekday, next week's |
| Date | `2026-08-28` | 00:00 that day (all-day) |
| Date + time | `2026-08-28T19:30`, `2026-08-28 19:30` | That instant |
| Time only | `19:30`, `7:30` | That time today |

Worth knowing:

- Month and day need **two digits**: `2026-08-28` works, `2026-8-28` reports "看不懂的时间".
- These are the only forms. The natural-language parsing the GUI has (`下周三`, `3天后`, `每周五`) is not wired into `--at`; anything else is an error — say it in the GUI instead.
- The weekday rule matches the GUI exactly (core's `when.ts`): **the nearest occurrence**, and if today is that weekday then next week's. So on a Wednesday, `fri` means **this** Friday.
- Times are local time.

## 5. `--repeat`

Three words — `daily`, `weekly`, `monthly` — plus `--after` to switch modes:

| | Default (fixed) | `--after` (afterCompletion) |
| --- | --- | --- |
| Next occurrence computed from | **That occurrence's own date** + one period | **The moment you completed it** + one period |
| Completed late | Does not drift; keeps the original rhythm | Shifts accordingly |

The next occurrence's id is derived from *this* occurrence (series + previous id), so two Macs each completing the same one compute the same id and merge into a single task instead of two. Once `UNTIL` is reached, or the series ends, `done` stops spawning ([`packages/core/src/repeat.ts`](../packages/core/src/repeat.ts) documents the derivation in full).

The CLI only exposes those three presets. Intervals greater than 1 ("every two weeks"), weekdays-only, nth-weekday-of-month and the rest of core's rrule support have to be set in the GUI — the CLI reads them fine afterwards.

## 6. Running alongside the desktop app

Both can run at once; they share the same log. On one machine two processes want to write the same device folder, so a **local** lock serialises them (the lock file lives in the state folder, not the vault — a lock inside the vault would sync to other machines via iCloud and mean nothing there):

- Failing to get the lock retries for up to 2 seconds, then fails with "另一个 Kapibala 进程正在写这个库，稍后再试" and exit code 1.
- A lock left behind by a crashed process is detected and cleaned up, so nothing hangs forever.
- **No lock is needed across machines**: each machine only writes `devices/<its own id>/` ([`storage.md` §4.3](./storage.md#43-several-processes-on-one-machine)).

The CLI rescans the vault on every start, so changes another machine just synced over are visible on the next command.

## 7. Output and exit codes

- Errors go to stderr with exit code 1 (task not found, unparseable time, read-only vault, lock contention, …).
- **An unknown command also exits 1** (`kapi nope`, `kapi vault nope`): the help text is printed anyway so you can see what to type instead, but the exit code is non-zero — `kapi typo && …` does not look like success in a script. Exit code 0 is reserved for "the command was fine, you just asked for help": `--help`, `help`, no arguments at all, or a bare `kapi vault`.
- Colour is enabled only on a tty; pipes, redirection and `NO_COLOR` get plain text, safe to feed into other commands.
- List order: overdue (pinned to the top) → days ascending → unscheduled.

## 8. Not there yet

- **Editing tasks**: you can create and complete, but changing a title, notes or date means using the GUI (it writes the same log, so the CLI sees it on the next command).
- **Viewing completed tasks**: no proper command, only the unlisted `done-list`.
- **The GUI's natural-language parsing** (`--at` accepts only what §4 lists).
- **The full repeat vocabulary** (end of §5).
- **Stats or export**: none.
