# Kapibala Architecture

**English** · [简体中文](./architecture.zh.md)

This document records the technology choices and the shape of the codebase. The storage design lives in [`storage.md`](./storage.md) and is not repeated here; this is only about how the code is organized.

---

## 1. Choices at a glance

| | Choice | One-line reason |
| --- | --- | --- |
| Language | TypeScript, strict everywhere | |
| Shell | Electron | core has to be reused by a plain Node CLI, which rules out Tauri (§2) |
| UI | React + TypeScript | |
| State | Zustand | the renderer is only a projection; RTK's machinery is not needed (§6) |
| Source of truth | JSONL in a folder the user picks | see storage.md |
| Local index | not in the MVP | the condition for adding it is in §3 |
| CLI | shares the core package with the GUI | core is pure logic with injected I/O (§4) |
| Process boundary | storage lives only in the main process | a security *and* a correctness boundary (§5) |

---

## 2. Why Electron

The deciding factor is the **CLI**: `kapi` and the GUI share one core package. And core is where the hardest, most test-hungry parts of the project live: HLC, field-level LWW, compaction, iCloud placeholder handling. Which means:

- **Electron**: core is a plain TS package. The GUI's main process `import`s it; so does the CLI. One body of code, one test suite, two hosts.
- **Tauri**: Tauri has no Node runtime; file access happens on the Rust side. Either core is written in Rust (then the CLI must be Rust too, and TS is left drawing the UI), or it runs in the webview through Tauri's fs plugin (no Node fs semantics, and every I/O call goes through IPC). **Either way, "the GUI and the CLI share one core" stops being true.**

**Sharing core is what rules Tauri out.** Conversely: the day we are willing to give up a TS CLI, Tauri comes back into play.

### The costs (worth naming)

| Cost | Magnitude | Acceptable? |
| --- | --- | --- |
| Installer size | 100–150MB dmg | Yes. Personal tool, not mobile |
| Idle memory | 200–300MB | Yes, but it needs to sit in the tray, so don't spawn windows carelessly |
| Native modules must be compiled for Electron separately | see §3 | **This is the direct reason SQLite got cut** |
| Signing and notarization | Apple Developer, $99/year | Must pay. Otherwise Gatekeeper blocks it and users have to right-click to open |
| Startup time | ~1s cold | Yes, but keep a full replay off the startup path (that's what snapshots are for) |

### Options that were ruled out

- **Swift + SwiftUI**: the best native feel, but the whole TS ecosystem and the shared core are written off, and the storage layer gets rewritten. Only worth it if we drop the CLI.
- **CLI + TUI only**: that is exactly what the spike phase does (see §9), but the final product needs notifications and a tray icon.
- **PWA / browser**: cannot read and write an arbitrary folder the user picks, which contradicts the entire premise.

---

## 3. Local index: not in the MVP

A local index (`better-sqlite3`) is not being introduced yet. It is a native module (compiled C++), which brings one concrete headache:

**The same native module needs two builds.** Electron uses its own Node ABI; the CLI uses the system Node ABI. So `better-sqlite3` needs `electron-rebuild` for the GUI and `npm rebuild` for the CLI; every Electron upgrade means recompiling, CI needs the Xcode command line tools, and signing has to handle the `.node` file separately during notarization.

And what it would solve is **a performance bottleneck that does not exist yet**.

Do the arithmetic: 5,000 tasks fully materialized in memory, 20 fields each, is 100,000 `{val, hlc}` objects — tens of megabytes at most. For the queries in storage.md's performance budget, like "next 7 days", `filter` + `sort` over an in-memory array takes microseconds.

**So the order is: get the log layer right, and add an index when the performance budget is actually exceeded.** Adding it later needs no storage format change either — SQLite is only a disposable projection; delete it and it rebuilds.

Leaving it out buys two more things:

- **No native modules anywhere in the dependency tree.** Packaging, signing and CI all get one notch simpler.
- core stays pure TS, so the same test suite runs under Node, Electron, even a browser.

Leave an explicit condition for bringing it back: **a full cold replay over 500ms, or more than 20,000 tasks.**

---

## 4. core must take its I/O by injection

core is reused by both the GUI main process and the CLI, and it has to survive being hammered by automated tests, so it cannot `import fs` directly.

```ts
// packages/core/src/ports.ts
export interface FsPort {
  readFile(path: string): Promise<Uint8Array | null>
  appendFile(path: string, data: Uint8Array): Promise<void>
  writeAtomic(path: string, data: Uint8Array): Promise<void>   // .tmp in the same dir + rename
  readDir(path: string): Promise<DirEntry[]>
  mkdirp(path: string): Promise<void>
  size(path: string): Promise<number>
  ensureDownloaded(path: string): Promise<void>                // iCloud placeholders, see storage.md §6.4
}

export interface ClockPort { now(): number }                    // testing clock skew needs a fake
export interface RandomPort { bytes(n: number): Uint8Array }
```

Three adapters:

| Adapter | Purpose |
| --- | --- |
| `NodeFs` | The real file system plus `brctl` placeholder handling. Used by both the GUI main process and the CLI |
| `MemFs` | All in memory. For unit and property tests — thousands of cases without touching a disk |
| Fault injection (`MemFs.failOn`) | Throws / truncates / returns placeholders on demand. For crash recovery and bad-data tolerance |

This is not architecture for its own sake. The checks listed in storage.md §9 — HLC convergence, compaction equivalence, "a crash loses only the last line", clock skew — **cannot be automated without `MemFs` and a fakeable clock**. They would need two real Macs and manual steps, which means they would not actually keep running.

The flip side: having `ensureDownloaded` as a port method is what confines "Dropbox and other services evict files differently" to a single adapter.

---

## 5. Process boundary: storage lives only in the main process

This is a security boundary and a correctness boundary at the same time.

```
┌─────────────────────────────────────────┐
│ Renderer (React)                        │
│ - contextIsolation: true                │
│ - nodeIntegration: false                │
│ - sandbox: true                         │
│ - zero fs access. Knows only window.kapi.* │
└──────────────┬──────────────────────────┘
               │ IPC (typed, see below)
┌──────────────▼──────────────────────────┐
│ Main process                             │
│ - owns core + NodeFs                     │
│ - holds the local lock (storage.md §4.3) │
│ - tray, notifications, menus, autostart  │
└─────────────────────────────────────────┘
```

Two reasons:

1. **Correctness**: a vault may have exactly one writer at a time. Concentrating writes in the main process, together with a local lock, satisfies that for free. If the renderer could write too, there would be one more writer to coordinate.
2. **Security**: the renderer runs React and never loads remote content, but `nodeIntegration: false` is a zero-cost default line of defense. The user's tasks and read/write access to the whole disk have no business being exposed at the DOM layer.

Keep the IPC surface small and typed:

```ts
// packages/ipc/src/index.ts — one definition shared by main and renderer
export type Commands = {
  'vault:state':   () => VaultState
  'vault:pick':    () => VaultState | null
  'vault:list':    () => VaultSummary[]
  'vault:open':    (id: string) => VaultState
  'task:list':     () => Task[]
  'task:create':   (draft: TaskDraftIpc) => string
  'task:setField': (id: string, field: string, val: unknown) => void
  'task:complete': (id: string) => void
  'task:trash':    (id: string) => void
}
export type Events = {
  'tasks:changed': (tasks: Task[]) => void   // pushed by main, includes changes synced from another Mac
  'task:show':     (id: string) => void      // "Notes" was picked in the context menu
}
```

`task:setField` maps directly onto one op in the storage layer. **Do not invent an IPC command per field** — fields keep getting added, and the IPC surface should not grow with them.

---

## 6. State management: Zustand, and keep it thin

The question that settles it is **where the truth lives**: in core, in the main process. The renderer receives a projection plus incremental patches.

So the renderer's store needs three things: the materialized task table, the current view's filter, and local UI state. No async thunk orchestration, no optimistic-update rollback (writes go straight over IPC and main pushes a patch back), no need for middleware.

Redux Toolkit's `createEntityAdapter`, `createAsyncThunk` and devtools time travel are pure overhead at this size, so the choice is **Zustand**.

One concrete rule: **the store holds materialized business objects, never ops.** An op is a storage-layer concept and must not leak into the UI. The renderer never sees an HLC.

About optimistic updates: clicking "complete" changes local state and fires the IPC; main writes the op and pushes a patch back. Because a field-level LWW write cannot fail (an append-only log has no constraint conflicts), **there is no rollback logic** — a free benefit of choosing LWW.

---

## 7. Repository layout and dependencies

### Layout

```
kapibala/
├── packages/
│   ├── core/            # Pure TS. op log, HLC, LWW, compaction, vault management. No electron, no direct fs
│   ├── adapters-node/   # NodeFs + brctl placeholder handling
│   └── ipc/             # The IPC contract types shared by main and renderer
├── apps/
│   ├── desktop/         # Electron main process + renderer
│   └── cli/             # kapi, plain Node, bin entry
├── docs/
│   ├── storage.md       ├── storage.zh.md
│   └── architecture.md  └── architecture.zh.md
├── README.md
└── README.zh.md
```

Dependencies flow one way, pinned down with ESLint's `no-restricted-imports`:

```
core  ←  adapters-node  ←  cli
  ↑
  └──  desktop(main)  →  ipc  ←  desktop(renderer)
```

**`core` may not import electron and may not import `node:fs`.** The moment that rule breaks, the MemFs tests are worthless.

### Toolchain

| | Choice | Notes |
| --- | --- | --- |
| Package manager | pnpm (`corepack enable pnpm`) | Good workspace support |
| Language | TypeScript `strict: true` | Plus `noUncheckedIndexedAccess`. The storage layer is all index access |
| Modules | ESM throughout | Electron's main process supports ESM; the CLI is ESM with a shebang |
| Desktop build | esbuild (three bundles: main / preload / renderer) | electron-vite is not needed at this size |
| Packaging | electron-builder | dmg + signing + notarization in one chain |
| Tests | vitest | Same lineage as vite, minimal config |
| Property tests | **fast-check** | See §8. Not optional |

### Runtime dependencies (deliberately almost none)

There are **zero runtime dependencies**. ULID generation, deterministic v5-style IDs, and the Markdown renderer for notes are all a few dozen lines each in core, so no package is pulled in for them.

Two things that would justify a dependency later:

| Package | What for |
| --- | --- |
| `rrule` | Full RFC 5545 parsing and expansion, once repeats go beyond daily/weekly/monthly. Do not hand-roll RRULE |
| `luxon` | Time zone math (what "every Monday 9:00" means in `Asia/Shanghai`) |

**No native modules, no ORM, no date-library suite.** Validation of op lines is a hand-written narrow check rather than zod — on a hot path of 50,000 lines, a schema library's overhead is measurable.

---

## 8. Testing strategy

Three layers; the second one is the important one.

**① Unit tests** (vitest + MemFs): HLC `tick`/`observe`, LWW comparison, segment rotation, skipping bad lines.

**② Property tests** (fast-check) — this layer is the storage layer's lifeline:

```ts
// Generate multi-device op sequences at random, replay in any order; the result must be identical
test.prop([arbOpLog()])('LWW converges', (ops) => {
  expect(replay(shuffle(ops))).toEqual(replay(shuffle(ops)))
})

// Merging is identical before and after compaction (the algebraic guarantee in storage.md §6.3)
test.prop([arbOpLog(), arbOpLog()])('compaction equivalence', (a, b) => {
  expect(merge(replay(a), replay(b))).toEqual(merge(snapshotOf(a), replay(b)))
})
```

Why these must be property tests and not example tests: bugs in distributed merging almost always hide in one particular interleaving, and hand-written examples never think of that one. Both tests belong **in CI from day one**, not added after something breaks.

**③ Acceptance on real machines**: the spikes in storage.md §9.2, two Macs and real iCloud. This layer cannot be automated, but it only needs rerunning when the storage format changes.

---

## 9. Order of work

**Storage layer → verify with the CLI → the UI.** The storage layer is the only part that is extremely expensive to change later.

| Stage | Output | Done when |
| --- | --- | --- |
| **M0 skeleton** | pnpm workspace, empty core package, vitest running | `pnpm test` is green |
| **M1 op log** | HLC, LWW, segment read/write, MemFs adapter | The two property tests in §8 pass |
| **M2 vaults** | vaults.json, meta.json, device identity and claimToken check | A copied vault folder forks correctly |
| **M3 CLI** | `kapi add/today/done/rm/ls` | **Two Macs sync through the CLI; spikes 1–8 all pass** |
| **M4 compaction** | Writing and reading snapshots | Compaction equivalence passes; 50k ops cold start under 300ms |
| **M5 UI** | Electron + renderer, the five views | Good enough to replace the CLI day to day |
| **M6 packaging** | dmg, signing, notarization, tray, autostart, notifications | Installs and runs on another Mac |

**M3 is the gate**: get two Macs actually syncing through the CLI, with all spikes passing, before touching the UI. A UI can be rewritten any time; the storage layer cannot.

---

## 10. Known traps and trade-offs

**Reminders only fire while the app is running.** Electron's notifications depend on a live process. So a resident tray icon and launch-at-login are required, and the settings should say so plainly. "Remind me even when the app is closed" needs a launchd agent or a native helper; not in the MVP.

**Signing and notarization cost money.** Apple Developer, $99/year. An unsigned dmg gets blocked by Gatekeeper on someone else's machine and they have to right-click to open it — fine for yourself, not fine for sharing.

**Two architectures, one dmg each.** arm64 and x64 builds are produced separately; the file name carries the arch, since x64 has no suffix by default and becomes unidentifiable.

**fs in the main process is async, but op appends must stay ordered.** Concurrent `appendFile` calls interleave. core keeps a serial write queue internally rather than trusting callers to behave.

**Things we are not doing** (written down to prevent scope drift): a sync service of our own, an end-to-end encryption protocol, mobile apps, real-time collaboration, a plugin system, a theme marketplace.

---

## 11. One-page summary

| Decision | Conclusion |
| --- | --- |
| Shell | Electron (because core is reused by a plain Node CLI, which rules out Tauri) |
| UI | React + TypeScript strict |
| State | Zustand, a thin projection; no ops and no HLCs in the store |
| Local index | **Not in the MVP.** Add SQLite when cold start exceeds 500ms or tasks exceed 20,000 |
| Native modules | Zero |
| core | Pure TS with injected I/O (FsPort / ClockPort / RandomPort) |
| Process boundary | Storage only in main; the renderer has zero fs access |
| IPC | A shared type contract; `task:setField` is one command mapping to one op |
| Package manager | pnpm workspace, ESM throughout |
| Tests | vitest + **fast-check property tests**, in CI from day one |
| Order | Storage → CLI (the M3 gate) → UI |
| Distribution | arm64 and x64 dmg, ad-hoc signed for now |
