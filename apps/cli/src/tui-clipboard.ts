/** Read a PNG from the desktop that owns the terminal process. */

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Maximum number of clipboard image bytes retained before sending a prompt. */
export const clipboardImageLimit = 50 * 1024 * 1024

const windowsImage = `
$ErrorActionPreference = 'Stop'
$image = Get-Clipboard -Format Image
if ($null -eq $image) { exit 3 }
$buffer = New-Object System.IO.MemoryStream
try {
  $image.Save($buffer, [System.Drawing.Imaging.ImageFormat]::Png)
  $buffer.WriteTo([Console]::OpenStandardOutput())
} finally {
  $buffer.Dispose()
  $image.Dispose()
}
`

interface Reader {
  readonly file: string
  readonly args: string[]
  readonly empty: number
}

function readers(): Reader[] {
  if (process.platform === 'win32') {
    return [{
      file: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-Command', windowsImage],
      empty: 3,
    }]
  }
  if (process.platform === 'darwin') {
    return ['/opt/homebrew/bin/pngpaste', '/usr/local/bin/pngpaste', '/opt/local/bin/pngpaste']
      .map(file => ({ file, args: ['-'], empty: 1 }))
  }
  const candidates: Reader[] = []
  if (process.env.WAYLAND_DISPLAY) {
    candidates.push({ file: '/usr/bin/wl-paste', args: ['--no-newline', '--type', 'image/png'], empty: 1 })
  }
  if (process.env.DISPLAY) {
    candidates.push({ file: '/usr/bin/xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'], empty: 1 })
  }
  return candidates
}

/**
 * @param signal - cancellation of the terminal application.
 * @returns a bounded PNG Blob, or undefined if the clipboard has no image.
 */
export async function readClipboardImage(signal: AbortSignal): Promise<Blob | undefined> {
  let foundReader = false
  for (const reader of readers()) {
    try {
      const { stdout } = await exec(reader.file, reader.args, {
        signal, timeout: 5_000, maxBuffer: clipboardImageLimit, encoding: 'buffer', windowsHide: true,
      })
      if (stdout.length !== 0) return new Blob([new Uint8Array(stdout)], { type: 'image/png' })
      foundReader = true
    } catch (error) {
      signal.throwIfAborted()
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') continue
      if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('剪贴板图片超过 50 MiB')
      if (code !== reader.empty) throw new Error('读取剪贴板图片失败')
      foundReader = true
    }
  }
  if (!foundReader) throw new Error('当前终端无法读取图片剪贴板。可以在桌面终端运行 TUI，或用 /image 添加文件')
  return undefined
}
