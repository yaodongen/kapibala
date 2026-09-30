import { describe, expect, it } from 'vitest'
import { Store } from '../src/store.ts'
import { MemFs, MemClock, memEnv } from '../src/testing.ts'
import { parseSegment } from '../src/log.ts'
import { NOT_DOWNLOADED, openVault } from '../src/vault.ts'
import { legacyOccurrenceId } from '../src/repeat.ts'

const V = '/vault'
const setup = async () => {
  const fs = new MemFs()
  const a = memEnv({ fs, machineId: 'MACHINE-A', userDataDir: '/ua', label: 'Mac A' })
  const s = await Store.open(a, V, true)
  return { fs, a, s }
}

describe('单机基本功能', () => {
  it('建库时写下 meta.json 和自己的设备目录', async () => {
    const { fs, s } = await setup()
    const meta = JSON.parse(new TextDecoder().decode(fs.files.get(`${V}/.kapibala/meta.json`)!))
    expect(meta.appId).toBe('kapibala')
    expect(meta.schema).toBe(1)
    expect(fs.files.has(`${V}/devices/${s.vault.device.deviceId}/owner.json`)).toBe(true)
  })

  it('增删改查、完成、取消完成、垃圾桶', async () => {
    const { s } = await setup()
    const id = await s.add({ title: '买菜', startAt: 1000 })
    expect(s.task(id)!.title).toBe('买菜')

    await s.setField(id, 'title', '买菜、水果')
    expect(s.task(id)!.title).toBe('买菜、水果')

    await s.complete(id)
    expect(s.task(id)!.completedAt).toBeGreaterThan(0)
    await s.uncomplete(id)
    expect(s.task(id)!.completedAt).toBeUndefined()

    await s.trash(id)
    expect(s.task(id)!.deleted).toBe(true)
    await s.restore(id)
    expect(s.task(id)!.deleted).toBe(false)
  })

  it('删除是 tombstone，不物理删除', async () => {
    const { fs, s } = await setup()
    const id = await s.add({ title: '临时' })
    await s.trash(id)
    await s.purge(id)
    const seg = [...fs.files.entries()].find(([k]) => k.endsWith('000001.jsonl'))![1]
    const { ops } = parseSegment(seg)
    expect(ops.some(o => o.f === '_deleted' && o.val === true)).toBe(true)
    expect(ops.some(o => o.f === '_purgedAt')).toBe(true)
    expect(ops.some(o => o.f === 'title' && o.val === '临时')).toBe(true)  // 原始数据还在
  })

  it('重启后从日志恢复', async () => {
    const { fs, a } = await setup()
    const s1 = await Store.open(a, V)
    await s1.add({ title: '会持久化' })
    const s2 = await Store.open(memEnv({ fs, machineId: 'MACHINE-A', userDataDir: '/ua' }), V)
    expect(s2.tasks().map(t => t.title)).toContain('会持久化')
  })
})

describe('周期任务', () => {
  it('完成后生成下一次', async () => {
    const { s } = await setup()
    const start = +new Date('2026-08-25T09:00:00')
    const id = await s.add({ title: '水豚周会', startAt: start, repeat: { freq: 'WEEKLY' } })
    const next = await s.complete(id)
    expect(next).not.toBeNull()
    expect(new Date(next!.startAt!).getDate()).toBe(new Date(start + 7 * 86400000).getDate())
    expect(next!.seriesId).toBe(id)
  })

  it('两台 Mac 离线各完成同一次，合并后只有一个下一次实例', async () => {
    const fs = new MemFs()
    const envA = memEnv({ fs, machineId: 'MACHINE-A', userDataDir: '/ua' })
    const envB = memEnv({ fs, machineId: 'MACHINE-B', userDataDir: '/ub' })
    const a = await Store.open(envA, V, true)
    const id = await a.add({ title: '吃药', startAt: +new Date('2026-08-25T21:00:00'), repeat: { freq: 'DAILY' } })

    const b = await Store.open(envB, V)          // B 同步到了这个任务
    await a.complete(id)                          // 两边各自完成
    await b.complete(id)

    await a.refresh()
    const series = a.tasks().filter(t => t.seriesId === id)
    expect(series).toHaveLength(1)                // 确定性 ID → 不会分叉
  })

  it('重要的周期任务，派生出来的下一次也重要（一路传下去）', async () => {
    const { s } = await setup()
    const id = await s.add({ title: '体检', startAt: +new Date('2026-08-25T09:00:00'), repeat: { freq: 'WEEKLY' } })
    await s.setField(id, 'important', true)

    const next = await s.complete(id)
    expect(next!.important).toBe(true)            // 第一个派生实例继承

    const third = await s.complete(next!.id)
    expect(third!.important).toBe(true)           // 再派生一次，仍然带着
  })

  it('不重要的周期任务，派生出来的一次也不重要', async () => {
    const { s } = await setup()
    const id = await s.add({ title: '周会', startAt: +new Date('2026-08-25T09:00:00'), repeat: { freq: 'WEEKLY' } })
    const next = await s.complete(id)
    expect(next!.important).toBe(false)
  })

  /**
   * 真实踩到过的那条：把派生出来的某一期从原定日期**拖回早先的日期**，再完成。
   * 旧写法按"系列 + 日期"派生 ID，往后推就又落回自己占着的那个 ID，于是静默写不出来
   * —— 勾了完成什么都不出现，系列从此断掉。现在 ID 链在上一期上，日期只决定排在哪天。
   */
  it('派生出来的那一期被拖回早先的日期后再完成，照样派得出下一期', async () => {
    const { s } = await setup()
    const first = await s.add({ title: '每2天读书 20 分钟', startAt: +new Date('2026-09-26T00:00:00'), repeat: { rrule: 'FREQ=DAILY;INTERVAL=2' } })

    const sep28 = (await s.complete(first))!        // 9/28 那一期
    expect(new Date(sep28.startAt!).getDate()).toBe(28)

    const sep30 = (await s.complete(sep28.id))!     // 9/30 那一期
    expect(new Date(sep30.startAt!).getDate()).toBe(30)

    // 把它拖回 9/28（真实库里就是这么拖的），再完成
    await s.setMany([
      { id: sep30.id, f: 'startAt', val: +new Date('2026-09-28T00:00:00') },
      { id: sep30.id, f: 'order', val: '0000l' },
    ])
    const next = await s.complete(sep30.id)

    expect(next).not.toBeNull()
    expect(next!.seriesId).toBe(first)
    // 下一期 = 这一期的日期 + 2 天，而且是一条**全新**的实例（不是那两个老 ID）
    expect(new Date(next!.startAt!).toDateString()).toBe(new Date('2026-09-30T00:00:00').toDateString())
    expect(next!.id).not.toBe(sep28.id)
    expect(next!.id).not.toBe(sep30.id)
    // 已完成的那两期不能被改坏
    expect(new Date(s.task(sep28.id)!.startAt!).toDateString()).toBe(new Date('2026-09-28T00:00:00').toDateString())
    expect(new Date(s.task(sep30.id)!.startAt!).toDateString()).toBe(new Date('2026-09-28T00:00:00').toDateString())
    expect(s.task(sep30.id)!.completedAt).toBeGreaterThan(0)
  })

  it('同一天可以排下多条：那天已经有一条，也不影响新派生一条', async () => {
    const { s } = await setup()
    const first = await s.add({ title: '读书', startAt: +new Date('2026-09-28T00:00:00'), repeat: { rrule: 'FREQ=DAILY;INTERVAL=2' } })
    await s.add({ title: '另外一条读书安排', startAt: +new Date('2026-09-30T00:00:00') })   // 手动排在同一天

    const next = await s.complete(first)
    expect(new Date(next!.startAt!).toDateString()).toBe(new Date('2026-09-30T00:00:00').toDateString())
    const thatDay = s.tasks().filter(t => new Date(t.startAt!).toDateString() === new Date('2026-09-30T00:00:00').toDateString())
    expect(thatDay).toHaveLength(2)
  })

  it('槽位上有待做的那一期时不重复派生（同一期勾两次）', async () => {
    const { s } = await setup()
    const id = await s.add({ title: '吃药', startAt: +new Date('2026-08-25T21:00:00'), repeat: { rrule: 'FREQ=DAILY' } })
    const next = (await s.complete(id))!
    await s.uncomplete(id)
    const again = await s.complete(id)
    expect(again!.id).toBe(next.id)
    expect(s.tasks().filter(t => t.seriesId === id)).toHaveLength(1)
  })

  /** 用户的例子：9/28 那期拖到 9/26，9/30 才点完成 —— 下一期还是"9/26 + 2 天"。 */
  it('把这一期拖到早先的日子再完成，下一期仍按这一期的日期 + 周期算，不看完成时刻', async () => {
    const fs = new MemFs()
    const clock = new MemClock()
    const s = await Store.open(memEnv({ fs, machineId: 'MACHINE-A', userDataDir: '/ua', clock }), V, true)
    const id = await s.add({
      title: '读书 20 分钟',
      startAt: +new Date('2026-09-29T00:00:00'), repeat: { rrule: 'FREQ=DAILY;INTERVAL=2' },
    })
    await s.setField(id, 'startAt', +new Date('2026-09-26T00:00:00'))   // 拖到 9/26
    clock.set(+new Date('2026-09-30T15:00:00'))                         // 拖完四天才点完成

    const next = await s.complete(id)
    expect(new Date(next!.startAt!).toDateString()).toBe(new Date('2026-09-28T00:00:00').toDateString())
  })

  it('一律按原计划：落下的那一期照样补出来（可能显示成逾期）', async () => {
    const fs = new MemFs()
    const clock = new MemClock(+new Date('2026-09-30T10:00:00'))
    const s = await Store.open(memEnv({ fs, machineId: 'MACHINE-A', userDataDir: '/ua', clock }), V, true)
    const id = await s.add({
      title: '每天一篇 checklist',
      startAt: +new Date('2026-09-26T00:00:00'), repeat: { rrule: 'FREQ=DAILY' },
    })
    const next = await s.complete(id)
    // 计划里的下一期是 9/27，哪怕已经过期也给 —— 不再从完成那天重排
    expect(new Date(next!.startAt!).toDateString()).toBe(new Date('2026-09-27T00:00:00').toDateString())
  })

  it('被删掉的那一期：跳过它，从它接着往后推一期', async () => {
    const { s } = await setup()
    const id = await s.add({ title: '读书', startAt: +new Date('2026-08-26T00:00:00'), repeat: { rrule: 'FREQ=DAILY;INTERVAL=2' } })
    const aug28 = (await s.complete(id))!
    await s.trash(aug28.id)
    await s.uncomplete(id)
    const next = await s.complete(id)
    expect(next).not.toBeNull()
    expect(new Date(next!.startAt!).getDate()).toBe(30)      // 8/28 那次跳过，8/30 那次
    expect(s.task(aug28.id)!.deleted).toBe(true)             // 删掉的还是删掉的
  })

  it('被清空垃圾桶的那一期：同样跳过，系列不断', async () => {
    const { s } = await setup()
    const id = await s.add({ title: '读书', startAt: +new Date('2026-08-26T00:00:00'), repeat: { rrule: 'FREQ=DAILY;INTERVAL=2' } })
    const aug28 = (await s.complete(id))!
    await s.trash(aug28.id)
    await s.purgeAll()
    await s.uncomplete(id)
    const next = await s.complete(id)
    expect(next).not.toBeNull()
    expect(new Date(next!.startAt!).getDate()).toBe(30)
    expect(s.task(aug28.id)).toBeUndefined()                 // 已清空的不该回来
  })

  /**
   * 造一个"被旧代码写坏"的系列：最新那一期拖回早先日期之后直接写 completedAt
   * （＝旧代码那次静默跳过的完成），下一期根本没被写出来 —— 链在这里断掉。
   */
  async function brokenSeries(s: Store) {
    const first = await s.add({
      title: '每2天读书 20 分钟',
      startAt: +new Date('2026-09-26T00:00:00'), repeat: { rrule: 'FREQ=DAILY;INTERVAL=2' },
    })
    await s.setField(first, 'important', true)
    const sep28 = (await s.complete(first))!
    const sep30 = (await s.complete(sep28.id))!
    await s.setMany([{ id: sep30.id, f: 'startAt', val: +new Date('2026-09-28T00:00:00') }])
    await s.setField(sep30.id, 'completedAt', +new Date('2026-09-28T16:21:43'))   // 旧代码：静默跳过
    return { first, sep28, sep30 }
  }

  it('打开时自愈：链条断掉的系列，把缺的那一期补上', async () => {
    const { s } = await setup()
    const { first, sep30 } = await brokenSeries(s)
    expect(s.tasks().some(t => t.seriesId === first && t.completedAt === undefined)).toBe(false)

    expect(await s.healSeries()).toBe(1)
    const pending = s.tasks().filter(t => t.seriesId === first && t.completedAt === undefined)
    expect(pending).toHaveLength(1)
    // 最新那期在 9/28（拖过去的），它的下一期就是 9/30
    expect(new Date(pending[0]!.startAt!).toDateString()).toBe(new Date('2026-09-30T00:00:00').toDateString())
    expect(pending[0]!.important).toBe(true)                 // 重要照样一路传下去
    expect(new Date(s.task(sep30.id)!.startAt!).toDateString()).toBe(new Date('2026-09-28T00:00:00').toDateString())

    expect(await s.healSeries()).toBe(0)                     // 幂等，再打开一次不再补
  })

  it('打开时自愈：下一期被删过就不补（系列停在用户删它的地方）', async () => {
    const { s } = await setup()
    const { sep28, sep30 } = await brokenSeries(s)
    await s.trash(sep30.id)                                  // 用户把 sep28 的下一期删了
    expect(await s.healSeries()).toBe(0)
    expect(s.task(sep30.id)!.deleted).toBe(true)
    expect(s.task(sep28.id)!.completedAt).toBeGreaterThan(0)
  })

  it('打开时自愈：老库按日期派生的那一期被删过，也不补（认得出它就躺在那个 ID 上）', async () => {
    const { s } = await setup()
    const first = await s.add({
      title: '每2天读书 20 分钟',
      startAt: +new Date('2026-09-26T00:00:00'), repeat: { rrule: 'FREQ=DAILY;INTERVAL=2' },
    })
    await s.setField(first, 'completedAt', +new Date('2026-09-26T11:37:00'))
    // 老方案写下的下一期：ID = (系列, 2026-09-28)
    const legacy = legacyOccurrenceId(first, +new Date('2026-09-28T00:00:00'))
    await s.add({
      id: legacy, seriesId: first, title: '每2天读书 20 分钟',
      startAt: +new Date('2026-09-28T00:00:00'), repeat: { rrule: 'FREQ=DAILY;INTERVAL=2' },
    })
    await s.trash(legacy)                                    // 用户把它删了

    expect(await s.healSeries()).toBe(0)
    expect(s.task(legacy)!.deleted).toBe(true)
    expect(s.tasks().filter(t => !t.deleted && (t.seriesId ?? t.id) === first)).toHaveLength(1)
  })

  it('打开时自愈：健康的系列（已经有待做的下一期）不动', async () => {
    const { s } = await setup()
    const id = await s.add({ title: '周会', startAt: +new Date('2026-08-25T09:00:00'), repeat: { freq: 'WEEKLY' } })
    const next = (await s.complete(id))!
    expect(await s.healSeries()).toBe(0)
    expect(s.tasks().filter(t => t.seriesId === id)).toHaveLength(1)
    expect(s.task(next.id)!.completedAt).toBeUndefined()
  })

  it('打开时自愈：两台 Mac 各自补一次，合并后只有一期', async () => {
    const fs = new MemFs()
    const a = await Store.open(memEnv({ fs, machineId: 'MACHINE-A', userDataDir: '/ua' }), V, true)
    const b = await Store.open(memEnv({ fs, machineId: 'MACHINE-B', userDataDir: '/ub' }), V)
    const { first } = await brokenSeries(a)

    await a.healSeries()
    await b.healSeries()                                     // B 还没看到 A 的补写，也补了一次
    await a.refresh()
    expect(a.tasks().filter(t => t.seriesId === first && t.completedAt === undefined)).toHaveLength(1)
  })
})

describe('重要', () => {
  it('标记、取消标记；没标记过的默认不重要（旧数据也一样）', async () => {
    const { s } = await setup()
    const id = await s.add({ title: '交房租' })
    expect(s.task(id)!.important).toBe(false)

    await s.setField(id, 'important', true)
    expect(s.task(id)!.important).toBe(true)

    await s.setField(id, 'important', false)
    expect(s.task(id)!.important).toBe(false)
  })

  it('删进垃圾桶、再恢复，重要的标记都留着', async () => {
    const { s } = await setup()
    const id = await s.add({ title: '交房租' })
    await s.setField(id, 'important', true)
    await s.trash(id)
    expect(s.task(id)!.important).toBe(true)
    await s.restore(id)
    expect(s.task(id)!.important).toBe(true)
  })

  it('多设备合并：跟着字段级 LWW 走', async () => {
    const fs = new MemFs()
    const a = await Store.open(memEnv({ fs, machineId: 'MACHINE-A', userDataDir: '/ua' }), V, true)
    const id = await a.add({ title: '交房租' })
    const b = await Store.open(memEnv({ fs, machineId: 'MACHINE-B', userDataDir: '/ub' }), V)

    await a.setField(id, 'important', true)
    await b.refresh()
    expect(b.task(id)!.important).toBe(true)
  })
})

describe('进行中', () => {
  it('标记和取消标记', async () => {
    const { s } = await setup()
    const id = await s.add({ title: '写方案' })
    expect(s.task(id)!.inProgress).toBe(false)      // 建出来默认不在进行中

    await s.setField(id, 'inProgress', true)
    expect(s.task(id)!.inProgress).toBe(true)

    await s.setField(id, 'inProgress', false)
    expect(s.task(id)!.inProgress).toBe(false)
  })

  it('同时可以有好几条进行中', async () => {
    const { s } = await setup()
    const a = await s.add({ title: '一' })
    const b = await s.add({ title: '二' })
    await s.setField(a, 'inProgress', true)
    await s.setField(b, 'inProgress', true)
    expect(s.tasks().filter(t => t.inProgress)).toHaveLength(2)
  })

  it('完成后自动清掉进行中的标记', async () => {
    const { s } = await setup()
    const id = await s.add({ title: '写方案' })
    await s.setField(id, 'inProgress', true)
    await s.complete(id)
    expect(s.task(id)!.completedAt).toBeGreaterThan(0)
    expect(s.task(id)!.inProgress).toBe(false)
  })

  it('删进垃圾桶时自动清掉进行中的标记，恢复后也不会自己回来', async () => {
    const { s } = await setup()
    const id = await s.add({ title: '写方案' })
    await s.setField(id, 'inProgress', true)
    await s.trash(id)
    expect(s.task(id)!.inProgress).toBe(false)
    await s.restore(id)
    expect(s.task(id)!.inProgress).toBe(false)
  })

  it('多设备合并：进行中的标记跟着字段级 LWW 走', async () => {
    const fs = new MemFs()
    const a = await Store.open(memEnv({ fs, machineId: 'MACHINE-A', userDataDir: '/ua' }), V, true)
    const id = await a.add({ title: '写方案' })
    const b = await Store.open(memEnv({ fs, machineId: 'MACHINE-B', userDataDir: '/ub' }), V)

    await a.setField(id, 'inProgress', true)      // A 开始做
    await b.refresh()
    expect(b.task(id)!.inProgress).toBe(true)

    await a.refresh()
    expect(a.task(id)!.inProgress).toBe(true)
  })
})

describe('多设备合并', () => {
  it('各写各的目录，改动都能看到', async () => {
    const fs = new MemFs()
    const a = await Store.open(memEnv({ fs, machineId: 'MACHINE-A', userDataDir: '/ua' }), V, true)
    const b = await Store.open(memEnv({ fs, machineId: 'MACHINE-B', userDataDir: '/ub' }), V)
    expect(a.vault.device.deviceId).not.toBe(b.vault.device.deviceId)

    const id = await a.add({ title: 'A 建的' })
    await b.refresh()
    expect(b.task(id)!.title).toBe('A 建的')

    await b.complete(id)
    await a.refresh()
    expect(a.task(id)!.completedAt).toBeGreaterThan(0)
  })

  it('字段级 LWW：A 改标题、B 改时间，两个改动都保留', async () => {
    const fs = new MemFs()
    const a = await Store.open(memEnv({ fs, machineId: 'MACHINE-A', userDataDir: '/ua' }), V, true)
    const id = await a.add({ title: '原标题' })
    const b = await Store.open(memEnv({ fs, machineId: 'MACHINE-B', userDataDir: '/ub' }), V)

    await a.setField(id, 'title', '新标题')
    await b.setField(id, 'startAt', 777)

    await a.refresh(); await b.refresh()
    for (const s of [a, b]) {
      expect(s.task(id)!.title).toBe('新标题')
      expect(s.task(id)!.startAt).toBe(777)
    }
  })

  it('库目录被整机迁移复制：令牌相同但机器不同 → 换新设备身份，旧历史不被污染', async () => {
    const fs = new MemFs()
    const a = await Store.open(memEnv({ fs, machineId: 'MACHINE-A', userDataDir: '/ua' }), V, true)
    await a.add({ title: 'A 的历史' })
    // 迁移助理把 userData 一起搬走了：注册表内容完全相同，只有机器变了
    fs.files.set('/ub/vaults.json', fs.files.get('/ua/vaults.json')!)
    const envB = memEnv({ fs, machineId: 'MACHINE-B', userDataDir: '/ub' })
    const opened = await openVault(envB, V)
    expect(opened.forked).toBe(true)
    expect(opened.device.deviceId).not.toBe(a.vault.device.deviceId)

    const b = await Store.open(envB, V)
    expect(b.tasks().map(t => t.title)).toContain('A 的历史')   // 旧历史照样读得到
  })
})

describe('容错', () => {
  it('中间有坏行也能启动，只跳过坏行', async () => {
    const { fs, a, s } = await setup()
    const id = await s.add({ title: '好任务' })
    const key = `${V}/devices/${s.vault.device.deviceId}/000001.jsonl`
    const text = new TextDecoder().decode(fs.files.get(key)!)
    fs.files.set(key, new TextEncoder().encode(text + '{ 这不是 JSON\n'))
    const s2 = await Store.open(a, V)
    expect(s2.tasks().map(t => t.title)).toContain('好任务')
    expect(s2.health.badLines).toBe(1)
  })

  it('写入中途崩溃：只丢最后一行未写完的', async () => {
    const { fs, a, s } = await setup()
    await s.add({ title: '第一条' })
    const key = `${V}/devices/${s.vault.device.deviceId}/000001.jsonl`
    const text = new TextDecoder().decode(fs.files.get(key)!)
    fs.files.set(key, new TextEncoder().encode(text + '{"v":1,"hlc":"000'))
    const s2 = await Store.open(a, V)
    expect(s2.tasks().map(t => t.title)).toContain('第一条')
    expect(s2.health.droppedTail).toBe(true)
  })

  it('某台设备的文件读不出来 → 如实报告历史不完整，不当成空', async () => {
    const { fs, a, s } = await setup()
    await s.add({ title: '会读失败' })
    fs.failOn = /000001\.jsonl$/
    const s2 = await Store.open(a, V)
    expect(s2.health.incomplete).toBe(true)
  })
})

describe('压实', () => {
  it('压实后重新打开，状态不变；段文件仍然保留', async () => {
    const { fs, a, s } = await setup()
    const id = await s.add({ title: '版本一' })
    await s.setField(id, 'title', '版本二')
    await s.setField(id, 'title', '版本三')
    const before = s.tasks()

    const r = await s.compact()
    expect(r!.lastSegment).toBe(1)
    const dir = `${V}/devices/${s.vault.device.deviceId}`
    expect(fs.files.has(`${dir}/snapshot.json`)).toBe(true)
    expect(fs.files.has(`${dir}/000001.jsonl`)).toBe(true)      // 永不删除

    const s2 = await Store.open(a, V)
    expect(s2.tasks()).toEqual(before)

    // 压实后继续写，新 op 落在新段里，不会被 snapshot 跳过
    await s2.setField(id, 'title', '版本四')
    const s3 = await Store.open(a, V)
    expect(s3.task(id)!.title).toBe('版本四')
  })
})

describe('建库时的目录判定', () => {
  it('只有 .DS_Store 之类的系统垃圾时，仍然算空目录', async () => {
    const fs = new MemFs()
    const env = memEnv({ fs })
    await fs.writeAtomic(`${V}/.DS_Store`, new Uint8Array([1]))
    await fs.writeAtomic(`${V}/.localized`, new Uint8Array())
    await fs.writeAtomic(`${V}/.000001.jsonl.icloud`, new Uint8Array())   // iCloud 占位符
    const s = await Store.open(env, V, true)
    expect(s.vault.meta.appId).toBe('kapibala')
  })

  it('真有别的文件时拒绝建库，并说清楚该怎么办', async () => {
    const fs = new MemFs()
    await fs.writeAtomic(`${V}/我的简历.docx`, new Uint8Array([1]))
    await expect(Store.open(memEnv({ fs }), V, true)).rejects.toThrow(/换一个空文件夹/)
  })

  it('已经是库的目录，用 create 打开也不会报错', async () => {
    const fs = new MemFs()
    const env = memEnv({ fs })
    await Store.open(env, V, true)
    const again = await Store.open(env, V, true)
    expect(again.vault.forked).toBe(false)
  })
})

describe('第二台 Mac：库文件还是 iCloud 占位符', () => {
  const placeholderVault = async () => {
    const fs = new MemFs()
    const a = memEnv({ fs, machineId: 'MACHINE-A', userDataDir: '/ua' })
    const s = await Store.open(a, V, true)
    await s.add({ title: 'Mac A 写的' })
    // iCloud 驱逐：真实文件换成 .原名.icloud
    for (const [k, v] of [...fs.files]) {
      if (k.startsWith(V)) {
        const i = k.lastIndexOf('/')
        fs.files.delete(k)
        fs.files.set(`${k.slice(0, i)}/.${k.slice(i + 1)}.icloud`, v)
      }
    }
    return fs
  }

  it('报"还在下载"而不是"不是一个库" —— 这两件事不能混', async () => {
    const fs = await placeholderVault()
    const b = memEnv({ fs, machineId: 'MACHINE-B', userDataDir: '/ub' })
    await expect(openVault(b, V)).rejects.toMatchObject({ code: NOT_DOWNLOADED })
  })

  it('文件落地之后就能正常打开，读到对面的任务', async () => {
    const fs = await placeholderVault()
    for (const [k, v] of [...fs.files]) {          // iCloud 下载完成
      const m = /^(.*)\/\.(.+)\.icloud$/.exec(k)
      if (m) { fs.files.delete(k); fs.files.set(`${m[1]}/${m[2]}`, v) }
    }
    const b = await Store.open(memEnv({ fs, machineId: 'MACHINE-B', userDataDir: '/ub' }), V)
    expect(b.tasks().map(t => t.title)).toContain('Mac A 写的')
  })
})

describe('彻底删除', () => {
  it('purge 之后任务列表里就没有它了', async () => {
    const { s } = await setup()
    const id = await s.add({ title: '要彻底删掉的' })
    await s.trash(id)
    expect(s.tasks().some(t => t.id === id)).toBe(true)     // 在垃圾桶里还看得到
    await s.purge(id)
    expect(s.tasks().some(t => t.id === id)).toBe(false)    // 彻底删除后就看不到了
  })

  it('但磁盘上并没有真删 —— 真删在分布式下会导致数据复活', async () => {
    const { fs, s } = await setup()
    const id = await s.add({ title: '仍在日志里' })
    await s.trash(id); await s.purge(id)
    const seg = [...fs.files.entries()].find(([k]) => k.endsWith('000001.jsonl'))![1]
    const { ops } = parseSegment(seg)
    expect(ops.some(o => o.f === 'title' && o.val === '仍在日志里')).toBe(true)
    expect(ops.some(o => o.f === '_purgedAt')).toBe(true)
  })

  it('清空垃圾桶：垃圾桶里的都清掉，没删的一条不动', async () => {
    const { s } = await setup()
    const a1 = await s.add({ title: '扔了一' })
    const a2 = await s.add({ title: '扔了二' })
    const keep = await s.add({ title: '还在用' })
    const doneTask = await s.add({ title: '已完成的' })
    await s.complete(doneTask)
    await s.trash(a1); await s.trash(a2)

    expect(await s.purgeAll()).toBe(2)
    const left = s.tasks().map(t => t.title).sort()
    expect(left).toEqual(['已完成的', '还在用'])
    expect(s.tasks().some(t => t.deleted)).toBe(false)
    // 已经清空了，再清一次没有东西可清 —— 不能给同一条反复写标记
    expect(await s.purgeAll()).toBe(0)
    expect(keep).toBeTruthy()
  })

  it('清空垃圾桶只写一批 op，不是一条一次追加', async () => {
    const { fs, s } = await setup()
    for (const t of ['一', '二', '三']) await s.trash(await s.add({ title: t }))
    const before = [...fs.files.entries()].find(([k]) => k.endsWith('000001.jsonl'))![1].length
    await s.purgeAll()
    const seg = [...fs.files.entries()].find(([k]) => k.endsWith('000001.jsonl'))![1]
    const { ops } = parseSegment(seg)
    const marks = ops.filter(o => o.f === '_purgedAt')
    expect(marks).toHaveLength(3)
    // 同一批写入 = 同一毫秒的时间戳，且都在 before 之后追加上去的
    expect(new Set(marks.map(o => o.val)).size).toBe(1)
    expect(seg.length).toBeGreaterThan(before)
  })

  it('重开之后也不会再冒出来', async () => {
    const { fs, a, s } = await setup()
    const id = await s.add({ title: '别再回来' })
    await s.trash(id); await s.purge(id)
    const again = await Store.open(memEnv({ fs, machineId: 'MACHINE-A', userDataDir: '/ua' }), V)
    expect(again.tasks().some(t => t.id === id)).toBe(false)
  })
})
