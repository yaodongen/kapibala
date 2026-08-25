// 三个 bundle：主进程、preload、渲染进程。不用 electron-vite —— 这一步只要能跑起来
import { build } from 'esbuild'
import { cp, mkdir } from 'node:fs/promises'

const common = { bundle: true, sourcemap: true, logLevel: 'info' }
await mkdir('dist', { recursive: true })

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs',
              platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' })
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs',
              platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' })
await build({ ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js',
              platform: 'browser', format: 'iife', target: 'safari18' })
await cp('src/renderer/index.html', 'dist/renderer/index.html')
