#!/usr/bin/env node

if (import.meta.main) {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  if (major < 24 || (major === 24 && minor < 9)) {
    process.stderr.write(`dsh-cli 需要 Node.js 24.9 或更新版本。当前终端使用 ${process.version}\n`)
    process.exitCode = 1
  } else {
    try {
      const { runCli } = await import('./bin.ts')
      await runCli({ commandName: 'dsh-cli' })
    } catch (error) {
      process.stderr.write(`dsh-cli: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    }
  }
}
