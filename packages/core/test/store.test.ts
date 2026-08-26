import { describe, expect, it } from 'vitest'
import { Store } from '../src/store.ts'
import { MemFs, memEnv } from '../src/testing.ts'
import { parseSegment } from '../src/log.ts'
import { NOT_DOWNLOADED, openVault } from '../src/vault.ts'

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

  it('重开之后也不会再冒出来', async () => {
    const { fs, a, s } = await setup()
    const id = await s.add({ title: '别再回来' })
    await s.trash(id); await s.purge(id)
    const again = await Store.open(memEnv({ fs, machineId: 'MACHINE-A', userDataDir: '/ua' }), V)
    expect(again.tasks().some(t => t.id === id)).toBe(false)
  })
})
