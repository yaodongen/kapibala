import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 退出码是给脚本用的契约（`kapi typo && …` 不该被当成成功），所以真起一个进程验，
 * 不测内部函数。每一步都指到空的状态目录，绝不碰本机真实的库列表。
 */
const CLI = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const run = promisify(execFile)
let ud = ''

beforeAll(async () => { ud = await mkdtemp(join(tmpdir(), 'kapi-cli-test-')) })
afterAll(async () => { await rm(ud, { recursive: true, force: true }) })

async function kapi(args: string[]) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, KAPIBALA_USER_DATA: ud, NO_COLOR: '1' },
    })
    return { code: 0, stdout, stderr }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

describe('退出码', () => {
  it('看帮助算成功：--help、help、什么都不给、光说 vault', async () => {
    for (const args of [['--help'], ['help'], [], ['vault']]) {
      const r = await kapi(args)
      expect(r.code, args.join(' ')).toBe(0)
      expect(r.stdout, args.join(' ')).toContain('kapi')
    }
  })

  it('不认识的命令：打一遍帮助，退出码 1', async () => {
    const r = await kapi(['nope'])
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('未知命令：nope')
    expect(r.stdout).toContain('kapi add')          // 帮助照给，不然用户不知道下一步
  })

  it('不认识的 vault 子命令同样是 1', async () => {
    const r = await kapi(['vault', 'nope'])
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('未知子命令：vault nope')
  })

  it('真的出错：信息进 stderr，退出码 1', async () => {
    const r = await kapi(['today'])                 // 空状态目录 = 还没有库
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('还没有库')
    expect(r.stdout).toBe('')
  })
})
