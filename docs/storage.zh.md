# Kapibala 存储设计

[English](./storage.md) · **简体中文**

> 存储层是这个项目唯一改起来代价极高的部分：schema 定了，用户数据就在那了。界面随时能重写，存储层不能。
> 本文是实现依据，不是概念草稿——每一条都要能落到代码和测试上。

---

## 0. 设计目标

**必须做到**

1. **真相来源是用户自选目录里的纯文本文件。** 卸载应用后数据完好可读，不依赖 Kapibala 才能解析。
2. **多台 Mac 通过 iCloud / Dropbox / 坚果云共享同一个目录，不损坏、不产生冲突副本、最终一致。** 两台机器离线各改一批，恢复同步后双方算出完全相同的结果。
3. **不硬编码任何路径。** 库（vault）由用户选择，可以有多个，可以随时移动。
4. **GUI 与 CLI 共用同一份数据和同一份库列表**，可以同时运行。
5. **零网络请求。** 同步完全由用户选的服务商在文件系统层面完成。

**明确不做**

- 不做自建同步服务、不做端到端加密协议（磁盘加密交给 FileVault）。
- 不做实时协作（没有 presence、没有光标同步）。这是单人多设备场景，秒级收敛就够。
- 不做移动端。iOS 沙箱下的 iCloud 文件访问是另一个量级的工程量。
- 不做通用 CRDT 框架。只做够用的字段级 LWW。

**性能预算**（超了就得上优化，不是"感觉快就行"）

| 场景 | 目标 |
| --- | --- |
| 冷启动到可交互（5000 任务 / 5 万 op，有 snapshot） | < 300ms |
| 冷启动全量重放（无 snapshot，5 万 op） | < 500ms，否则强制 snapshot |
| 单次写入（op 落盘 + UI 更新） | < 16ms（不能等 fsync） |
| 感知到另一台机器的改动 | 同步引擎落地后 < 1s |

---

## 1. 三层结构

把"数据在哪"这件事切成三层，每层的损坏后果完全不同：

| 层 | 位置 | 内容 | 坏了会怎样 |
| --- | --- | --- | --- |
| **真相来源** | 用户选的库目录（可能在 iCloud 上） | 追加写的 JSONL 操作日志 | 数据丢失。这一层必须极度保守 |
| **本地缓存** | `~/Library/Application Support/Kapibala/cache/<vaultId>/` | SQLite 索引、重放水位线 | 删掉即可，下次从日志重建 |
| **库注册表** | `~/Library/Application Support/Kapibala/vaults.json` | 有哪些库、在哪、本机在每个库里的设备身份 | 重新选一次目录即可恢复 |

**铁律：跨机器共享的目录里，只允许放"每台机器只写自己那份"的追加日志。** 任何"多台机器都要改的单个文件"都不行——包括单个大 JSON，尤其包括 SQLite。

### 1.1 为什么绝不能把 SQLite 放进库目录

这是同类项目最常见的翻车方式。SQLite 在 WAL 模式下同时操作三个文件（主库、`-wal`、`-shm`），而同步引擎会在任意时刻独立上传/替换其中任意一个。三个文件版本错配 = 数据库损坏。Obsidian、Anki、DEVONthink 都明确警告过这件事。

所以 `better-sqlite3` 在本项目里的定位是**纯本地的、可丢弃的查询索引**，永远建在 `Application Support` 下，永远可以从 JSONL 重建。它不是数据库，是缓存。

---

## 2. 库（Vault）模型

借用 Obsidian 的概念。应用启动时不假设任何路径。

### 2.1 库注册表：`vaults.json`

位置：`app.getPath('userData')/vaults.json`，即 `~/Library/Application Support/Kapibala/vaults.json`。

**绝对不能放在库目录里**——鸡生蛋问题：还没打开库，怎么知道库在哪。

```ts
type VaultsFile = {
  version: 1
  lastVaultId?: string
  vaults: VaultEntry[]
}

type VaultEntry = {
  id: string            // 与库内 meta.json 的 vaultId 一致，是真正的主键
  path: string          // 绝对路径，可能失效（外置盘未挂载 / 用户移动了目录）
  name: string          // 显示名，默认取目录名，可改
  lastOpenedAt: number
  bookmark?: string     // 预留：Mac App Store 沙箱下的 security-scoped bookmark（base64）
  device: DeviceIdentity // 本机在这个库里的身份，见 §4
}
```

约束：

- 文件权限 `0600`。里面有设备的认领令牌（`claimToken`）。
- **GUI 和 CLI 会同时改它**，所以写入必须走「同目录 `.tmp` + `rename()`」，并在本地加 `flock`（本地磁盘上 `flock` 是可靠的，见 §6.3）。
- `id` 是主键而不是 `path`：用户把库目录移到别处后，凭 `id` 认回来，而不是变成一个新库。
- 打开时 `path` 不存在 → 不删条目，标记为"暂时不可用"，让用户重新定位。外置硬盘和未登录的 iCloud 都属于这种情况。

### 2.2 库标识：`.kapibala/meta.json`

选定目录后在其中写入：

```ts
type VaultMeta = {
  appId: 'kapibala'     // 认亲用，防止把别的应用的目录当成库
  vaultId: string       // ULID，创建时生成，永不改变
  schema: number        // 存储格式版本，当前 1
  createdAt: number
  createdBy: string     // "kapibala/0.1.0"，排查问题用
}
```

`.kapibala/` 里**只放与机器无关的信息**。任何 per-device 的东西都在 `devices/<id>/` 里。

### 2.3 首次启动窗口的判定逻辑

启动窗口给三个入口：**打开最近的库** / **打开已有库** / **新建库**。用户选定一个目录后：

| 目录状态 | 判定 | 行为 |
| --- | --- | --- |
| 有 `.kapibala/meta.json`，`appId` 匹配，`schema <= 本机支持` | 已有库 | 直接打开 |
| 有 `.kapibala/meta.json`，`schema > 本机支持` | 更新的格式 | **只读打开**并提示升级应用。绝不能让旧版本写新格式的库 |
| 有 `.kapibala/meta.json`，`appId` 不匹配 | 别人的目录 | 拒绝，提示这不是 Kapibala 库 |
| 空目录 | 新建 | 写 meta.json，创建 `devices/<新 id>/` |
| 非空目录但没有 meta.json | 危险 | 明确询问「在这个已有文件的目录里创建库？」，默认否 |
| 有 meta.json 但 `vaultId` 已在 `vaults.json` 里且路径不同 | 库被移动或复制 | 更新已有条目的 path（移动），并走 §4.2 的归属校验（复制） |

`schema > 支持` 那一行是防数据损坏的关键：旧客户端写入新格式的库，会用它不理解的规则去压实和覆盖，后果是静默丢字段。

---

## 3. 目录结构

```
<用户选择的目录>/
├── .kapibala/
│   └── meta.json                # 库标识，见 §2.2
└── devices/
    ├── 01HX7...A1B2/            # 设备目录，名字就是设备 ID（ULID）
    │   ├── owner.json           # 认领令牌，见 §4.2
    │   ├── snapshot.json        # 本机自己的压实结果
    │   ├── 000001.jsonl         # 追加写，约 2MB 换下一个
    │   ├── 000002.jsonl
    │   └── 000003.jsonl         # 当前正在写的段
    └── 01HX8...C3D4/            # 另一台 Mac，本机只读，永不写入
        ├── owner.json
        ├── snapshot.json
        └── 000001.jsonl
```

- 段文件名是 6 位零填充的递增序号，保证字典序 = 时间序。
- **每台机器只写自己那个目录，从不碰别人的文件。** 这是整个设计的地基：不需要文件锁，不需要冲突解决 UI，结构上不可能产生 `000001 2.jsonl` 这种 iCloud 冲突副本。
- 已经不在服役的设备目录（换了电脑）**永远保留为只读历史**，不清理。清理省下的空间以 KB 计，代价是可能丢数据。

---

## 4. 设备身份

### 4.1 设备 ID 是 per-(设备, 库) 的

不是全局的，也**绝不从硬件信息派生**。每次在某台机器上第一次打开某个库时，生成一个新的随机 ULID。同一台 Mac 打开两个库，是两个互不相干的设备 ID。

```ts
type DeviceIdentity = {
  deviceId: string   // ULID，随机生成
  claimToken: string // 32 字节随机，hex。认领令牌，见 §4.2
  machineId: string  // IOPlatformUUID，用于识别"整机迁移"
  label: string      // "MacBook Pro"，只用于 UI 显示，不参与任何判定
}
```

一份存在库内 `devices/<id>/owner.json`，一份存在本地 `vaults.json` 的对应条目里。

### 4.2 库目录被整体复制：必须处理的坑

分片设计的前提是"一台机器一个设备目录"。这个前提有三种崩塌方式：

| 场景 | 现象 | 检测手段 |
| --- | --- | --- |
| 用户直接把库文件夹拷到另一台 Mac | B 机没有这个 vaultId 的本地记录 | `vaults.json` 里查不到 → 天然生成新设备 ID，安全 |
| 用户用 Time Machine 还原了同一台机器 | 本地记录和 owner.json 都在且匹配 | 是同一台机器，**应该**继续用原设备目录，正确 |
| **用迁移助理把整台 Mac 迁到新机器，旧机器还在用** | 两台机器的本地记录**完全相同**，令牌也相同 | 令牌匹配但 `machineId` 变了 |

所以启动时的归属校验是两个条件：

```ts
function claimDevice(vault: VaultEntry, dir: string): DeviceIdentity {
  const owner = readJsonOrNull(`${dir}/owner.json`)
  const mine =
    owner?.claimToken === vault.device.claimToken &&   // 令牌匹配
    owner?.machineId === currentMachineId()             // 且还是同一台物理机
  if (mine) return vault.device
  // 这个设备目录不属于我：静默换新身份，原目录退化为只读历史
  return forkNewDevice(vault)
}
```

几十行代码，挡掉一整类数据损坏。代价是主板维修换了 IOPlatformUUID 会白白 fork 一个新设备目录——旧历史仍然完整可读，可以接受。

### 4.3 同一台机器上的多进程

GUI 和 CLI 会同时运行，都想写同一个设备目录。跨机器不需要锁，**同机器需要**：

- 在本地（不是库目录里）建 `~/Library/Application Support/Kapibala/locks/<vaultId>.lock`，用 `flock` 争抢。**本地磁盘上的 flock 是可靠的**，被禁止的是在 iCloud 目录里用 flock。
- 拿不到锁的进程有两种策略：CLI 短暂重试（最多 2s）后报错退出；或者退化成"通过已在运行的 GUI 转发写入"。**MVP 阶段选前者**，简单且不会错。
- 不要指望 `O_APPEND` 的原子性兜底：单行小于 `PIPE_BUF` 时追加写通常原子，但一行 JSON 可能超过 4KB（备注字段），不能赌。

---

## 5. 操作日志

### 5.1 op 格式

每行一个 JSON 对象，UTF-8，`\n` 结尾。一行 = 一个字段的一次赋值。

```ts
type Op = {
  v: 1               // 行格式版本
  hlc: string        // "0001740000000000:0007:01HX7...A1B2"
  e: string          // entity 类型："task" | "list" | ...
  id: string         // 实体 ID，ULID
  f: string          // 字段名
  val: unknown       // 字段值，JSON 可表示的任意值
}
```

字段名用单字母是为了省磁盘（5 万 op 量级下省 20% 以上），但值和字段名保持人类可读——`grep '"f":"title"'` 应该能用。

**只有 `set` 一种操作。** 没有 `insert`/`delete`/`increment`。删除是 `{f: '_deleted', val: true}`（tombstone）。理由：单一操作类型让合并规则只有一条，收敛性可以完整测试；而计数器、有序列表这些需要额外 CRDT 类型的场景，待办应用里不存在（排序见 §7.3 的分数索引）。

**绝不真删。** 在分布式下真删必然导致数据复活：A 删了任务，B 还没同步就改了它的标题，合并后标题的 op 会让这个任务重新出现。tombstone + 字段级 LWW 才能让"删除"本身参与竞争。

### 5.2 HLC（混合逻辑时钟）

```
hlc = <16 位零填充的物理毫秒>:<4 位零填充的计数器>:<设备 ID>
```

零填充是为了**字符串字典序 == 时间序**，这样排序不需要解析。

```ts
// 本地产生一个新 op 时
function tick(): Hlc {
  const now = Date.now()
  if (now > last.physical) { last = { physical: now, counter: 0 } }
  else { last = { physical: last.physical, counter: last.counter + 1 } }
  return format(last, deviceId)
}

// 读到别人的 op 时必须推进本地时钟
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

`observe` 是正确性的关键，不是优化：如果本机系统时钟慢了 10 分钟，不推进时钟就会导致本机的新修改**永远输不过**另一台机器的旧修改。启动重放时对每条读到的 op 都要 `observe`。

物理时钟落盘持久化（存本地缓存），防止时钟回拨后 HLC 倒退。

### 5.3 合并规则：字段级 LWW

对每个 `(e, id, f)`，取 HLC 最大的那条 op 的值。

```ts
compare(a, b) = a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0   // 字符串比较即可
```

因为 HLC 末段是设备 ID 且设备 ID 全局唯一，**不存在平票**，任何机器算出的结果都完全一致。这就是收敛性。

字段级而非整对象级很重要：你在 Mac A 改标题、在 Mac B 改开始时间，两个改动都应该保留，而不是一个覆盖另一个。

### 5.4 向前兼容：不认识的东西必须原样保留

多台 Mac 上的应用版本几乎不可能同步升级。所以：

- **不认识的字段名照样存进状态**，实体在内存里是 `Record<string, {val, hlc}>`，业务类型只是它的一个视图。
- **不认识的 entity 类型也照样重放和保留。**
- 压实（§6.2）必须把不认识的字段一起写进 snapshot。**旧版本压实时丢掉新版本的字段，是最隐蔽的一类数据丢失。**
- 行格式 `v` 大于本机支持 → 停止写入，转只读并提示升级。

对应的 schema 演进规则：**只允许新增字段，永不复用旧字段名，永不改变已有字段的语义。** 字段废弃就让它自然沉底。

---

## 6. 读写流程

### 6.1 读取（冷启动）

```
1. 列出 devices/*/
2. 对每个设备目录：
   a. ensureDownloaded(该目录下所有文件)          ← §6.4
   b. 读 snapshot.json（校验通过则作为起点）
   c. 读 序号 > snapshot.lastSegment 的所有段文件
3. 所有 op 按 hlc 排序，逐条应用 LWW，逐条 observe 时钟
4. 结果写入本地 SQLite 索引，记录水位线
```

增量启动：水位线记录每个 `(deviceId, segment)` 已消费到的**字节偏移**。下次启动只从偏移处继续读。段文件是追加写的，偏移永远有效。

**容错**（这一层的原则是"绝不因为一行坏数据而拒绝启动"）：

- 最后一行可能不完整（写入过程中崩溃，或同步引擎上传到一半）。**只允许丢弃最后一行**，中间出现不完整行则说明文件真的坏了。
- JSON 解析失败或缺必需字段的行：跳过、计数、原样抄到 `Application Support/quarantine/` 便于排查，继续读下一行。
- 整个段文件读不出来：跳过这个文件，标记该设备"历史不完整"，在 UI 上如实提示，**不要静默当成空**。

### 6.2 写入

```
1. 拿本地 flock                                  ← §4.3
2. 生成 op（tick 出 hlc）
3. 追加一行到当前段文件，fs.appendFile
4. 立刻更新内存状态和 UI（不等 fsync）
5. 每 500ms 或退出前 fsync 一次
6. 段文件超过 2MB → 开新段
```

- 用户可感知的写入延迟里不包含 fsync。丢失最后几百毫秒的操作，比每次点击卡 20ms 更可接受。
- 应用退出、失去焦点、系统休眠前都要 flush。
- **原子写只用于整文件替换**（`meta.json`、`owner.json`、`snapshot.json`、`vaults.json`）：同目录内写 `.tmp` 再 `rename()`。跨目录 rename 不是原子操作。段文件是追加，不需要也不能用这个套路。

### 6.3 压实（compaction）

把自己的一段历史换成"这段历史的结论"：对每个 `(e, id, f)` 只保留 HLC 最大的那条 op。

- 触发条件：本设备目录的段文件总量 > 4MB，或段数 > 8。
- **只允许压实自己那个目录，别人的永远不动。**
- **压实前必须先切新段。** 关掉当前段、立刻开下一个，新写入全部去新段，然后才压实已冻结的那些。否则 snapshot 声称覆盖到第 8 段、而第 8 段还在被追加，snapshot 之后写进去的 op 会被读取逻辑跳过——静默丢数据。
- 写法：生成新的 `snapshot.json`，原子替换（同目录 `.tmp` + `rename`）。
- snapshot 的 `schema` 高于本机支持 → 不压实，直接读段文件。

#### 段文件永不删除

压实**只生成 snapshot，不回收任何段文件**。已被 snapshot 覆盖的段仍然留在磁盘上，只是读取路径不再经过它们（读取规则是 `snapshot + 序号 > lastSegment 的段`），所以不删也已经不花重放时间了——省下的是 CPU，不是磁盘。

理由是这笔交易根本不划算：

- 一条 op 约 100 字节，重度用户一年约 5 万条 op ≈ **5MB/年**，十年 50MB。冻结的段永不改变，同步引擎只上传一次，不产生反复流量。
- 回收要正确实现，得同时满足「在自己目录里」「已被 snapshot 覆盖」「snapshot 当前可读且 schema 兼容」「已过保留期」四个条件，还得自己记退役台账（**不能用文件 mtime**：同步引擎下载文件时会重写 mtime）并防时钟回拨。
- **这会是整个存储层唯一主动删除用户数据的代码路径。** 其他地方全是追加和覆盖自己的文件，出错最多多一份数据；只有这里判断错了就是历史永久消失。

省几 MB 磁盘，换一类最难查的 bug，不做。

顺带白送两个好处：段文件全留着就等于完整的操作历史，「任务修改历史 / 时间机器」这扇门自动是开着的；调试合并问题时原始 op 都在，可以复现回溯。

等真的出现几百 MB 的库（大概是导入外部数据的场景），再把回收做成一个**用户可见的显式操作**（"整理库"按钮，明确告知会发生什么），而不是后台悄悄删。

#### snapshot 格式

```ts
type Snapshot = {
  schema: 1
  deviceId: string      // 提到顶层，见下
  lastSegment: number   // 覆盖到第几个段（含）
  hlcMax: string        // 覆盖到的最大 HLC，读取时用来推进时钟
  state: {
    [entity: string]: {
      [id: string]: {
        [field: string]: { val: unknown, hlc: string }   // hlc 只存 "时间:计数器"
      }
    }
  }
}
```

`deviceId` 提到顶层，`state` 里每条 `hlc` 只存 `<时间>:<计数器>` 两段。因为 snapshot 里只有本机自己的 op，设备段必然是同一个值——26 个字符重复几万遍没有意义。实测一个 13 字段的 snapshot 从 2129 字节降到 1048 字节，省 58%（另一半来自不缩进：这是机器读的文件）。

**代价是读取方必须还原完整 HLC 再参与比较**：

```ts
const fullHlc = `${cell.hlc}:${snapshot.deviceId}`
```

漏了这一步，设备 ID 这个最终 tiebreaker 就没了，同一毫秒同一计数器的两条 op 会平票，收敛性直接失效。所以这个拼接**只允许在 snapshot 的加载函数里出现一次**，不要散落在各处。

#### 三件不能省的东西

1. **每个字段必须带自己的 HLC，不能只存值。** snapshot 之后还要跟别的设备合并，合并靠比 HLC。只存裸值 = LWW 失效。
2. **tombstone 一个字段都不能少。** 被删除的实体要连 `title`、`repeat` 这些字段一起留在 snapshot 里。如果整条丢掉，另一台机器上一条更旧的 `title` op 就会让它**原地复活**，而且没有 `_deleted` 标记。
3. **不认识的字段和 entity 类型原样保留。** 压实器只认 `(e, id, f) → HLC 最大者` 这一条规则，不查字段白名单。旧版本压实时丢掉新版本写的字段，是最隐蔽的一类数据丢失。

#### 为什么压实自己的目录不影响合并结果

字段级 LWW 就是按字段取 HLC 的 `max`，而 `max` 可结合、可交换：

```
max(a₁…aₙ, b₁…bₘ)  ==  max( max(a₁…aₙ), max(b₁…bₘ) )
```

左边是"两台机器的 op 混在一起排序重放"，右边是"A 机先把自己压成结论，再和 B 机的 op 合并"。**两者恒等。** 所以压实**不需要跟任何机器协调**：不需要知道别人同步到哪了，不需要知道别人读过我的旧段没有。

这也解释了为什么压别人的目录不行——除了会破坏"每台机器只写自己的"这条地基，它根本没有额外收益。

#### 收益要有预期

一条 op 和一个字段条目体积差不多（HLC 字符串本身就占 48 字符），**压实的收益完全来自同一字段的重复修改**。如果每个字段只写过一次，压实几乎白干。

所以 snapshot 的定位要清楚：

| 场景 | 靠什么加速 |
| --- | --- |
| 同一台机器日常冷启动 | **本地水位线**（记住每个 `(设备, 段, 字节偏移)` 读到哪了），跟 snapshot 无关 |
| **新 Mac 第一次打开这个库** | 没有本地缓存，只能全量重放 → snapshot 在这里救命 |
| 删掉本地缓存后重建 | 同上 |
| 限制库目录体积 | 不靠 snapshot——段文件永不删除，见上 |

### 6.4 同步目录的具体坑

以 iCloud Drive 为例，其他服务商用同一个 `ensureDownloaded(path)` 接口吃掉差异。

1. **文件可能没下载下来。** iCloud 会驱逐不常用文件，只留 `.000001.jsonl.icloud` 占位符（注意：目录列表里看到的是这个带点前缀的名字，扫描逻辑必须做名字还原）。读之前必须检测并触发下载，等待完成后再读。**跳过占位符 = 静默丢掉一整台设备的全部历史**，这是最危险的一个坑。触发方式：读一次文件，或 `brctl download <path>`；然后轮询等真实文件出现，超时 30s，期间在 UI 上显示"正在下载 N 个文件"。
2. **不要用文件锁。** `flock` 在 iCloud Drive 上跨机器毫无意义。分片设计的意义就是让你不需要它。
3. **不要 `fs.watch` 到事件就立刻读。** 同步过程中文件可能处于中间状态。300ms 防抖 + 读失败重试（退避到 2s，最多 5 次）。只监听 `devices/`，且忽略自己的目录（自己的状态本来就在内存里）。
4. **建议用户关掉 iCloud 的"优化 Mac 储存空间"**，或在首次设置时提示这一点——它是产生占位符的主要原因。
5. 本地缓存和索引一律放 `~/Library/Application Support/Kapibala/cache/<vaultId>/`。用 `vaultId` 而不是路径哈希做目录名，这样用户移动库目录后缓存仍然有效。

---

## 7. 数据模型

### 7.1 当前范围

README 里已经把首个可用版本的功能收敛到：备注、开始时间、多个提醒、周期任务、完成/删除。所以 MVP 只有一个 entity 类型：`task`。

```ts
type Task = {
  id: string              // ULID
  title: string
  notes?: string
  startAt?: number        // epoch ms
  isAllDay: boolean
  reminders: Reminder[]   // 一个任务可以有多个提醒
  repeat?: RepeatRule     // 见 §7.2
  order: string           // 分数索引，见 §7.3
  completedAt?: number
  createdAt: number
  _deleted?: true         // tombstone，进垃圾桶
  _purgedAt?: number      // 垃圾桶清空时间，只是标记，仍不物理删除
}

type Reminder = { id: string, offsetMin?: number, at?: number }
```

**这个裁剪不影响将来加回去。** 字段级 op log 的一个直接好处是：新增 `tags`、`priority`、`listId`、`dueAt`、`parentId` 只是开始写新的字段名，**不需要任何数据迁移**，旧数据里没有这些字段就是没有。所以现在不必为了"以后可能要"而提前实现它们。

同理，`list` / `tag` 作为独立 entity 类型可以随时加进来，格式完全一样。

### 7.2 周期任务：必须做到幂等生成

这是整个数据模型里唯一有真正分布式陷阱的地方。

```ts
type RepeatRule = {
  rrule?: string                         // RFC 5545 RRULE 子集，如 "FREQ=MONTHLY;BYDAY=2TU"
  freq?: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'   // 0.0.x 写下的形状，只读不写
  interval?: number
  mode?: 'fixed' | 'afterCompletion'     // 固定周期 / 完成后 N 天再来
  tz?: string                            // "Asia/Shanghai"。RRULE 没有时区就是错的
}
```

RRULE 支持的子集：`FREQ`（DAILY/WEEKLY/MONTHLY/YEARLY）、`INTERVAL`、`BYDAY`
（可带序号，`2TU` = 第二个周二，`-1FR` = 最后一个周五）、`BYMONTHDAY`（`-1` = 月末）、
`BYMONTH`、`UNTIL`。**不支持 `COUNT`**——它要记"已经生成过几次"，和"完成时才生成下一个"
的模型冲突。不支持的部分在解析时忽略而不是猜，因为猜会算出错的日期。

`freq` / `interval` 这对旧字段是 0.0.x 写下的，读的时候转成 RRULE，新数据只写 `rrule`。
这正是"只增字段、不改语义"那条规则的实际用法：用户库里已经有的数据一行都不用迁移。

问题：完成一个周期任务时要生成下一个实例。如果两台 Mac 都完成了同一次，就会生成**两个**下一个实例。

解法：**实例 ID 确定性派生，不用随机 ULID。**

```ts
nextId = uuidv5(`${seriesId}|${occurrenceISO}`, KAPIBALA_NS)
```

两台机器算出同一个 ID，写出的 op 落在同一个实体上，字段级 LWW 一合并就是一个任务。生成变成幂等操作，不需要任何协调。

`afterCompletion` 模式下 `occurrenceISO` 取"完成时间"，两台机器的完成时间可能差几秒 → ID 不同 → 还是会生成两个。所以这种模式下把完成时间**按天取整**（用 `tz` 对应的本地日期）再参与派生。同一天内多次完成不会分叉。

### 7.3 排序用分数索引，不用整数

手动拖拽排序，如果 `order` 是整数，插入时要重编号一片任务 → 一次拖拽产生几十条 op，而且两台机器同时拖拽会得到交错的混乱结果。

改用字符串分数索引（LexoRank / fractional indexing）：在 `"a1"` 和 `"a2"` 之间插入就是 `"a1V"`。一次拖拽 = 一条 op，且并发插入不会互相破坏（最坏情况是两个任务拿到相同 order，用 `id` 做稳定 tiebreaker 即可）。

### 7.4 时间与时区

- 所有时间戳存 epoch ms（UTC），不存本地时间字符串。
- `isAllDay` 为真的任务，语义是"某个本地日期"，渲染时用**当前设备的时区**解释；这是有意的选择——跨时区旅行时，"今天"应该跟着人走。
- 周期任务的 `tz` 必须显式存，因为"每周一 9:00"这个规则本身是绑时区的。

---

## 8. 本地索引

- `~/Library/Application Support/Kapibala/cache/<vaultId>/index.sqlite`
- 内容：物化后的任务表 + 视图需要的索引（按 `startAt`、按 `completedAt`）+ 重放水位线。
- **随时可删。** 删掉就全量重放重建。这一层出任何问题的正确处理方式都是"删了重建"，绝不尝试修复。
- 有它才能做到冷启动 < 300ms 和"最近 7 天"这类查询不用全表扫。
- MVP 阶段可以先不做：5000 任务全放内存完全没问题。**先做正确的日志层，索引层等性能预算真的超了再加。**

---

## 9. 落地顺序与验证

### 9.1 顺序

```
core 包（op log + HLC + 合并 + 库管理）
  → CLI 验证（无界面，命令行 CRUD 跑通两台 Mac 同步）
  → 界面
```

**在没有 UI 的情况下把下面的 spike 全部跑通，再动 React。**

### 9.2 必做的 spike（每个半天）

1. **iCloud 占位符** —— 手动 `brctl evict` 一个段文件，验证读取逻辑能检测并触发下载，而不是当成空文件。
2. **两台 Mac 并发写** —— 断网各改 10 条，同时恢复网络，验证合并结果两边一致、目录里没有冲突副本。
3. **HLC 收敛性** —— 属性测试：随机生成 op 序列，任意打乱顺序重放，结果必须完全相同。这个测试要一直留在 CI 里。
4. **库目录被整体拷贝 / 整机迁移** —— 拷到另一台 Mac 打开，验证归属校验生效、自动换新设备 ID、原历史不被污染。
5. **重放性能** —— 造 5000 任务、5 万 op，测冷启动重放耗时。超过 500ms 就上 snapshot。
6. **时钟回拨** —— 把系统时间往后调 10 分钟再写入，验证新改动仍然胜出旧改动（即 `observe` 正确）。
7. **周期任务幂等** —— 两台机器离线各完成同一次周期任务，验证合并后只有一个下一个实例。
8. **崩溃写入** —— 写入中途 `kill -9`，验证下次启动只丢最后一行、不拒绝启动。

### 9.3 需要一直留在 CI 的测试

- HLC 收敛性属性测试（随机 op 序列 × 随机打乱 × 断言状态相同）。
- 多设备模拟：在临时目录里造 N 个 `devices/` 子目录，模拟交错写入，断言收敛。
- 向前兼容：用"含未知字段和未知 entity 类型"的日志跑一遍读取 → 压实 → 再读取，断言未知内容一字不丢。
- 压实等价性：`merge(A全量, B)` 必须恒等于 `merge(snapshot(A), B)`，随机生成 A、B 反复验证。这条同时覆盖了「hlc 还原」有没有漏。

---

## 10. 一页速查

| 决策 | 结论 |
| --- | --- |
| 真相来源 | 用户目录里的 JSONL 追加日志 |
| 分片方式 | 每设备一个目录，只写自己的 |
| 合并 | HLC + 字段级 LWW，设备 ID 做 tiebreaker |
| 删除 | tombstone，永不物理删除 |
| 库列表 | `~/Library/Application Support/Kapibala/vaults.json`，绝不放库内 |
| 库标识 | 库内 `.kapibala/meta.json` |
| 设备身份 | per-(设备,库) 随机 ULID + claimToken + machineId 双重校验 |
| 锁 | 跨机器不用锁；同机器多进程用**本地** flock |
| SQLite | 只在 `Application Support`，可丢弃的索引 |
| 原子写 | 同目录 `.tmp` + `rename`，只用于整文件替换 |
| snapshot | `deviceId` 提到顶层，字段里的 `hlc` 只存 `时间:计数器`，读取时还原完整 HLC |
| 段文件回收 | 不做。压实只生成 snapshot，段文件永久保留 |
| 未知字段 | 原样保留，压实时也保留 |
| schema 演进 | 只增字段，不复用名字，不改语义 |
| 新格式库遇上旧客户端 | 只读打开 + 提示升级 |

