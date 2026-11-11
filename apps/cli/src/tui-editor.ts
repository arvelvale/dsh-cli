/** Rounded multi-line prompt, slash completion, history and status line. */

import {
  graphemes, padTo, symbols, truncateTo, visibleWidth, wrapLine,
  type Theme,
} from './tui-theme.ts'
import type { CursorPosition, KeyEvent } from './tui-screen.ts'
import { commandDescriptors } from './tui-input.ts'

/** Information shown in the two status rows below the editor. */
export interface EditorStatus {
  readonly model: string
  readonly session: string
  readonly cwd: string
  readonly connection: string
  readonly connected: boolean
  readonly expanded: boolean
  readonly streaming: boolean
  readonly attachments: number
  readonly version: string
  readonly pasteShortcut: string
}

/** Semantic actions the editor cannot perform on its own. */
export interface EditorCallbacks {
  submit(text: string): void
  cancel(): void
  exit(): void
  toggleExpanded(): void
  pasteImage(): void
}

export interface EditorFrame {
  readonly dock: readonly string[]
  readonly overlay: readonly string[]
  readonly cursor: CursorPosition
}

const maxVisibleLines = 5
const exitWindowMs = 1500

/** Owns the prompt buffer and translates raw keys into product actions. */
export class Editor {
  private buffer: string[][] = [[]]
  private row = 0
  private col = 0
  private history: string[] = []
  private historyIndex = 0
  private draft = ''
  private undo: string[][][] = []
  private yank = ''
  private streaming = false
  private completionOpen = false
  private completionIndex = 0
  private lastExitAt = 0
  private readonly pastes = new Map<string, string>()

  /** @param callbacks - product actions triggered by keyboard shortcuts. */
  constructor(readonly callbacks: EditorCallbacks) {}

  /** @returns the current prompt text. */
  get text(): string {
    return this.buffer.map(line => line.join('')).join('\n')
  }

  /** @returns whether a model turn is currently streaming. */
  get isStreaming(): boolean {
    return this.streaming
  }

  /** Update streaming state so Esc and Ctrl+C interrupt instead of exiting. */
  setStreaming(value: boolean): void {
    this.streaming = value
  }

  /** Replace the prompt content, for example after a picker filled a command. */
  setText(text: string): void {
    this.buffer = text.split('\n').map(line => graphemes(line))
    this.row = this.buffer.length - 1
    this.col = this.buffer[this.row]?.length ?? 0
    this.completionOpen = false
  }

  /** @returns whether a completion menu is currently visible. */
  get hasCompletion(): boolean {
    return this.completionOpen
  }

  /** Handle one decoded key. */
  handleKey(event: KeyEvent): void {
    const { name, ctrl, alt, shift } = event
    if (name === 'c' && ctrl) {
      if (this.streaming) { this.callbacks.cancel(); return }
      if (this.text !== '') { this.clear(); return }
      const now = Date.now()
      if (now - this.lastExitAt < exitWindowMs) { this.callbacks.exit(); return }
      this.lastExitAt = now
      return
    }
    if (name === 'd' && ctrl) {
      if (this.text !== '') return
      const now = Date.now()
      if (now - this.lastExitAt < exitWindowMs) this.callbacks.exit()
      else this.lastExitAt = now
      return
    }
    if (name === 'o' && ctrl) { this.callbacks.toggleExpanded(); return }
    if (name === 'v' && (ctrl || alt)) { this.callbacks.pasteImage(); return }
    if (name === 'escape') {
      if (this.completionOpen) { this.completionOpen = false; return }
      if (this.streaming) this.callbacks.cancel()
      else this.clear()
      return
    }
    if (name === 'return' && !shift) {
      if (this.completionOpen) { this.applyCompletion(); return }
      const line = this.buffer[this.row] ?? []
      if (line.at(-1) === '\\') {
        this.buffer[this.row] = line.slice(0, -1)
        this.col = Math.max(0, this.col - 1)
        this.newline()
        return
      }
      const expanded = this.expandPastes(this.text)
      if (expanded.trim() !== '' || this.pendingImages) this.submit(expanded)
      return
    }
    if (name === 'j' && ctrl || name === 'return' && shift) { this.newline(); return }
    if (name === 'tab') { this.complete(shift); return }
    if (name === 'paste' && event.text !== undefined) { this.paste(event.text); return }
    if (name === 'text') {
      const value = event.text ?? ''
      if (value !== '') { this.snapshot(); this.insert(value); return }
    }
    if (name === 'backspace') { this.snapshot(); this.backspace(); return }
    if (name === 'delete') { this.remove(); return }
    if (name === 'left') { this.move(-1, 0); return }
    if (name === 'right') { this.move(1, 0); return }
    if (name === 'up' || name === 'p' && ctrl) {
      if (this.completionOpen) { this.complete(true); return }
      this.historyMove(-1)
      return
    }
    if (name === 'down' || name === 'n' && ctrl) {
      if (this.completionOpen) { this.complete(false); return }
      this.historyMove(1)
      return
    }
    if (name === 'home' || name === 'a' && ctrl) { this.col = 0; return }
    if (name === 'end' || name === 'e' && ctrl) { this.col = this.buffer[this.row]?.length ?? 0; return }
    if (name === 'u' && ctrl) { this.killToStart(); return }
    if (name === 'k' && ctrl) { this.killToEnd(); return }
    if (name === 'w' && ctrl) { this.deleteWord(); return }
    if (name === 'y' && ctrl) { this.insert(this.yank); return }
    if (name === '-' && ctrl || name === '_' && ctrl) { this.restoreUndo(); return }
    if (name === 'l' && ctrl) { this.clear(); return }
  }

  private pendingImages = false

  /** Show a small attachment chip in the prompt border. */
  setAttachments(count: number): void {
    this.pendingImages = count > 0
  }

  private submit(text: string): void {
    const trimmed = text.trim()
    if (trimmed !== '') {
      if (this.history.at(-1) !== text) this.history.push(text)
      if (this.history.length > 100) this.history.shift()
    }
    this.historyIndex = this.history.length
    this.draft = ''
    this.clear()
    this.callbacks.submit(text)
  }

  private clear(): void {
    this.buffer = [[]]
    this.row = 0
    this.col = 0
    this.completionOpen = false
  }

  private snapshot(): void {
    this.undo.push(this.buffer.map(line => [...line]))
    if (this.undo.length > 50) this.undo.shift()
  }

  private restoreUndo(): void {
    const previous = this.undo.pop()
    if (previous === undefined) return
    this.buffer = previous
    this.row = Math.min(this.row, this.buffer.length - 1)
    this.col = Math.min(this.col, this.buffer[this.row]?.length ?? 0)
  }

  private insert(text: string): void {
    const parts = text.replace(/\r\n?/gu, '\n').split('\n')
    for (const [index, part] of parts.entries()) {
      if (index > 0) this.newline()
      const clusters = graphemes(part)
      const line = this.buffer[this.row] ?? []
      this.buffer[this.row] = [...line.slice(0, this.col), ...clusters, ...line.slice(this.col)]
      this.col += clusters.length
    }
    this.updateCompletion()
  }

  private newline(): void {
    const line = this.buffer[this.row] ?? []
    this.buffer.splice(this.row + 1, 0, line.slice(this.col))
    this.buffer[this.row] = line.slice(0, this.col)
    this.row += 1
    this.col = 0
    this.completionOpen = false
  }

  private backspace(): void {
    if (this.col > 0) {
      const line = this.buffer[this.row] ?? []
      this.buffer[this.row] = [...line.slice(0, this.col - 1), ...line.slice(this.col)]
      this.col -= 1
    } else if (this.row > 0) {
      const previous = this.buffer[this.row - 1] ?? []
      const current = this.buffer[this.row] ?? []
      this.col = previous.length
      this.buffer[this.row - 1] = [...previous, ...current]
      this.buffer.splice(this.row, 1)
      this.row -= 1
    }
    this.updateCompletion()
  }

  private remove(): void {
    const line = this.buffer[this.row] ?? []
    if (this.col < line.length) this.buffer[this.row] = [...line.slice(0, this.col), ...line.slice(this.col + 1)]
    else if (this.row < this.buffer.length - 1) {
      const next = this.buffer[this.row + 1] ?? []
      this.buffer[this.row] = [...line, ...next]
      this.buffer.splice(this.row + 1, 1)
    }
  }

  private move(horizontal: number, vertical: number): void {
    if (vertical !== 0) {
      const target = Math.max(0, Math.min(this.buffer.length - 1, this.row + vertical))
      this.row = target
      this.col = Math.min(this.col, this.buffer[target]?.length ?? 0)
      return
    }
    if (horizontal < 0) {
      if (this.col > 0) this.col -= 1
      else if (this.row > 0) { this.row -= 1; this.col = this.buffer[this.row]?.length ?? 0 }
    } else {
      const line = this.buffer[this.row] ?? []
      if (this.col < line.length) this.col += 1
      else if (this.row < this.buffer.length - 1) { this.row += 1; this.col = 0 }
    }
  }

  private killToStart(): void {
    const line = this.buffer[this.row] ?? []
    this.yank = line.slice(0, this.col).join('')
    this.buffer[this.row] = line.slice(this.col)
    this.col = 0
  }

  private killToEnd(): void {
    const line = this.buffer[this.row] ?? []
    this.yank = line.slice(this.col).join('')
    this.buffer[this.row] = line.slice(0, this.col)
  }

  private deleteWord(): void {
    const line = this.buffer[this.row] ?? []
    let start = this.col
    while (start > 0 && /[\s]/u.test(line[start - 1] ?? '')) start -= 1
    while (start > 0 && !/[\s]/u.test(line[start - 1] ?? '')) start -= 1
    this.yank = line.slice(start, this.col).join('')
    this.buffer[this.row] = [...line.slice(0, start), ...line.slice(this.col)]
    this.col = start
  }

  private historyMove(direction: number): void {
    if (this.buffer.length > 1) { this.move(0, direction); return }
    if (direction < 0 && this.historyIndex === 0) return
    if (direction > 0 && this.historyIndex >= this.history.length) return
    if (this.historyIndex === this.history.length) this.draft = this.text
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction))
    this.setText(this.historyIndex === this.history.length ? this.draft : this.history[this.historyIndex] ?? '')
  }

  private candidates(): readonly (typeof commandDescriptors)[number]['entries'][number][] {
    const firstLine = this.buffer[0]?.join('') ?? ''
    if (!/^\/[a-z]*$/iu.test(firstLine) || this.buffer.length !== 1) return []
    const prefix = firstLine.toLowerCase()
    return commandDescriptors.flatMap(group => group.entries)
      .filter(entry => entry.name.toLowerCase().startsWith(prefix))
  }

  private updateCompletion(): void {
    const firstLine = this.buffer[0]?.join('') ?? ''
    this.completionOpen = this.buffer.length === 1 && firstLine.startsWith('/') && !firstLine.includes(' ')
      && this.candidates().length > 0
    if (this.completionOpen) this.completionIndex = 0
  }

  private complete(backwards: boolean): void {
    const matches = this.candidates()
    if (matches.length === 0) { this.insert('  '); return }
    if (!this.completionOpen) { this.completionOpen = true; this.completionIndex = 0; return }
    this.completionIndex = (this.completionIndex + (backwards ? -1 : 1) + matches.length) % matches.length
  }

  private applyCompletion(): void {
    const matches = this.candidates()
    const choice = matches[this.completionIndex]
    this.completionOpen = false
    if (choice === undefined) return
    if (choice.args !== '') this.setText(`${choice.name} `)
    else this.submit(choice.name)
  }

  private expandPastes(text: string): string {
    return text.replace(/\[粘贴 #\d+ [^\]]+\]/gu, marker => this.pastes.get(marker) ?? marker)
  }

  /** Fold large pastes into a short marker that expands on submit. */
  paste(text: string): void {
    const normalized = text.replace(/\r\n?/gu, '\n')
    const lineCount = normalized.split('\n').length
    if (lineCount <= 10 && normalized.length <= 1000) { this.insert(normalized); this.snapshot(); return }
    const id = this.pastes.size + 1
    const marker = `[粘贴 #${String(id)} +${String(lineCount)} 行]`
    this.pastes.set(marker, normalized)
    this.insert(marker)
    this.snapshot()
  }

  /** @returns the prompt box, completion overlay and the hardware cursor position. */
  render(width: number, theme: Theme, status: EditorStatus, attachmentCount = 0): EditorFrame {
    const outer = Math.max(24, width - 1)
    const inner = outer - 4
    const label = this.streaming ? ' 输入 · Esc 中断 ' : ' 消息 '
    const chip = attachmentCount > 0 ? ` ${symbols.ellipsis} ${String(attachmentCount)} 张图片 ` : ''
    const top = theme.fg('border', symbols.topLeft + symbols.horizontal + label)
      + theme.fg('borderFocus', chip)
      + theme.fg('border', symbols.horizontal.repeat(Math.max(0, outer - 3 - visibleWidth(label) - visibleWidth(chip)))
        + symbols.topRight)
    const total = this.buffer.length
    const start = Math.max(0, Math.min(this.row - maxVisibleLines + 1, total - maxVisibleLines))
    const visible = this.buffer.slice(start, start + maxVisibleLines)
    const hiddenAbove = start
    const hiddenBelow = Math.max(0, total - start - visible.length)
    const lines: string[] = [top]
    let cursor: CursorPosition = { row: 1, col: 4 }
    for (const [offset, clusters] of visible.entries()) {
      const index = start + offset
      const prompt = index === 0 ? theme.fg('roleUser', symbols.userBullet) + ' ' : '  '
      const body = clusters.join('')
      const isCurrent = index === this.row
      let decorated = isCurrent ? decorateCursor(body, this.col, theme) : body
      if (isCurrent && body === '') {
        decorated = theme.fg('textStrong', '\u001b[7m \u001b[27m') + theme.fg('textMuted', '输入消息，/ 查看命令')
      }
      if (isCurrent && this.col === clusters.length) {
        decorated += theme.fg('textMuted', ghostHint(body))
      }
      const content = `${prompt}${decorated}`
      const wrapped = wrapLine(content, inner)
      const beforePlain = `${index === 0 ? '❯ ' : '  '}${graphemes(body).slice(0, this.col).join('')}`
      const beforeWrapped = wrapLine(beforePlain, inner)
      const cursorWrap = beforeWrapped.length - 1
      const cursorColumn = 2 + visibleWidth(beforeWrapped.at(-1) ?? '')
      for (const [wrapIndex, line] of wrapped.entries()) {
        if (isCurrent && wrapIndex === cursorWrap) cursor = { row: lines.length, col: cursorColumn }
        lines.push(`${theme.fg('border', symbols.vertical)} ${padTo(line, inner)} ${theme.fg('border', symbols.vertical)}`)
      }
    }
    const bottomNote = hiddenAbove > 0 ? ` ↑ ${String(hiddenAbove)} 行 ` : hiddenBelow > 0 ? ` ↓ ${String(hiddenBelow)} 行 ` : ''
    const bottom = theme.fg('border', symbols.bottomLeft + (bottomNote === '' ? ''
      : symbols.horizontal + bottomNote + symbols.horizontal))
      + theme.fg('border', symbols.horizontal.repeat(Math.max(0, outer - 2 - visibleWidth(bottomNote) - (bottomNote === '' ? 0 : 2)))
        + symbols.bottomRight)
    lines.push(bottom)
    lines.push(statusLine(outer, theme, status, this.streaming))
    lines.push(hintLine(outer, theme, status))
    return { dock: lines, overlay: this.renderCompletion(outer, theme), cursor }
  }

  private renderCompletion(outer: number, theme: Theme): readonly string[] {
    if (!this.completionOpen) return []
    const matches = this.candidates().slice(0, 6)
    if (matches.length === 0) return []
    const inner = outer - 4
    const label = `${symbols.horizontal} 命令 `
    const rows = matches.map((entry, index) => {
      const active = index === this.completionIndex
      const pointer = active ? theme.bold('primary', symbols.pointer) + ' ' : '  '
      const name = active ? theme.bold('primary', entry.name) : theme.fg('text', entry.name)
      const args = theme.fg('textMuted', entry.args === '' ? '' : ` ${entry.args}`)
      const description = theme.fg('textDim', `  ${entry.description}`)
      const content = truncateTo(`${pointer}${name}${args}${description}`, inner)
      return `${theme.fg('border', symbols.vertical)} ${padTo(content, inner)} ${theme.fg('border', symbols.vertical)}`
    })
    return [
      theme.fg('border', symbols.topLeft + label
        + symbols.horizontal.repeat(Math.max(0, outer - 2 - visibleWidth(label))) + symbols.topRight),
      ...rows,
      theme.fg('border', symbols.bottomLeft + symbols.horizontal.repeat(outer - 2) + symbols.bottomRight),
    ]
  }
}

function decorateCursor(text: string, col: number, theme: Theme): string {
  const clusters = graphemes(text)
  const before = clusters.slice(0, col).join('')
  const current = clusters[col] ?? ' '
  const after = clusters.slice(col + (clusters[col] === undefined ? 0 : 1)).join('')
  return before + theme.fg('textStrong', `\u001b[7m${current}\u001b[27m`) + after
}

function ghostHint(text: string): string {
  if (!text.startsWith('/')) return ''
  const descriptor = commandDescriptors.flatMap(group => group.entries).find(entry => entry.name === text.trim())
  return descriptor === undefined || descriptor.args === '' ? '' : `  ${descriptor.args}`
}

function statusLine(width: number, theme: Theme, status: EditorStatus, streaming: boolean): string {
  const dot = status.connected ? theme.fg('success', symbols.bullet) : theme.fg('warning', symbols.bullet)
  const frame = symbols.spinner[Math.floor(Date.now() / 80) % symbols.spinner.length] ?? symbols.spinner[0]
  const spinner = streaming ? theme.fg('accent', frame) + ' ' : ''
  const model = spinner + theme.bold('textStrong', status.model)
  const session = theme.fg('textDim', status.session)
  const cwd = theme.fg('textDim', status.cwd)
  const connection = `${dot} ${theme.fg('textDim', status.connection)}`
  const separator = theme.fg('textMuted', '  ·  ')
  const right = theme.fg('textMuted', `${status.expanded ? 'Ctrl+O 收起' : 'Ctrl+O 展开'}  ·  /help 命令`)
  const candidates = [
    [model, session, cwd, connection],
    [model, session, connection],
    [model, connection],
    [model],
  ]
  for (const parts of candidates) {
    const left = parts.join(separator)
    if (visibleWidth(left) + visibleWidth(right) + 2 <= width) return joinColumns(left, right, width)
  }
  return truncateTo(model, width)
}

function hintLine(width: number, theme: Theme, status: EditorStatus): string {
  const left = theme.fg('textMuted', 'Enter 发送  ·  Shift+Enter 换行  ·  ↑↓ 历史  ·  Esc 中断')
  const right = theme.fg('textMuted', `${status.pasteShortcut} 图片  ·  ${status.version}`)
  return joinColumns(left, right, width)
}

function joinColumns(left: string, right: string, width: number): string {
  const gap = 2
  const rightWidth = visibleWidth(right)
  const available = width - rightWidth - gap
  if (available < 12) return truncateTo(left, width)
  const fittedLeft = truncateTo(left, available)
  return `${fittedLeft}${' '.repeat(Math.max(gap, width - visibleWidth(fittedLeft) - rightWidth))}${right}`
}
