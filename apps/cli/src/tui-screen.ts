/** Raw-terminal driver with a differential bottom dock and stream-safe commits. */

import type { ReadStream, WriteStream } from 'node:tty'
import { padTo, truncateTo } from './tui-theme.ts'

/** One decoded key press or paste. */
export interface KeyEvent {
  readonly name: string
  readonly ctrl: boolean
  readonly shift: boolean
  readonly alt: boolean
  readonly meta: boolean
  readonly text?: string
  readonly paste?: boolean
}

/** Hardware cursor position relative to the first dock row. */
export interface CursorPosition {
  readonly row: number
  readonly col: number
}

export type KeyListener = (key: KeyEvent) => void
export type ResizeListener = () => void

const beginSync = '\u001b[?2026h'
const endSync = '\u001b[?2026l'
const pasteBegin = '\u001b[200~'
const pasteEnd = '\u001b[201~'
const frameInterval = 16

const controlNames = new Map<number, string>([
  [1, 'a'], [2, 'b'], [3, 'c'], [4, 'd'], [5, 'e'], [6, 'f'], [7, 'g'],
  [8, 'backspace'], [9, 'tab'], [10, 'j'], [11, 'k'], [12, 'l'], [13, 'return'],
  [14, 'n'], [15, 'o'], [16, 'p'], [17, 'q'], [18, 'r'], [19, 's'], [20, 't'],
  [21, 'u'], [22, 'v'], [23, 'w'], [24, 'x'], [25, 'y'], [26, 'z'], [127, 'backspace'],
])

function key(name: string, options: Partial<Omit<KeyEvent, 'name'>> = {}): KeyEvent {
  return { name, ctrl: false, shift: false, alt: false, meta: false, ...options }
}

/** Decode one CSI sequence into a semantic key. */
function decodeSequence(sequence: string): KeyEvent | undefined {
  if (sequence === '\u001b') return key('escape')
  if (sequence === '\u001b\r' || sequence === '\u001b[Z') return key('return', { shift: true })
  const csi = /^\u001b\[([0-9;]*)([A-Za-z~])$/u.exec(sequence)
  if (csi !== null) {
    const parts = (csi[1] ?? '').split(';').filter(part => part !== '').map(Number)
    const final = csi[2] ?? ''
    const modifier = parts.length > 1 ? parts[1] ?? 1 : 1
    const options = {
      shift: [2, 4, 6, 8].includes(modifier),
      alt: [3, 4, 7, 8].includes(modifier),
      ctrl: [5, 6, 7, 8].includes(modifier),
    }
    const named: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' }
    if (final === 'Z') return key('tab', { shift: true })
    const namedKey = named[final]
    if (namedKey !== undefined) return key(namedKey, options)
    if (final === '~' || final === 'u') {
      const code = parts[0] ?? 0
      const special: Record<number, string> = {
        1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown',
        13: 'return', 27: 'tab',
      }
      if (code === 13) return key('return', { shift: options.shift })
      const specialKey = special[code]
      if (specialKey !== undefined) return key(specialKey, options)
      if (final === 'u' && code >= 32) {
        return key(String.fromCodePoint(code).toLowerCase(), { ...options, text: String.fromCodePoint(code) })
      }
    }
    return undefined
  }
  const altKey = /^\u001b(.)$/u.exec(sequence)
  if (altKey !== null) {
    const character = altKey[1] ?? ''
    return key(character.toLowerCase(), { alt: true, text: character })
  }
  return undefined
}

/**
 * Owns raw mode, synchronized output and the fixed bottom region of the screen.
 * Committed transcript lines stay in the native scrollback; only the dock, the
 * live stream block and overlays are redrawn, one changed row at a time.
 * While started, stderr and stdout written outside this frame are appended
 * above the dock, then the dock is drawn again.
 */
export class TerminalScreen {
  private readonly listeners = new Set<KeyListener>()
  private readonly resizeListeners = new Set<ResizeListener>()
  private readonly wasRaw: boolean
  private buffer = ''
  private pasteText: string | undefined
  private dock: readonly string[] = []
  private active: readonly string[] = []
  private menu: readonly string[] = []
  private overlay: readonly string[] = []
  private cursor: CursorPosition = { row: 0, col: 0 }
  private previous: string[] = []
  private lastCursorRow = 0
  private started = false
  private painting = false
  private owningWrite = false
  private queuedExternal: string[] = []
  private releaseTerminalCapture: (() => void) | undefined
  private timer: NodeJS.Timeout | undefined
  private escapeTimer: NodeJS.Timeout | undefined
  private pendingForce = false

  /**
   * @param stdin - interactive input stream.
   * @param stdout - interactive output stream.
   */
  constructor(readonly stdin: ReadStream, readonly stdout: WriteStream) {
    this.wasRaw = stdin.isRaw
  }

  /** @returns usable terminal columns, or a safe fallback. */
  get columns(): number {
    return Math.max(20, this.stdout.columns || 80)
  }

  /** @returns usable terminal rows, or a safe fallback. */
  get rows(): number {
    return Math.max(8, this.stdout.rows || 24)
  }

  /** Enter raw mode and reserve the bottom region. */
  start(): void {
    if (this.started) return
    this.started = true
    this.installTerminalCapture()
    this.stdin.setRawMode(true)
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', this.onData)
    this.stdout.on('resize', this.handleResize)
    this.writeFrame('\u001b[?2004h\u001b[?25l')
    this.stdin.resume()
  }

  /** Restore the terminal; committed transcript remains in scrollback. */
  stop(): void {
    if (!this.started) return
    const release = this.releaseTerminalCapture
    this.releaseTerminalCapture = undefined
    try { release?.() }
    finally {
      this.started = false
      this.flush()
      if (this.escapeTimer !== undefined) { clearTimeout(this.escapeTimer); this.escapeTimer = undefined }
      this.stdin.removeListener('data', this.onData)
      this.stdout.removeListener('resize', this.handleResize)
      this.eraseRegion()
      this.writeFrame('\u001b[?2004l\u001b[?25h\u001b[0m\r\n')
      this.stdin.setRawMode(this.wasRaw)
      // start() resumed the TTY; without pausing it the ref'd stdin handle keeps
      // the event loop alive after /exit, so the process never terminates.
      this.stdin.pause()
      this.previous = []
      this.lastCursorRow = 0
      this.queuedExternal = []
    }
  }

  /** Subscribe to decoded key presses. */
  onKey(listener: KeyListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Subscribe to terminal size changes. */
  onResize(listener: ResizeListener): () => void {
    this.resizeListeners.add(listener)
    return () => { this.resizeListeners.delete(listener) }
  }

  /** Replace the fixed editor and status rows. */
  setDock(lines: readonly string[], cursor: CursorPosition = { row: 0, col: 0 }): void {
    this.dock = lines
    this.cursor = cursor
    this.requestRender()
  }

  /** Replace the live block drawn immediately above the dock. */
  setActive(lines: readonly string[]): void {
    this.active = lines
    this.requestRender()
  }

  /** Replace a modal overlay drawn above the live block. */
  setOverlay(lines: readonly string[]): void {
    this.overlay = lines
    this.requestRender()
  }

  /** Replace the completion menu drawn between the live block and the dock. */
  setMenu(lines: readonly string[]): void {
    this.menu = lines
    this.requestRender()
  }

  /** Merge renders from high-frequency stream chunks into animation frames. */
  requestRender(force = false): void {
    this.pendingForce = this.pendingForce || force
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const forceFrame = this.pendingForce
      this.pendingForce = false
      this.draw(forceFrame)
    }, frameInterval)
  }

  /** Write final transcript lines above the dock without disturbing it. */
  commit(lines: readonly string[]): void {
    if (this.painting) { this.commitLines(lines); return }
    this.paint(() => { this.commitLines(lines) })
  }

  /** Clear the whole visible screen so an expanded transcript can be replayed. */
  clearAll(): void {
    const clear = (): void => {
      this.flush()
      this.eraseRegion()
      this.writeFrame('\u001b[2J\u001b[H')
      this.previous = []
      this.lastCursorRow = 0
    }
    if (this.painting) { clear(); return }
    this.paint(clear)
  }

  private flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.pendingForce = false
    }
  }

  private commitLines(lines: readonly string[]): void {
    const width = this.columns - 1
    this.flush()
    this.eraseRegion()
    if (lines.length > 0) {
      this.writeFrame(`${lines.map(line => truncateTo(line, width)).join('\r\n')}\r\n`)
    }
    this.previous = []
    this.lastCursorRow = 0
    this.draw(true)
  }

  private eraseRegion(): void {
    if (this.previous.length === 0) return
    const up = this.lastCursorRow > 0 ? `\u001b[${String(this.lastCursorRow)}A` : ''
    this.writeFrame(`${up}\r\u001b[0J`)
    this.previous = []
  }

  private paint(body: () => void): void {
    this.painting = true
    try { body() }
    finally { this.painting = false }
    if (!this.started || this.queuedExternal.length === 0) return
    const lines = this.queuedExternal
    this.queuedExternal = []
    this.commit(lines)
  }

  /** Append host logs above the dock. A log that arrives mid-frame waits until the frame finishes. */
  private absorb(lines: readonly string[]): void {
    const visible = lines.filter(line => line !== '')
    if (visible.length === 0 || !this.started) return
    if (this.painting) { this.queuedExternal.push(...visible); return }
    this.commit(visible)
  }

  private writeFrame(chunk: string): void {
    this.owningWrite = true
    try { this.stdout.write(chunk) }
    finally { this.owningWrite = false }
  }

  /**
   * Take stderr, and stdout when this screen draws on it, until {@link stop}.
   * Frame writes pass through. Other bytes are appended above the dock.
   */
  private installTerminalCapture(): void {
    const releases = [captureStream(process.stderr, (line) => { this.absorb([line]) }, () => !this.started)]
    if (this.stdout === process.stdout) {
      releases.push(captureStream(
        process.stdout,
        (line) => { this.absorb([line]) },
        () => this.owningWrite || !this.started,
      ))
    }
    this.releaseTerminalCapture = () => {
      this.releaseTerminalCapture = undefined
      const errors: unknown[] = []
      for (const release of releases) {
        try { release() }
        catch (error: unknown) { errors.push(error) }
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, 'terminal log capture failed to restore')
    }
  }

  private draw(force: boolean): void {
    if (!this.started) return
    if (!this.painting) { this.paint(() => { this.draw(force) }); return }
    const width = this.columns - 1
    const maxRows = Math.max(1, this.rows - 1)
    const combined = [...this.overlay, ...this.active, ...this.menu, ...this.dock]
    const dropped = Math.max(0, combined.length - maxRows)
    const region = combined.slice(dropped).map(line => padTo(truncateTo(line, width), width))
    const cursorRow = Math.max(0, Math.min(region.length - 1,
      this.cursor.row + this.overlay.length + this.active.length + this.menu.length - dropped))
    const cursorCol = Math.max(0, Math.min(width - 1, this.cursor.col))
    let firstChanged = -1
    if (force || region.length !== this.previous.length) {
      firstChanged = region.length === 0 ? -1 : 0
    } else {
      for (let index = 0; index < region.length; index += 1) {
        if (region[index] !== this.previous[index]) { firstChanged = index; break }
      }
    }
    if (firstChanged === -1) {
      this.placeCursor(cursorRow, cursorCol, region.length - 1)
      this.previous = region
      this.lastCursorRow = cursorRow
      return
    }
    let output = beginSync
    const full = firstChanged === 0
    if (full) {
      const up = this.lastCursorRow > 0 ? `\u001b[${String(this.lastCursorRow)}A` : ''
      output += `${up}\r\u001b[0J`
    } else {
      const delta = this.lastCursorRow - firstChanged
      output += delta > 0 ? `\u001b[${String(delta)}A` : delta < 0 ? `\u001b[${String(-delta)}B` : ''
      output += '\r'
    }
    for (let index = firstChanged; index < region.length; index += 1) {
      output += `\u001b[2K${region[index] ?? ''}`
      if (index < region.length - 1) output += '\r\n'
    }
    output += this.placeCursorSequence(cursorRow, cursorCol, region.length - 1)
    this.writeFrame(`${output}${endSync}`)
    this.previous = region
    this.lastCursorRow = cursorRow
  }

  private placeCursor(row: number, col: number, fromRow: number): void {
    const sequence = this.placeCursorSequence(row, col, fromRow)
    if (sequence !== '') this.writeFrame(sequence)
  }

  private placeCursorSequence(row: number, col: number, fromRow: number): string {
    const delta = row - fromRow
    const vertical = delta > 0 ? `\u001b[${String(delta)}B` : delta < 0 ? `\u001b[${String(-delta)}A` : ''
    return `${vertical}\r\u001b[${String(col + 1)}C`
  }

  private readonly handleResize = (): void => {
    this.draw(true)
    for (const listener of this.resizeListeners) listener()
  }

  private readonly onData = (chunk: string): void => {
    if (this.escapeTimer !== undefined) {
      clearTimeout(this.escapeTimer)
      this.escapeTimer = undefined
    }
    this.buffer += chunk
    this.parse()
  }

  /** A lone Escape has no terminating byte, so resolve it after a short quiet window. */
  private scheduleEscapeFallback(): void {
    if (this.escapeTimer !== undefined) return
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = undefined
      if (!this.buffer.startsWith('\u001b')) return
      this.buffer = this.buffer.slice(1)
      this.emit(key('escape'))
      if (this.buffer !== '') this.parse()
    }, 40)
  }

  private emit(event: KeyEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  /** Consume as many complete keys as the current buffer allows. */
  private parse(): void {
    while (this.buffer !== '') {
      if (this.pasteText !== undefined) {
        const end = this.buffer.indexOf(pasteEnd)
        if (end === -1) {
          this.pasteText += this.buffer
          this.buffer = ''
          return
        }
        this.pasteText += this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + pasteEnd.length)
        const text = this.pasteText
        this.pasteText = undefined
        this.emit(key('paste', { text, paste: true }))
        continue
      }
      if (this.buffer.length > 1 && pasteBegin.startsWith(this.buffer) && this.buffer.length < pasteBegin.length) {
        this.scheduleEscapeFallback()
        return
      }
      if (this.buffer.startsWith(pasteBegin)) {
        this.buffer = this.buffer.slice(pasteBegin.length)
        this.pasteText = ''
        continue
      }
      if (this.buffer[0] === '\u001b') {
        const csi = /^\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\r|O[A-Z]|\[\[[A-Z])/u.exec(this.buffer)
        if (csi !== null) {
          this.buffer = this.buffer.slice(csi[0].length)
          if (/^\u001b\[</u.test(csi[0]) || /^\u001bO/u.test(csi[0]) || /^\u001b\[\[/u.test(csi[0])) continue
          const event = decodeSequence(csi[0])
          if (event !== undefined) this.emit(event)
          continue
        }
        if (/^\u001b(?:\[[0-9;?]*|O|\[\[?)?$/u.test(this.buffer)) {
          this.scheduleEscapeFallback()
          return
        }
        if (this.buffer.length === 1) return
        const two = this.buffer.slice(0, 2)
        this.buffer = this.buffer.slice(2)
        const event = decodeSequence(two)
        if (event !== undefined) this.emit(event)
        continue
      }
      const code = this.buffer.codePointAt(0) ?? 0
      const character = String.fromCodePoint(code)
      this.buffer = this.buffer.slice(character.length)
      const name = controlNames.get(code)
      if (name !== undefined) {
        const isControl = code < 27 && ![9, 13].includes(code)
        this.emit(key(name, { ctrl: isControl }))
        continue
      }
      let text = character
      while (this.buffer !== '') {
        const next = this.buffer.codePointAt(0) ?? 0
        if (next < 32 || next === 127 || next === 27) break
        const cluster = String.fromCodePoint(next)
        text += cluster
        this.buffer = this.buffer.slice(cluster.length)
      }
      this.emit(key('text', { text }))
    }
  }
}

/** Keep one stream's non-frame writes as complete lines until the returned function restores it. */
interface ByteWrite {
  (chunk: string | Uint8Array, encoding?: BufferEncoding, callback?: (error?: Error | null) => void): boolean
}

function captureStream(stream: WriteStream, onLine: (line: string) => void, passthrough: () => boolean): () => void {
  const write = stream.write.bind(stream) as ByteWrite
  let pending = ''
  let publishing = false
  const take = (flushPartial: boolean): string[] => {
    const lines: string[] = []
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      lines.push(pending.slice(0, newline).replace(/\r$/u, ''))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
    if (flushPartial && pending !== '') {
      lines.push(pending.replace(/\r$/u, ''))
      pending = ''
    }
    return lines
  }
  const publish = (flushPartial: boolean): void => {
    if (publishing) return
    publishing = true
    try {
      for (;;) {
        const lines = take(flushPartial)
        flushPartial = false
        if (lines.length === 0) return
        for (const line of lines) onLine(line)
      }
    } finally { publishing = false }
  }
  const wrapped = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    if (passthrough()) return forwardWrite(write, chunk, encoding, callback)
    pending += chunkText(chunk, encoding)
    publish(false)
    const done = typeof encoding === 'function' ? encoding : callback
    if (done !== undefined) done()
    return true
  }) as typeof stream.write
  stream.write = wrapped
  return () => {
    try { publish(true) }
    finally { stream.write = write as typeof stream.write }
  }
}

function forwardWrite(
  write: ByteWrite,
  chunk: string | Uint8Array,
  encoding?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void,
): boolean {
  if (typeof encoding === 'function') return write(chunk, undefined, encoding)
  return write(chunk, encoding, callback)
}

function chunkText(chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void)): string {
  if (typeof chunk === 'string') return chunk
  const decoded = typeof encoding === 'string' ? encoding : 'utf8'
  return Buffer.from(chunk).toString(decoded)
}
