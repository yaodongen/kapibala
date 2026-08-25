const { execFileSync } = require('node:child_process')

/**
 * electron-builder 的 ad-hoc 签名（identity: "-"）只是走了个流程，并不会重新封装 bundle。
 * 而我们改过 Info.plist、图标、还塞了 asar，封装因此是坏的 ——
 * codesign --verify 会报 "code has no resources but signature indicates they must be present"，
 * 用户从网上下载后 Gatekeeper 直接报「已损坏，应该移到废纸篓」，连"仍要打开"都没有。
 *
 * 所以在 dmg 生成之前自己深度重签一次。有真证书时（CSC_LINK / CSC_NAME）跳过，
 * 交给 electron-builder 正常签名与公证。
 */
module.exports = async (context) => {
  if (process.env.CSC_LINK || process.env.CSC_NAME) return
  const app = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
  // 必须带上 --options runtime 和 entitlements：不带的话这次重签会把 electron-builder
  // 加的 hardened runtime 与 entitlements 一起抹掉，问题要等到公证那天才暴露。
  const ent = `${context.packager.info.projectDir}/build/entitlements.mac.plist`
  execFileSync('codesign', ['--force', '--deep', '--sign', '-',
                            '--options', 'runtime', '--entitlements', ent, app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log('  • ad-hoc 重签完成，封装有效')
}
