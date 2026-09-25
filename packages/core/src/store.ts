import type { Env } from './ports.ts'
import type { Op, State, Task } from './types.ts'
import { HlcClock, cmpHlc } from './hlc.ts'
import { applyOp, replay, tasksOf } from './state.ts'
import { SEGMENT_MAX_BYTES, dehydrate, encodeOps, readVault, segName } from './log.ts'
import { ulid } from './ids.ts'
import { nextOccurrence } from './repeat.ts'
import { orderKey } from './order.ts'
import { openVault, createVault, type OpenResult } from './vault.ts'

export type TaskDraft = {
  title: string
  notes?: string
  startAt?: number
  isAllDay?: boolean
  repeat?: Task['repeat']
  seriesId?: string
  id?: string
  /** 落点（分数索引 key）。界面算好传进来（见 app.ts 的 orderForNewDay）；
   *  不带就退回 orderKey 那个近似落点 */
  order?: string
}

export type Health = { badLines: number; droppedTail: boolean; incomplete: boolean; devices: number }

export class Store {
  private state: State = {}
  private ownState: State = {}        // 只有本机自己的 op，压实时用
  private clock!: HlcClock
  private segIndex = 1
  private segBytes = 0
  health: Health = { badLines: 0, droppedTail: false, incomplete: false, devices: 0 }

  private env: Env
  readonly vault: OpenResult
  private constructor(env: Env, vault: OpenResult) { this.env = env; this.vault = vault }

  static async open(env: Env, vaultPath: string, create = false): Promise<Store> {
    const v = create ? await createVault(env, vaultPath) : await openVault(env, vaultPath)
    const s = new Store(env, v)
    await s.load()
    return s
  }

  private get dir() { return `${this.vault.entry.path}/devices/${this.vault.device.deviceId}` }

  private async load(): Promise<void> {
    const { ops, devices } = await readVault(this.env.fs, this.vault.entry.path)
    this.clock = new HlcClock(this.env.clock, this.vault.device.deviceId)
    this.state = {}
    for (const op of ops) { applyOp(this.state, op); this.clock.observe(op.hlc) }

    const own = devices.find(d => d.deviceId === this.vault.device.deviceId)
    this.ownState = own ? replay([...own.ops].sort((a, b) => cmpHlc(a.hlc, b.hlc))) : {}
    // 必须严格大于 snapshot 覆盖到的段号，否则写进去的 op 会被读取逻辑跳过 —— 静默丢数据
    this.segIndex = Math.max(0, ...(own?.segments ?? []), (own?.lastSegment ?? 0) + 1, 1)
    this.segBytes = await this.env.fs.size(`${this.dir}/${segName(this.segIndex)}`)
    this.health = {
      badLines: devices.reduce((n, d) => n + d.badLines, 0),
      droppedTail: devices.some(d => d.droppedTail),
      incomplete: devices.some(d => d.incomplete),
      devices: devices.length,
    }
  }

  /** 一条命令 = 一次写盘。core 内部串行，不能靠调用方自觉 */
  private queue: Promise<unknown> = Promise.resolve()
  private write(fields: Array<{ id: string; f: string; val: unknown; e?: string }>): Promise<void> {
    const run = async () => {
      if (this.vault.readOnly) throw new Error('这个库的格式比当前版本新，已按只读打开')
      const ops: Op[] = fields.map(x =>
        ({ v: 1, hlc: this.clock.tick(), e: x.e ?? 'task', id: x.id, f: x.f, val: x.val }))
      const data = encodeOps(ops)
      if (this.segBytes + data.byteLength > SEGMENT_MAX_BYTES) { this.segIndex++; this.segBytes = 0 }
      await this.env.fs.mkdirp(this.dir)
      await this.env.fs.appendFile(`${this.dir}/${segName(this.segIndex)}`, data)
      this.segBytes += data.byteLength
      for (const op of ops) { applyOp(this.state, op); applyOp(this.ownState, op) }
    }
    this.queue = this.queue.then(run, run)
    return this.queue as Promise<void>
  }

  /** 重新扫盘，拿到别的 Mac 同步过来的改动 */
  async refresh(): Promise<void> { await this.load() }

  tasks(): Task[] { return tasksOf(this.state) }
  task(id: string): Task | undefined { return this.tasks().find(t => t.id === id) }

  async add(d: TaskDraft): Promise<string> {
    const id = d.id ?? ulid(this.env.clock, this.env.random)
    const f: Array<{ id: string; f: string; val: unknown }> = [
      { id, f: 'title', val: d.title },
      { id, f: 'createdAt', val: this.env.clock.now() },
      { id, f: 'isAllDay', val: d.isAllDay ?? true },
      // 落点由调用方给：界面知道"哪一天"，能算出那天末尾的位置。界外调用
      //（CLI、测试）没这个信息，退回按创建时间递增的 key
      { id, f: 'order', val: d.order ?? orderKey(this.env.clock.now()) },
    ]
    if (d.notes !== undefined) f.push({ id, f: 'notes', val: d.notes })
    if (d.startAt !== undefined) f.push({ id, f: 'startAt', val: d.startAt })
    if (d.repeat) f.push({ id, f: 'repeat', val: d.repeat })
    if (d.seriesId) f.push({ id, f: 'seriesId', val: d.seriesId })
    await this.write(f)
    return id
  }

  setField(id: string, f: string, val: unknown) { return this.write([{ id, f, val }]) }

  /**
   * 一批字段写进同一次 append。一次拖拽要么只改 order（单天内排序），要么
   * startAt + order 一起改（跨天顺带定位）；那一格挤满了要整格重排时也是一批。
   * 分几次调 setField 就是几次追加、几条段记录 —— 日志要跨 iCloud 同步，能省则省。
   */
  async setMany(rows: Array<{ id: string; f: string; val: unknown }>): Promise<void> {
    if (!rows.length) return
    await this.write(rows)
  }

  /** 完成。周期任务顺带生成下一个实例（ID 确定性派生，两台机器不会各生成一个） */
  async complete(id: string): Promise<Task | null> {
    const t = this.task(id)
    if (!t) return null
    const at = this.env.clock.now()
    const fields: Array<{ id: string; f: string; val: unknown }> = [{ id, f: 'completedAt', val: at }]
    // 完成即收工：进行中的标记自动清掉。只有确实标记过才写这一条，
    // 免得给每条完成操作都多塞一行 no-op（日志要跨 iCloud 同步，能省则省）
    if (t.inProgress) fields.push({ id, f: 'inProgress', val: false })
    let next: Task | null = null
    const occ = nextOccurrence(t, at)
    if (occ && !this.task(occ.id)) {
      fields.push(
        { id: occ.id, f: 'title', val: t.title },
        { id: occ.id, f: 'createdAt', val: at },
        { id: occ.id, f: 'isAllDay', val: t.isAllDay },
        { id: occ.id, f: 'order', val: orderKey(at) },
        { id: occ.id, f: 'startAt', val: occ.startAt },
        { id: occ.id, f: 'repeat', val: t.repeat },
        { id: occ.id, f: 'seriesId', val: occ.seriesId },
      )
      if (t.notes !== undefined) fields.push({ id: occ.id, f: 'notes', val: t.notes })
      // 「重要」跟着系列往后走：勾完成时下一个实例继承它，之后每派生一次都再传下去，
      // 所以定成周期任务的那条重要任务会一直保持高亮。不重要就不写这条 ——
      // 派生出来的实例本来就是不重要（旧数据里没这个字段，同理）
      if (t.important) fields.push({ id: occ.id, f: 'important', val: true })
    }
    await this.write(fields)
    if (occ) next = this.task(occ.id) ?? null
    return next
  }

  uncomplete(id: string) { return this.setField(id, 'completedAt', null) }
  /** 删进垃圾桶时同样收工 —— 一条躺在垃圾桶里的任务不该还标着"进行中" */
  async trash(id: string) {
    const t = this.task(id)
    const fields: Array<{ id: string; f: string; val: unknown }> = [{ id, f: '_deleted', val: true }]
    if (t?.inProgress) fields.push({ id, f: 'inProgress', val: false })
    return this.write(fields)
  }
  restore(id: string)    { return this.setField(id, '_deleted', false) }
  /** 垃圾桶清空也只是打标记——真删在分布式下必然导致数据复活 */
  purge(id: string)      { return this.write([{ id, f: '_purgedAt', val: this.env.clock.now() }]) }

  /**
   * 清空垃圾桶：所有标记写在同一批里，不是 N 次追加。
   * tasks() 本身已经把之前清掉的过滤掉了，所以不会反复给同一条写标记。
   */
  async purgeAll(): Promise<number> {
    const ids = this.tasks().filter(t => t.deleted).map(t => t.id)
    if (!ids.length) return 0
    const at = this.env.clock.now()
    await this.write(ids.map(id => ({ id, f: '_purgedAt', val: at })))
    return ids.length
  }

  /**
   * 压实：先切新段，再把已冻结的段压成 snapshot。只压自己的目录，段文件永不删除。
   * 见 storage.zh.md §6.3
   */
  async compact(): Promise<{ lastSegment: number } | null> {
    const frozen = this.segIndex
    if (this.segBytes === 0 && frozen <= 1) return null
    this.segIndex = frozen + 1
    this.segBytes = 0
    let hlcMax = ''
    for (const byId of Object.values(this.ownState))
      for (const fields of Object.values(byId))
        for (const c of Object.values(fields)) if (cmpHlc(c.hlc, hlcMax) > 0) hlcMax = c.hlc
    const snap = dehydrate(this.vault.device.deviceId, this.ownState, frozen, hlcMax)
    await this.env.fs.writeAtomic(`${this.dir}/snapshot.json`,
      new TextEncoder().encode(JSON.stringify(snap) + '\n'))
    return { lastSegment: frozen }
  }
}
