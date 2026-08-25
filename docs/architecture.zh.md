# Kapibala 技术架构

本文是技术选型与工程结构的结论。存储设计见 [`storage.zh.md`](./storage.zh.md)，本文不重复，只讲代码怎么组织。

---

## 1. 选型一览

| | 选择 | 一句话理由 |
| --- | --- | --- |
| 语言 | TypeScript，全程 strict | |
| 外壳 | Electron | core 要被纯 Node CLI 复用，这排除了 Tauri（§2） |
| UI | React + TypeScript | |
| 状态 | Zustand | 渲染进程只是投影，不需要 RTK 那套（§6） |
| 真相来源 | 用户自选目录里的 JSONL | 见 storage.zh.md |
| 本地索引 | MVP 不做 | 引入条件写在 §3 |
| CLI | 与 GUI 共用 core package | core 做成 I/O 注入的纯逻辑（§4） |
| 进程边界 | 存储只在主进程 | 同时是安全与正确性边界（§5） |

---

## 2. 为什么是 Electron

决定性因素是 **CLI**：`kapi` 和 GUI 共用同一个 core package。而 core 里装的是整个项目最难、最需要反复测试的东西：HLC、字段级 LWW、压实、iCloud 占位符处理。这就意味着：

- **Electron**：core 是一个纯 TS 包，GUI 的主进程 `import` 它，CLI 也 `import` 它。一份代码、一套测试、两个宿主。
- **Tauri**：Tauri 没有 Node 运行时，文件访问在 Rust 侧。core 要么用 Rust 写（那 CLI 也得是 Rust，TS 只剩画界面），要么在 webview 里用 Tauri 的 fs 插件（拿不到 Node 的 fs 语义，还要把所有 I/O 走一遍 IPC）。**无论哪条路，"GUI 和 CLI 共用一个 core"都不成立了。**

**共用 core 这个决定直接排除了 Tauri**。反过来说，如果哪天愿意放弃 TS 版 CLI，Tauri 才重新进入选项。

### 代价（要认）

| 代价 | 量级 | 能否接受 |
| --- | --- | --- |
| 安装包体积 | dmg 100~150MB | 能。个人工具，不是移动端 |
| 空载内存 | 200~300MB | 能，但要常驻托盘，所以别乱建窗口 |
| 原生模块要为 Electron 单独编译 | 见 §3 | **这是砍掉 SQLite 的直接原因** |
| 签名公证 | Apple Developer $99/年 | 必须付。不然 Gatekeeper 直接拦，用户要右键打开 |
| 启动速度 | 冷启 ~1s | 能，但别在启动路径上放全量重放（靠 snapshot） |

### 被排除的其他选项

- **Swift + SwiftUI**：原生体验最好，但整个 TS 生态和共用 core 全部作废，而且存储层要重写一遍。除非放弃 CLI。
- **纯 CLI + TUI**：spike 阶段确实这么干（见 §9），但最终形态需要提醒通知和托盘。
- **PWA / 浏览器**：拿不到用户任意目录的读写权限，与整个设计前提冲突。

---

## 3. 本地索引：MVP 不做

本地索引（`better-sqlite3`）现在不引入。它是原生模块（C++ 编译），带来一个具体麻烦：

**同一个原生模块需要两份编译产物。** Electron 用的是自己那份 Node ABI，CLI 用的是系统 Node 的 ABI。所以 `better-sqlite3` 要 `electron-rebuild` 一份给 GUI、`npm rebuild` 一份给 CLI；Electron 升版本要重编，CI 上要装 Xcode 命令行工具，签名时还要单独处理 `.node` 文件的公证。

而它要解决的是**一个还不存在的性能瓶颈**。

算一下：5000 个任务全物化在内存里，每个任务按 20 个字段算，就是 10 万个 `{val, hlc}` 对象，几十 MB 以内。`storage.zh.md` 的性能预算里"最近 7 天"这类查询，在内存数组上 `filter` + `sort` 是微秒级的。

**所以顺序应该是：先把日志层做正确，等性能预算真的超了再加索引。** 加的时候也不需要改存储格式——SQLite 只是一份可丢弃的投影，删了能重建。

不引入它还顺带带来两个好处：

- **依赖树里没有任何原生模块。** 打包、签名、CI 全部简单一档。
- core 保持纯 TS，可以在 Node、Electron、甚至浏览器里跑同一套测试。

留一个明确的重新引入条件：**冷启动全量重放超过 500ms，或任务数超过 2 万。**

---

## 4. core 必须是 I/O 注入的

core 要同时被 GUI 主进程和 CLI 复用，还要能被自动化测试反复折腾，所以它不能直接 `import fs`。

```ts
// packages/core/src/ports.ts
export interface FsPort {
  readFile(path: string): Promise<Uint8Array>
  appendFile(path: string, data: Uint8Array): Promise<void>
  writeAtomic(path: string, data: Uint8Array): Promise<void>   // 同目录 .tmp + rename
  readDir(path: string): Promise<DirEntry[]>
  stat(path: string): Promise<FileStat | null>
  ensureDownloaded(path: string): Promise<void>                // iCloud 占位符，见 storage.zh.md §6.4
}

export interface ClockPort { now(): number }                    // 测时钟回拨要能伪造
export interface RandomPort { ulid(): string, bytes(n: number): Uint8Array }
```

三个适配器：

| 适配器 | 用途 |
| --- | --- |
| `NodeFsAdapter` | 真实文件系统 + `brctl` 占位符处理。GUI 主进程和 CLI 都用它 |
| `MemFsAdapter` | 全内存。单元测试和属性测试用，一次跑几千个 case 不碰磁盘 |
| `FaultyFsAdapter` | 故意在指定时机抛错/截断/返回占位符。测崩溃恢复和坏数据容错 |

这不是为了架构好看。`storage.zh.md` §9 列的那些验证——HLC 收敛性、压实等价性、崩溃只丢最后一行、时钟回拨——**没有 `MemFsAdapter` 和可伪造的时钟就没法自动化测**，只能靠两台真机手动试，那么这些测试就不会真的一直跑。

反过来，`ensureDownloaded` 作为一个 port 方法，也让"Dropbox / 坚果云的占位符机制不同"这件事被收敛到一个适配器里。

---

## 5. 进程边界：存储只在主进程

这条同时是安全边界和正确性边界。

```
┌─────────────────────────────────────────┐
│ 渲染进程（React）                        │
│ - contextIsolation: true                │
│ - nodeIntegration: false                │
│ - sandbox: true                         │
│ - 零 fs 权限。只认识 window.kapi.*       │
└──────────────┬──────────────────────────┘
               │ IPC（typed，见下）
┌──────────────▼──────────────────────────┐
│ 主进程                                   │
│ - 独占 core + NodeFsAdapter             │
│ - 持有本地 flock（storage.zh.md §4.3）   │
│ - 托盘、通知、菜单、开机自启              │
└─────────────────────────────────────────┘
```

两个理由：

1. **正确性**：一个库同时只能有一个写入者。写入集中在主进程，配合本地 flock，天然满足。如果渲染进程也能写，就多出一个需要协调的写入者。
2. **安全**：渲染进程跑的是 React，虽然不加载远程内容，但 `nodeIntegration: false` 是零成本的默认防线。用户的任务数据和整个磁盘的读写权限不该暴露在 DOM 那一层。

IPC 表面要小且有类型：

```ts
// packages/ipc/src/contract.ts —— 主进程和渲染进程共享这一份定义
export type Commands = {
  'vault:list':     () => VaultSummary[]
  'vault:open':     (id: string) => VaultState
  'vault:create':   (dirPath: string) => VaultState
  'task:create':    (draft: TaskDraft) => TaskId
  'task:setField':  (id: TaskId, field: string, val: unknown) => void
  'task:complete':  (id: TaskId, at: number) => void
  'task:delete':    (id: TaskId) => void
}
export type Events = {
  'tasks:changed':  (patch: TaskPatch[]) => void   // 主进程推，含另一台 Mac 同步过来的改动
  'vault:status':   (s: VaultStatus) => void       // 正在下载 N 个文件 / 历史不完整 / 只读
}
```

`task:setField` 这种通用命令直接对应存储层的一条 op，**不要为每个字段发明一个 IPC 命令**——字段会一直加，IPC 表面不该跟着膨胀。

---

## 6. 状态管理：Zustand，而且要薄

关键是想清楚**真相在哪**：真相在主进程的 core 里，渲染进程拿到的是投影 + 增量 patch。

所以渲染进程的 store 只需要三件事：物化后的任务表、当前视图的筛选条件、UI 局部状态（哪个清单展开了）。没有异步 thunk 编排，没有乐观更新回滚（写入直接走 IPC，主进程立刻回推 patch），没有中间件需求。

Redux Toolkit 的 `createEntityAdapter`、`createAsyncThunk`、devtools 时间旅行在这个规模下是纯负担，所以用 **Zustand**。

一个具体约定：**store 里存物化后的业务对象，不存 op**。op 是存储层的概念，不该泄漏到 UI。渲染进程永远看不到 HLC。

乐观更新的处理：点击"完成"时先本地改，同时发 IPC；主进程写 op 后回推 patch。因为字段级 LWW 的写入不会失败（追加日志没有约束冲突），所以**不需要回滚逻辑**——这是选 LWW 顺带得到的好处。

---

## 7. 仓库结构与依赖

### 结构

```
kapibala/
├── packages/
│   ├── core/            # 纯 TS。op log、HLC、LWW、压实、库管理。无 electron 无 fs 直接依赖
│   ├── adapters-node/   # NodeFsAdapter + brctl 占位符处理
│   └── ipc/             # 主进程/渲染进程共享的 IPC 契约类型
├── apps/
│   ├── desktop/         # Electron 主进程 + React 渲染进程
│   └── cli/             # kapi，纯 Node，bin 入口
├── docs/
│   ├── storage.zh.md
│   └── architecture.zh.md
└── README.zh.md
```

依赖方向是单向的，用 ESLint 的 `no-restricted-imports` 钉死：

```
core  ←  adapters-node  ←  cli
  ↑                         
  └──  desktop(main)  →  ipc  ←  desktop(renderer)
```

**`core` 不许 import electron、不许 import node:fs。** 这条规则一破，MemFs 测试就废了。

### 工具链

| | 选择 | 说明 |
| --- | --- | --- |
| 包管理 | pnpm（`corepack enable pnpm`） | workspace 支持好，本机已有 corepack 0.34.6 |
| 语言 | TypeScript `strict: true` | 加 `noUncheckedIndexedAccess`。存储层全是索引访问 |
| 模块 | ESM 全栈 | Electron 主进程已支持 ESM，CLI 也是 ESM + shebang |
| 构建（桌面） | electron-vite | 主进程/preload/渲染进程三份配置开箱可用 |
| 打包 | electron-builder | dmg + 签名 + 公证 一条链 |
| 构建（CLI） | tsdown 或 tsc | CLI 不需要 bundle，直接发编译产物 |
| 测试 | vitest | 和 vite 同源，配置最少 |
| 属性测试 | **fast-check** | 见 §8，这个不是可选项 |
| Lint | ESLint + oxlint | 主要为了钉依赖方向 |

### 运行时依赖（刻意保持得很少）

| 包 | 用途 | 备注 |
| --- | --- | --- |
| `ulid` | 实体 ID、设备 ID | |
| `rrule` | 周期任务的 RFC 5545 解析与展开 | 别手写 RRULE |
| `luxon` | 时区计算（`Asia/Shanghai` 的"每周一 9:00"） | |
| `uuid` | v5 确定性派生周期实例 ID（storage.zh.md §7.2） | |
| `zustand` | 渲染进程状态 | |
| `react` / `react-dom` | | |

**没有原生模块，没有 ORM，没有日期工具全家桶。** 读取 op 行的校验用手写的窄校验函数，不用 zod——5 万行的热路径上，schema 校验库的开销是实测能看出来的。

---

## 8. 测试策略

分三层，第二层是重点。

**① 单元测试**（vitest + MemFsAdapter）：HLC 的 `tick`/`observe`、LWW 比较、段文件轮转、坏行跳过。

**② 属性测试**（fast-check）—— 这一层是存储层的命脉：

```ts
// 随机生成多设备 op 序列，任意打乱重放，结果必须完全相同
test.prop([arbOpLog()])('LWW 收敛', (ops) => {
  expect(replay(shuffle(ops))).toEqual(replay(shuffle(ops)))
})

// 压实前后合并结果恒等（storage.zh.md §6.3 的代数保证）
test.prop([arbOpLog(), arbOpLog()])('压实等价', (a, b) => {
  expect(merge(replay(a), replay(b))).toEqual(merge(snapshotOf(a), replay(b)))
})
```

为什么必须是属性测试而不是例子测试：分布式合并的 bug 几乎都藏在特定的交错顺序里，手写的例子永远想不到那几种。这两个测试要**从第一天就在 CI 里**，而不是等出问题再补。

**③ 真机验收**：`storage.zh.md` §9.2 的 8 个 spike，两台 Mac + 真 iCloud。这层没法自动化，但只需要在存储格式变化时重跑。

---

## 9. 实施顺序

**存储层 → CLI 验证 → 界面。** 存储层是唯一改起来代价极高的部分。

| 阶段 | 产出 | 完成标准 |
| --- | --- | --- |
| **M0 骨架** | pnpm workspace、core 空包、vitest 跑通 | `pnpm test` 绿 |
| **M1 op log** | HLC、LWW、段文件读写、MemFs 适配器 | §8 的两个属性测试通过 |
| **M2 库管理** | vaults.json、meta.json、设备身份与 claimToken 校验 | 库目录被拷贝后能正确 fork |
| **M3 CLI** | `kapi add/today/done/rm/ls` | **两台 Mac 用 CLI 跑通同步，spike 1~8 全过** |
| **M4 压实** | snapshot 生成与读取 | 压实等价性测试通过；5 万 op 冷启 < 300ms |
| **M5 界面** | Electron + React，四个视图 | 能替代 CLI 日常使用 |
| **M6 打包** | dmg、签名公证、托盘、开机自启、通知 | 另一台 Mac 上装了能用 |

**M3 是关键闸门**：在没有 UI 的情况下用 CLI 跑通两台 Mac 的真实同步，spike 全过，才动 React。界面随时能重写，存储层不能。

Task 6 的 npm 占位（`kapibala` / `kapi` 都还空着）可以在 M0 之后随时做，不占关键路径。

---

## 10. 已知的坑与取舍

**提醒只在应用运行时才响。** Electron 的通知依赖进程存活。所以必须做托盘常驻 + 开机自启，并且在设置里说清楚。想做到"应用没开也能提醒"就得写 launchd agent 或原生 helper，MVP 不做。

**签名公证要花钱。** Apple Developer $99/年。不签名的 dmg 在别人机器上会被 Gatekeeper 拦，用户得右键打开——自己用可以，想给别人用就得付。

**MVP 只出 arm64。** 本机是 arm64、macOS 26。universal 包体积翻倍，Intel Mac 的需求等有人提再说。

**Electron 主进程的 fs 是异步的，但 op 追加要有序。** 并发 `appendFile` 会交错。core 内部要有一个串行写队列，不能依赖调用方自觉。

**不做的事**（写下来防止范围漂移）：自建同步服务、端到端加密、移动端、实时协作、插件系统、主题市场。

---

## 11. 一页速查

| 决策 | 结论 |
| --- | --- |
| 外壳 | Electron（因为 core 要被纯 Node CLI 复用，这排除了 Tauri） |
| UI | React + TypeScript strict |
| 状态 | Zustand，薄投影，store 里不出现 op 和 HLC |
| 本地索引 | **MVP 不做**。冷启 > 500ms 或任务 > 2 万时再引入 SQLite |
| 原生模块 | MVP 零个 |
| core | 纯 TS + I/O 注入（FsPort / ClockPort / RandomPort） |
| 进程边界 | 存储只在主进程；渲染进程零 fs 权限 |
| IPC | 共享类型契约，`task:setField` 一条命令对应一条 op |
| 包管理 | pnpm workspace，ESM 全栈 |
| 测试 | vitest + **fast-check 属性测试**，第一天就进 CI |
| 顺序 | 存储层 → CLI（M3 闸门）→ 界面 |
| 分发 | arm64 dmg，签名公证，托盘常驻 |

