/** Host logs must join the scrollback above the prompt instead of painting over it. */
import { Console } from 'node:console'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalScreen } from '../src/tui-screen.ts'

describe('TerminalScreen host logs', () => {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  let screen: TerminalScreen | undefined
  let addedRawMode = false

  afterEach(() => {
    try { screen?.stop() }
    finally {
      screen = undefined
      stdoutChunks.length = 0
      stderrChunks.length = 0
      vi.restoreAllMocks()
      if (addedRawMode) {
        Reflect.deleteProperty(process.stdin, 'setRawMode')
        addedRawMode = false
      }
    }
  })

  function textOf(chunk: string | Uint8Array): string {
    return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  }

  function boot(): TerminalScreen {
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(textOf(chunk))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(textOf(chunk))
      return true
    })
    if (typeof process.stdin.setRawMode !== 'function') {
      process.stdin.setRawMode = () => process.stdin
      addedRawMode = true
    } else {
      vi.spyOn(process.stdin, 'setRawMode').mockImplementation(() => process.stdin)
    }
    vi.spyOn(process.stdin, 'setEncoding').mockImplementation(() => process.stdin)
    vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin)
    vi.spyOn(process.stdin, 'pause').mockImplementation(() => process.stdin)
    screen = new TerminalScreen(process.stdin, process.stdout)
    screen.start()
    screen.setDock(['PROMPT'], { row: 0, col: 1 })
    return screen
  }

  async function painted(): Promise<void> {
    await new Promise((resolve) => { setTimeout(resolve, 30) })
  }

  it('appends a model-listing line above the prompt', async () => {
    boot()
    await painted()
    stdoutChunks.length = 0
    stderrChunks.length = 0
    // Vitest replaces the global console. The process Console is what the host calls.
    new Console(process.stdout, process.stderr).error(
      '[llm-deepseek-api-key]',
      'model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)',
    )
    const text = stdoutChunks.join('')
    const logAt = text.indexOf('[llm-deepseek-api-key]')
    const promptAt = text.lastIndexOf('PROMPT')
    expect(logAt).toBeGreaterThanOrEqual(0)
    expect(promptAt).toBeGreaterThan(logAt)
    expect(text.slice(logAt, promptAt)).toContain('\n')
    expect(stderrChunks.join('')).not.toContain('[llm-deepseek-api-key]')
  })

  it('keeps a partial write until its newline and restores stderr on stop', async () => {
    const current = boot()
    await painted()
    stdoutChunks.length = 0
    process.stderr.write('partial')
    expect(stdoutChunks.join('')).not.toContain('partial')
    process.stderr.write(' line\n')
    expect(stdoutChunks.join('')).toContain('partial line')
    stdoutChunks.length = 0
    process.stdout.write('tail')
    current.stop()
    screen = undefined
    expect(stdoutChunks.join('')).toContain('tail')
    stderrChunks.length = 0
    process.stderr.write('after\n')
    expect(stderrChunks.join('')).toContain('after')
  })
})
