# Kapibala Storage Design

**English** · [简体中文](./storage.zh.md)

> The storage layer is the one part of this project that is extremely expensive to change: once the schema is set, users' data is already sitting there. A UI can be rewritten at any time; a storage layer cannot.
> This document is an implementation reference, not a concept sketch — every line here is meant to land in code and tests.

---

## 0. Goals

**Must hold**

1. **The source of truth is plain-text files in a folder the user picks.** After uninstalling the app the data is intact and readable, without needing Kapibala to parse it.
2. **Several Macs share one folder through iCloud / Dropbox / any sync service, without corruption, without conflict copies, and eventually consistent.** Two machines edit a batch each while offline; once synced, both compute exactly the same result.
3. **No hard-coded paths.** The vault is chosen by the user, there can be several, and they can be moved at any time.
4. **The GUI and the CLI share the same data and the same vault list**, and can run at the same time.
5. **Zero network requests.** Syncing is done entirely by the provider the user chose, at the file-system level.

**Explicitly out of scope**

- No sync service of our own, no end-to-end encryption protocol (disk encryption is FileVault's job).
- No real-time collaboration (no presence, no cursor sync). This is one person on several devices; converging within seconds is enough.
- No mobile app. Reaching iCloud files from inside the iOS sandbox is an order of magnitude more work.
- No general CRDT framework. Just field-level LWW, which is enough.

**Performance budget** (exceed it and optimization is required — "feels fast" is not a criterion)

| Scenario | Target |
| --- | --- |
| Cold start to interactive (5,000 tasks / 50,000 ops, with a snapshot) | < 300ms |
| Cold start with a full replay (no snapshot, 50,000 ops) | < 500ms, otherwise snapshots become mandatory |
| A single write (op on disk + UI updated) | < 16ms (must not wait for fsync) |
| Noticing a change from another machine | < 1s after the sync engine lands the file |

---

## 1. Three layers

Slice "where the data is" into three layers, because corruption means something completely different in each:

| Layer | Location | Contents | What breakage means |
| --- | --- | --- | --- |
| **Source of truth** | The vault folder the user picked (possibly on iCloud) | An append-only JSONL op log | Data loss. This layer must be extremely conservative |
| **Local cache** | `~/Library/Application Support/Kapibala/cache/<vaultId>/` | SQLite index, replay watermark | Delete it; it rebuilds from the log next time |
| **Vault registry** | `~/Library/Application Support/Kapibala/vaults.json` | Which vaults exist, where they are, this machine's device identity in each | Pick the folder again and it is restored |

**Iron rule: a folder shared across machines may only hold append-only logs where each machine writes its own.** Anything that is "a single file several machines have to modify" is out — including one big JSON, and especially SQLite.

### 1.1 Why SQLite must never go in the vault folder

This is the most common way projects like this fail. In WAL mode SQLite works on three files at once (the main database, `-wal`, `-shm`), and a sync engine will upload or replace any one of them at any moment. Three files at mismatched versions equals a corrupt database. Obsidian, Anki and DEVONthink have all warned about this explicitly.

So `better-sqlite3`'s role in this project is a **purely local, disposable query index**, always built under `Application Support`, always rebuildable from the JSONL. It is not a database; it is a cache.

---

## 2. The vault model

Borrowed from Obsidian. The app assumes no path at startup.

### 2.1 The registry: `vaults.json`

Location: `app.getPath('userData')/vaults.json`, i.e. `~/Library/Application Support/Kapibala/vaults.json`.

**It absolutely cannot live inside a vault folder** — a chicken-and-egg problem: before opening a vault, how would you know where the vault is?

```ts
type VaultsFile = {
  version: 1
  lastVaultId?: string
  vaults: VaultEntry[]
}

type VaultEntry = {
  id: string             // matches vaultId in the vault's meta.json; this is the real primary key
  path: string           // absolute, and may become invalid (drive unmounted / folder moved)
  name: string           // display name, defaults to the folder name, editable
  lastOpenedAt: number
  bookmark?: string      // reserved: security-scoped bookmark for a sandboxed Mac App Store build
  device: DeviceIdentity // this machine's identity inside this vault, see §4
}
```

Constraints:

- File mode `0600`. It contains the device's claim token (`claimToken`).
- **The GUI and the CLI both write it**, so writes must go through ".tmp in the same directory + `rename()`", plus a local lock (a lock on local disk is meaningful, see §4.3).
- `id` is the primary key, not `path`: after the user moves the folder we recognize it by `id` instead of treating it as a new vault.
- If `path` does not exist on open, do not delete the entry — mark it "temporarily unavailable" and let the user relocate it. An unmounted external drive and a signed-out iCloud both look like this.

### 2.2 The vault marker: `.kapibala/meta.json`

Written into the folder once chosen:

```ts
type VaultMeta = {
  appId: 'kapibala'     // for recognition, so another app's folder is not treated as a vault
  vaultId: string       // ULID, generated at creation, never changes
  schema: number        // storage format version, currently 1
  createdAt: number
  createdBy: string     // "kapibala/0.1.0", for diagnosis
}
```

`.kapibala/` holds **only machine-independent information**. Anything per-device lives in `devices/<id>/`.

### 2.3 What the first-run window decides

The startup window offers three ways in: **open a recent vault** / **open an existing vault** / **create a vault**. Once the user picks a folder:

| Folder state | Verdict | Action |
| --- | --- | --- |
| Has `.kapibala/meta.json`, `appId` matches, `schema <= supported` | Existing vault | Open it |
| Has `.kapibala/meta.json`, `schema > supported` | A newer format | **Open read-only** and prompt to upgrade the app. An old version must never write a newer vault |
| Has `.kapibala/meta.json`, `appId` does not match | Someone else's folder | Refuse, say this is not a Kapibala vault |
| Empty folder | Create | Write meta.json, create `devices/<new id>/` |
| Non-empty folder with no meta.json | Dangerous | Ask explicitly, "create a vault in this folder that already has files?", default no |
| Has meta.json and `vaultId` is already in `vaults.json` but at a different path | Vault moved or copied | Update the entry's path (moved), then run the ownership check in §4.2 (copied) |

That "schema > supported" row is the key defense against corruption: an old client writing a newer vault would compact and overwrite by rules it does not understand, and the result is fields silently disappearing.

---

## 3. Directory layout

```
<the folder the user picked>/
├── .kapibala/
│   └── meta.json                # the vault marker, see §2.2
└── devices/
    ├── 01HX7...A1B2/            # a device folder, named after the device ID (a ULID)
    │   ├── owner.json           # the claim token, see §4.2
    │   ├── snapshot.json        # this machine's own compaction result
    │   ├── 000001.jsonl         # append-only, rotated at about 2MB
    │   ├── 000002.jsonl
    │   └── 000003.jsonl         # the segment currently being written
    └── 01HX8...C3D4/            # another Mac; read-only here, never written
        ├── owner.json
        ├── snapshot.json
        └── 000001.jsonl
```

- Segment file names are zero-padded 6-digit counters, so lexical order equals time order.
- **Each machine writes only its own folder and never touches anyone else's files.** This is the foundation of the whole design: no file locks, no conflict-resolution UI, and structurally impossible to produce an iCloud conflict copy like `000001 2.jsonl`.
- A retired device folder (you replaced the machine) is **kept forever as read-only history**, never cleaned up. Cleanup saves kilobytes and risks losing data.

---

## 4. Device identity

### 4.1 A device ID is per-(device, vault)

Not global, and **never derived from hardware**. The first time a machine opens a given vault, a fresh random ULID is generated. One Mac opening two vaults means two unrelated device IDs.

```ts
type DeviceIdentity = {
  deviceId: string   // ULID, randomly generated
  claimToken: string // 32 random bytes, hex. The claim token, see §4.2
  machineId: string  // IOPlatformUUID, used to spot a whole-machine migration
  label: string      // "MacBook Pro", display only, never part of any decision
}
```

One copy lives in the vault at `devices/<id>/owner.json`, the other in the matching entry of the local `vaults.json`.

### 4.2 The vault folder gets copied wholesale: a trap that must be handled

Sharding assumes "one machine, one device folder". That assumption can collapse in three ways:

| Scenario | What it looks like | How it is detected |
| --- | --- | --- |
| The user copies the vault folder to another Mac | Machine B has no local record for this vaultId | Not found in `vaults.json` → a new device ID is generated naturally, safe |
| The user restores the same machine from Time Machine | Both the local record and owner.json are present and match | It really is the same machine, so it **should** keep using the original device folder — correct |
| **Migration Assistant moves the whole Mac to a new machine while the old one is still in use** | The two machines' local records are **identical**, token included | The token matches but `machineId` changed |

So the ownership check at startup has two conditions:

```ts
function claimDevice(vault: VaultEntry, dir: string): DeviceIdentity {
  const owner = readJsonOrNull(`${dir}/owner.json`)
  const mine =
    owner?.claimToken === vault.device.claimToken &&   // the token matches
    owner?.machineId === currentMachineId()            // and it is still the same physical machine
  if (mine) return vault.device
  // This device folder is not mine: silently take a new identity, the old folder becomes read-only history
  return forkNewDevice(vault)
}
```

A few dozen lines that shut out an entire class of corruption. The cost is that replacing a logic board changes IOPlatformUUID and forks a new device folder for nothing — the old history stays fully readable, which is acceptable.

### 4.3 Several processes on one machine

The GUI and the CLI both run and both want to write the same device folder. Across machines no lock is needed; **on one machine it is**:

- Create `~/Library/Application Support/Kapibala/locks/<vaultId>.lock` locally (not inside the vault) and contend for it. **A lock on local disk is reliable**; what is forbidden is locking inside an iCloud folder.
- A process that cannot get the lock has two options: the CLI retries briefly (up to 2s) then exits with an error, or it degrades to "forward the write through the running GUI". **The MVP takes the former** — simple and cannot be wrong.
- Do not count on `O_APPEND` atomicity as a fallback: appends under `PIPE_BUF` are usually atomic, but one JSON line can exceed 4KB (the notes field), and that is not a bet worth taking.

---

## 5. The op log

### 5.1 Op format

One JSON object per line, UTF-8, terminated by `\n`. One line equals one assignment to one field.

```ts
type Op = {
  v: 1               // line format version
  hlc: string        // "0001740000000000:0007:01HX7...A1B2"
  e: string          // entity type: "task" | "list" | ...
  id: string         // entity ID, a ULID
  f: string          // field name
  val: unknown       // field value, anything JSON can express
}
```

The single-letter keys save disk (over 20% at the 50,000-op scale), while values and field names stay human-readable — `grep '"f":"title"'` should work.

**There is only one operation: `set`.** No `insert`/`delete`/`increment`. Deletion is `{f: '_deleted', val: true}` (a tombstone). The reason: a single operation type means a single merge rule, so convergence can be tested exhaustively; and the cases that would need extra CRDT types — counters, ordered lists — do not exist in a to-do app (ordering uses fractional indexing, §7.3).

**Never really delete.** In a distributed setting a hard delete inevitably resurrects data: A deletes a task, B has not synced yet and edits its title, and after merging the title op brings the task back. Only a tombstone plus field-level LWW lets "deleted" compete on equal terms.

### 5.2 HLC (Hybrid Logical Clock)

```
hlc = <physical milliseconds, zero-padded to 16>:<counter, zero-padded to 4>:<device ID>
```

The padding is what makes **string order equal time order**, so sorting never needs parsing.

```ts
// producing a new op locally
function tick(): Hlc {
  const now = Date.now()
  if (now > last.physical) { last = { physical: now, counter: 0 } }
  else { last = { physical: last.physical, counter: last.counter + 1 } }
  return format(last, deviceId)
}

// reading someone else's op must advance the local clock
function observe(remote: Hlc) {
  const now = Date.now()
  const p = Math.max(now, last.physical, remote.physical)
  last = {
    physical: p,
    counter: p === last.physical && p === remote.physical ? Math.max(last.counter, remote.counter) + 1
           : p === last.physical ? last.counter + 1
           : p === remote.physical ? remote.counter + 1
           : 0,
  }
}
```

`observe` is a correctness requirement, not an optimization: if this machine's clock is ten minutes slow and we do not advance it, this machine's newest edits **can never beat** the other machine's older ones. Every op read during startup replay must be `observe`d.

Reading your own history also fixes clock rollback for free — your last op is right there in the log.

### 5.3 The merge rule: field-level LWW

For each `(e, id, f)`, take the value from the op with the largest HLC.

```ts
compare(a, b) = a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0   // plain string comparison
```

Because the last part of an HLC is the device ID and device IDs are globally unique, **there are no ties**, and every machine computes the same result. That is convergence.

Field-level rather than object-level matters: change the title on Mac A and the start date on Mac B, and both edits should survive instead of one overwriting the other.

A defensive addition: if two lines somehow carry the identical HLC with different values (a corrupted or duplicated log), the merge falls back to comparing the values' JSON. That makes the rule a total order, so any input in any order still converges.

### 5.4 Forward compatibility: anything unrecognized must survive untouched

App versions on several Macs will essentially never be upgraded in lockstep. Therefore:

- **Unknown field names are stored in state anyway.** An entity in memory is `Record<string, {val, hlc}>`; the business type is only one view of it.
- **Unknown entity types are replayed and kept as well.**
- Compaction (§6.3) must write unknown fields into the snapshot. **An old version dropping a new version's fields during compaction is the most insidious kind of data loss.**
- Line format `v` greater than supported → stop writing, go read-only, prompt to upgrade.

The matching schema evolution rules: **only add fields, never reuse an old field name, never change the meaning of an existing field.** A deprecated field simply sinks out of use.

---

## 6. Reading and writing

### 6.1 Reading (cold start)

```
1. List devices/*/
2. For each device folder:
   a. ensureDownloaded(every file in it)           ← §6.4
   b. Read snapshot.json (use it as the starting point if valid)
   c. Read every segment with index > snapshot.lastSegment
3. Sort all ops by hlc, apply LWW one by one, observe the clock on each
4. Write the result into the local index and record the watermark
```

Incremental startup: the watermark records the **byte offset** consumed in each `(deviceId, segment)`. The next start continues from there. Segments are append-only, so an offset stays valid forever.

**Fault tolerance** (the principle in this layer is "never refuse to start because of one bad line"):

- The last line may be incomplete (a crash mid-write, or a half-uploaded file). **Only the last line may be discarded**; an incomplete line in the middle means the file is genuinely damaged.
- A line that fails to parse or lacks required fields: skip it, count it, copy it verbatim into `Application Support/quarantine/` for diagnosis, and read on.
- An entire segment that cannot be read: skip the file, mark that device's history "incomplete", say so honestly in the UI, and **never silently treat it as empty**.

### 6.2 Writing

```
1. Take the local lock                             ← §4.3
2. Produce the op (tick for an hlc)
3. Append one line to the current segment
4. Update in-memory state and the UI right away (do not wait for fsync)
5. fsync every 500ms, and before exit
6. Segment over 2MB → start a new one
```

- The write latency the user can feel does not include fsync. Losing the last few hundred milliseconds of work is more acceptable than a 20ms stall on every click.
- Flush before quitting, on losing focus, and before the system sleeps.
- **Atomic writes are only for whole-file replacement** (`meta.json`, `owner.json`, `snapshot.json`, `vaults.json`): write `.tmp` in the same directory, then `rename()`. A cross-directory rename is not atomic. Segments are appended, so they neither need nor may use this pattern.

### 6.3 Compaction

Trade a stretch of your own history for the conclusion of that history: for each `(e, id, f)`, keep only the op with the largest HLC.

- Trigger: this device folder's segments total more than 4MB, or there are more than 8 of them.
- **Only your own folder may be compacted; other folders are never touched.**
- **Roll to a new segment first.** Close the current segment, open the next one immediately so all new writes go there, and only then compact the frozen ones. Otherwise the snapshot claims to cover segment 8 while segment 8 is still being appended to, and every op written after the snapshot is skipped by the read path — silent data loss.
- How: produce a new `snapshot.json` and replace it atomically (`.tmp` in the same directory + `rename`).
- If the snapshot's `schema` is newer than supported, do not compact; read the segments instead.

#### Segments are never deleted

Compaction **only produces a snapshot; it reclaims no segments**. Segments already covered by a snapshot stay on disk, they are simply no longer on the read path (the rule is `snapshot + segments with index > lastSegment`), so leaving them costs no replay time — what is saved is CPU, not disk.

The reason is that the trade is simply bad:

- An op is about 100 bytes; a heavy user writes roughly 50,000 ops a year, about **5MB/year**, 50MB in a decade. Frozen segments never change, so the sync engine uploads each one once and generates no recurring traffic.
- Doing reclamation correctly requires satisfying four conditions at once — "in my own folder", "covered by the snapshot", "the snapshot is currently readable and schema-compatible", "past the retention period" — plus keeping a retirement ledger of your own (**file mtime cannot be used**: a sync engine rewrites mtime when it downloads a file) and guarding against clock rollback.
- **It would be the only code path in the whole storage layer that actively deletes user data.** Everywhere else only appends or overwrites its own files, where a mistake means at worst a redundant copy; only here does a wrong judgment mean history is gone forever.

A few megabytes of disk in exchange for a whole class of the hardest bugs to trace: not doing it.

Two things come for free: keeping every segment means keeping the complete operation history, so the door to "task history / time machine" is open by default; and when debugging a merge problem the original ops are all there to replay.

If a vault ever really does reach hundreds of megabytes (probably after importing external data), reclamation can become an **explicit, user-visible action** ("Tidy up vault", stating what will happen), rather than something deleted quietly in the background.

#### Snapshot format

```ts
type Snapshot = {
  schema: 1
  deviceId: string      // hoisted to the top level, see below
  lastSegment: number   // the highest segment covered (inclusive)
  hlcMax: string        // the largest HLC covered, used to advance the clock on read
  state: {
    [entity: string]: {
      [id: string]: {
        [field: string]: { val: unknown, hlc: string }   // hlc holds only "time:counter"
      }
    }
  }
}
```

`deviceId` is hoisted to the top level and each `hlc` inside `state` keeps only `<time>:<counter>`. A snapshot contains only this machine's own ops, so the device segment is necessarily the same value — repeating 26 characters tens of thousands of times is pointless. Measured: a 13-field snapshot went from 2,129 bytes to 1,048, a 58% saving (the other half comes from not indenting — this file is read by machines).

**The cost is that the reader must restore the full HLC before comparing:**

```ts
const fullHlc = `${cell.hlc}:${snapshot.deviceId}`
```

Miss that step and the device ID — the final tiebreaker — is gone, two ops in the same millisecond with the same counter tie, and convergence collapses. So this concatenation **may appear exactly once, in the snapshot loader**, and must not be scattered around.

#### Three things that cannot be skipped

1. **Every field must carry its own HLC; a bare value is not enough.** A snapshot still has to merge with other devices, and merging compares HLCs. Bare values mean LWW stops working.
2. **A tombstone must keep every field.** A deleted entity keeps `title`, `repeat` and the rest in the snapshot. Drop the whole record and an older `title` op on another machine **resurrects it in place**, with no `_deleted` marker.
3. **Unknown fields and unknown entity types are kept verbatim.** The compactor knows exactly one rule — `(e, id, f) → largest HLC` — and consults no field allowlist. An old version dropping fields written by a newer one is the most insidious kind of data loss.

#### Why compacting your own folder cannot change the merge result

Field-level LWW is a per-field `max` over HLCs, and `max` is associative and commutative:

```
max(a₁…aₙ, b₁…bₘ)  ==  max( max(a₁…aₙ), max(b₁…bₘ) )
```

The left side is "throw both machines' ops together, sort, replay"; the right side is "A reduces its own to a conclusion first, then merges with B's ops". **They are identical.** Which is why compaction **needs no coordination with anyone**: no need to know how far others have synced, no need to know whether anyone has read your old segments.

It also explains why compacting someone else's folder is out — besides breaking the "each machine writes only its own" foundation, it buys nothing.

#### Set your expectations for the gain

An op and a field entry are about the same size (the HLC string alone is 48 characters), so **the gain comes entirely from repeated edits to the same field**. If every field was written once, compaction achieves almost nothing.

So be clear about what a snapshot is for:

| Scenario | What makes it fast |
| --- | --- |
| Everyday cold start on the same machine | **The local watermark** (remembering the `(device, segment, byte offset)` reached), nothing to do with snapshots |
| **A new Mac opening this vault for the first time** | No local cache, so a full replay is the only option → this is where a snapshot saves you |
| Rebuilding after deleting the local cache | Same as above |
| Bounding the vault's size on disk | Not a snapshot's job — segments are never deleted, see above |

### 6.4 Concrete traps in a synced folder

iCloud Drive is the example; other providers are absorbed behind the same `ensureDownloaded(path)` interface.

1. **A file may not be downloaded.** iCloud evicts files it considers cold and leaves a `.000001.jsonl.icloud` placeholder (note: the directory listing shows that dot-prefixed name, so the scanner has to map it back). Reads must detect this and trigger a download first. **Skipping a placeholder silently discards one device's entire history** — the most dangerous trap here. How to trigger: read the file once, or `brctl download <path>`; then poll for the real file. Do not wait long: a vault freshly synced to a second Mac can be all placeholders, and waiting 30s per file, serially, makes the UI look dead. Give up after a few seconds, show the interface with "history may be incomplete", and let the file watcher re-read once files land.
2. **Do not use file locks.** `flock` across machines on iCloud Drive is meaningless. The point of sharding is that you do not need it.
3. **Do not read the moment `fs.watch` fires.** Files can be mid-sync. Debounce 300ms, retry on failure (back off to 2s, at most 5 times). Watch only `devices/`, and ignore your own folder — your own state is already in memory.
4. **`meta.json` itself can be a placeholder.** Checking only for the real file makes an existing vault look like a new folder, and creating a vault then fails because `devices/` is already there. Treat a placeholder (and the `.kapibala/` folder itself) as evidence of an existing vault, and distinguish "still downloading" from "not a vault" when reporting the error — the two need very different messages.
5. **Suggest turning off iCloud's "Optimize Mac Storage"**, or mention it during first-run setup — it is the main source of placeholders.
6. Local caches and indexes always go in `~/Library/Application Support/Kapibala/cache/<vaultId>/`. Use `vaultId` rather than a path hash as the folder name, so the cache survives the user moving the vault.

---

## 7. Data model

### 7.1 Current scope

The README narrows the first usable version to: notes, a start time, multiple reminders, repeating tasks, complete/delete. So the MVP has exactly one entity type: `task`.

```ts
type Task = {
  id: string              // ULID
  title: string
  notes?: string          // Markdown source
  startAt?: number        // epoch ms
  isAllDay: boolean
  reminders: Reminder[]   // a task can have several reminders
  repeat?: RepeatRule     // see §7.2
  order: string           // fractional index, see §7.3
  completedAt?: number
  createdAt: number
  seriesId?: string       // the series a repeating instance belongs to
  _deleted?: true         // tombstone, i.e. in the trash
  _purgedAt?: number      // when the trash was emptied; a marker only, still no physical deletion
}

type Reminder = { id: string, offsetMin?: number, at?: number }
```

**Trimming this does not make it harder to add things back later.** One direct benefit of a field-level op log: adding `tags`, `priority`, `listId`, `dueAt` or `parentId` just means starting to write new field names, **with no data migration at all** — old data simply does not have those fields. So there is no need to build them now for a "maybe later".

The same goes for `list` / `tag` as their own entity types: they can be added at any time, in exactly the same format.

### 7.2 Repeating tasks must generate idempotently

This is the only genuinely distributed trap in the data model.

```ts
type RepeatRule = {
  rrule?: string                         // a subset of RFC 5545 RRULE, e.g. "FREQ=MONTHLY;BYDAY=2TU"
  freq?: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'   // the 0.0.x shape; read, never written
  interval?: number
  mode?: 'fixed' | 'afterCompletion'     // a fixed schedule, or N days after completion
  tz?: string                            // "Asia/Shanghai". A recurrence rule without a time zone is wrong
}
```

The supported RRULE subset: `FREQ` (DAILY/WEEKLY/MONTHLY/YEARLY), `INTERVAL`, `BYDAY`
(with an optional ordinal — `2TU` is the second Tuesday, `-1FR` the last Friday),
`BYMONTHDAY` (`-1` means the last day), `BYMONTH`, `UNTIL`. **`COUNT` is not supported** —
it requires remembering how many instances were generated, which conflicts with a model that
only creates the next instance on completion. Unsupported parts are ignored during parsing
rather than guessed at, because guessing produces wrong dates.

The `freq` / `interval` pair is the shape 0.0.x wrote; it is converted to an RRULE on read and
never written again. This is that "only add fields, never change meanings" rule in practice:
not a single line of existing user data needs migrating.

The problem: completing a repeating task creates the next instance. If two Macs each complete the same occurrence, **two** next instances appear.

The fix: **derive the instance ID deterministically instead of using a random ULID.**

```ts
nextId = derive(`${seriesId}|${occurrenceDate}`)
```

Both machines compute the same ID, their ops land on the same entity, and field-level LWW merges them into one task. Generation becomes idempotent and needs no coordination whatsoever.

In `afterCompletion` mode the occurrence key is derived from the completion time, and two machines can be seconds apart → different IDs → two instances again. So in that mode the completion time is **rounded to the day** (in the local date for `tz`) before deriving. Completing several times within one day cannot fork.

### 7.3 Ordering uses a fractional index, not an integer

For manual drag-and-drop ordering, an integer `order` means renumbering a stretch of tasks on every insert → dozens of ops per drag, and two machines dragging at once produce an interleaved mess.

Use a string fractional index instead (LexoRank / fractional indexing): inserting between `"a1"` and `"a2"` gives `"a1V"`. One drag equals one op, and concurrent inserts cannot damage each other (worst case two tasks share an order, and `id` is a stable tiebreaker).

### 7.4 Time and time zones

- All timestamps are epoch ms (UTC), never local time strings.
- A task with `isAllDay` means "a particular local date" and is rendered in **the current device's time zone**. This is deliberate: when you travel across time zones, "today" should follow you.
- A repeating task's `tz` must be stored explicitly, because "every Monday at 9:00" is a rule bound to a time zone.

---

## 8. The local index

- `~/Library/Application Support/Kapibala/cache/<vaultId>/index.sqlite`
- Contents: the materialized task table, the indexes the views need (by `startAt`, by `completedAt`), and the replay watermark.
- **Deletable at any time.** Delete it and a full replay rebuilds it. The correct response to any problem in this layer is "delete and rebuild", never "repair".
- It is what makes a sub-300ms cold start and queries like "next 7 days" possible without a full scan.
- It can wait for after the MVP: 5,000 tasks in memory is a non-issue. **Get the log layer right first; add the index when the performance budget is genuinely exceeded.**

---

## 9. Order of work and verification

### 9.1 Order

```
the core package (op log + HLC + merging + vault management)
  → verify with the CLI (no UI; do CRUD from the command line and sync two Macs)
  → the UI
```

**Get every spike below passing before touching the UI.**

### 9.2 Mandatory spikes (half a day each)

1. **iCloud placeholders** — `brctl evict` a segment by hand and verify the read path detects it and triggers a download instead of treating it as an empty file.
2. **Two Macs writing concurrently** — go offline, make 10 edits each, reconnect at the same time, and verify both sides agree and no conflict copies appear.
3. **HLC convergence** — a property test: generate op sequences at random, replay them in any order, and the result must be identical. This test stays in CI forever.
4. **The vault folder copied wholesale / a whole-machine migration** — copy it to another Mac and open it; verify the ownership check fires, a new device ID is taken, and the old history is not polluted.
5. **Replay performance** — build 5,000 tasks and 50,000 ops and measure the cold replay. Over 500ms means snapshots become mandatory.
6. **Clock rollback** — set the system clock back ten minutes, write, and verify the new edit still beats the old one (i.e. `observe` is correct).
7. **Repeat idempotence** — two machines each complete the same occurrence offline; verify the merge leaves exactly one next instance.
8. **A crash mid-write** — `kill -9` during a write and verify the next start loses only the last line and does not refuse to start.

### 9.3 Tests that stay in CI

- The HLC convergence property test (random op sequences × random shuffles × assert identical state).
- Multi-device simulation: build N `devices/` folders in a temp directory, simulate interleaved writes, assert convergence.
- Forward compatibility: run a log containing unknown fields and unknown entity types through read → compact → read, and assert nothing unknown was lost.
- Compaction equivalence: `merge(all of A, B)` must equal `merge(snapshot(A), B)`, verified repeatedly with random A and B. This one also covers whether the HLC restoration was missed anywhere.

---

## 10. One-page summary

| Decision | Conclusion |
| --- | --- |
| Source of truth | An append-only JSONL log in the user's folder |
| Sharding | One folder per device; write only your own |
| Merging | HLC + field-level LWW, device ID as the tiebreaker |
| Deletion | Tombstones; never a physical delete |
| Vault list | `~/Library/Application Support/Kapibala/vaults.json`, never inside a vault |
| Vault marker | `.kapibala/meta.json` inside the vault |
| Device identity | A random ULID per (device, vault) plus a claimToken and machineId double check |
| Locks | None across machines; a **local** lock for several processes on one machine |
| SQLite | Only under `Application Support`, a disposable index |
| Atomic writes | `.tmp` in the same directory + `rename`, only for whole-file replacement |
| Snapshot | `deviceId` hoisted to the top level, field `hlc` holds only `time:counter`, restored on read |
| Segment reclamation | Not done. Compaction only writes a snapshot; segments are kept forever |
| Unknown fields | Kept verbatim, including through compaction |
| Schema evolution | Only add fields; never reuse a name, never change a meaning |
| A newer vault meeting an older client | Open read-only and prompt to upgrade |
