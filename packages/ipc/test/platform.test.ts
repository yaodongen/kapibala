import { describe, expect, it } from 'vitest'
import { platformOf } from '../src/index.ts'

describe('平台判定', () => {
  it('只认这两个平台，其余一律 other', () => {
    expect(platformOf('darwin')).toBe('darwin')
    expect(platformOf('win32')).toBe('win32')
    expect(platformOf('linux')).toBe('other')
    expect(platformOf('freebsd')).toBe('other')
    expect(platformOf(undefined)).toBe('other')
  })

  it('开发期开关能盖过真实平台 —— 这是"在 Mac 上跑 Windows 分支"的唯一入口', () => {
    expect(platformOf('darwin', 'win32')).toBe('win32')
    expect(platformOf('win32', 'darwin')).toBe('darwin')
    expect(platformOf('darwin', undefined)).toBe('darwin')
    // 认不出来的值不生效，免得手抖写错一个环境变量就把平台判成 other
    expect(platformOf('darwin', 'windows')).toBe('darwin')
  })

  it('传进去的是主进程那份判定，preload 只做映射 —— 两边不会各判一次', () => {
    // preload 拿到的 forced 来自 PLATFORM_ARG，值本来就是上面这几个字面量
    expect(platformOf('linux', 'win32')).toBe('win32')
  })
})
