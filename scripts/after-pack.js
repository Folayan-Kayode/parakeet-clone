const path = require('node:path')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context
  const exe = path.join(appOutDir, `${packager.appInfo.productFilename}.exe`)
  await flipFuses(exe, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true
  })
  console.log(`[fuses] hardened ${exe}`)
}
