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
// Windows 托盘的图标。主进程按 __dirname 找它，所以必须落在 dist 里（打包时跟着 asar 一起进去）
await mkdir('dist/assets', { recursive: true })
await cp('assets/tray.png', 'dist/assets/tray.png')
