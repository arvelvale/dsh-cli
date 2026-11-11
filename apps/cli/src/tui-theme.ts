/** Palette, ANSI primitives and Markdown rendering for the dsh terminal client. */

/** Semantic colors. Components never use raw ANSI or named chalk colors. */
export type ColorToken =
  | 'primary' | 'accent' | 'text' | 'textStrong' | 'textDim' | 'textMuted'
  | 'border' | 'borderFocus' | 'success' | 'warning' | 'error'
  | 'roleUser' | 'roleAssistant' | 'thinking' | 'shell'
  | 'diffAdded' | 'diffRemoved'

/** One complete color assignment for a light or dark terminal. */
export type Palette = Readonly<Record<ColorToken, string>>

export const darkPalette: Palette = {
  primary: '#7AA2F7', accent: '#7DCFFF', text: '#C8D3F5', textStrong: '#F0F4FF',
  textDim: '#828BB8', textMuted: '#565F87', border: '#3B4261', borderFocus: '#7AA2F7',
  success: '#9ECE6A', warning: '#E0AF68', error: '#F7768E',
  roleUser: '#FFCB6B', roleAssistant: '#7AA2F7', thinking: '#828BB8', shell: '#BB9AF7',
  diffAdded: '#9ECE6A', diffRemoved: '#F7768E',
}

export const lightPalette: Palette = {
  primary: '#2F5FD0', accent: '#087EA4', text: '#31394D', textStrong: '#101828',
  textDim: '#667085', textMuted: '#98A2B3', border: '#D0D5DD', borderFocus: '#2F5FD0',
  success: '#067647', warning: '#B54708', error: '#B42318',
  roleUser: '#9A6700', roleAssistant: '#2F5FD0', thinking: '#667085', shell: '#7A3EB8',
  diffAdded: '#067647', diffRemoved: '#B42318',
}

/** Glyphs shared by the editor, transcript and overlays. */
export const symbols = {
  bullet: '●', userBullet: '❯', pointer: '❯', success: '✓', failure: '✗',
  arrow: '→', ellipsis: '…', bar: '│', topLeft: '╭', topRight: '╮',
  bottomLeft: '╰', bottomRight: '╯', horizontal: '─', vertical: '│',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
} as const

interface StyleState {
  fg?: string
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  reverse: boolean
}

function blankState(): StyleState {
  return { bold: false, dim: false, italic: false, underline: false, reverse: false }
}

function applySgr(state: StyleState, params: readonly number[]): void {
  if (params.length === 0 || params[0] === 0) {
    Object.assign(state, blankState())
    delete state.fg
    return
  }
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index] ?? 0
    if (code === 38 && params[index + 1] === 2) {
      const r = params[index + 2] ?? 0
      const g = params[index + 3] ?? 0
      const b = params[index + 4] ?? 0
      state.fg = `38;2;${String(r)};${String(g)};${String(b)}`
      index += 4
    } else if (code === 1) state.bold = true
    else if (code === 2) state.dim = true
    else if (code === 3) state.italic = true
    else if (code === 4) state.underline = true
    else if (code === 7) state.reverse = true
    else if (code === 22) { state.bold = false; state.dim = false }
    else if (code === 23) state.italic = false
    else if (code === 24) state.underline = false
    else if (code === 27) state.reverse = false
    else if (code === 39) delete state.fg
  }
}

function replay(state: StyleState): string {
  const codes: string[] = []
  if (state.fg !== undefined) codes.push(state.fg)
  if (state.bold) codes.push('1')
  if (state.dim) codes.push('2')
  if (state.italic) codes.push('3')
  if (state.underline) codes.push('4')
  if (state.reverse) codes.push('7')
  return codes.length === 0 ? '' : `\u001b[${codes.join(';')}m`
}

interface Segment {
  readonly raw: string
  readonly width: number
  readonly sgr?: readonly number[]
}

const ansiPattern = /^\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|P[^\u001b]*\u001b\\|[@-Z\\-_])/u
const ansiGlobal = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|P[^\u001b]*\u001b\\|[@-Z\\-_])/gu
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })

/** @returns visible columns occupied by one string, ignoring ANSI sequences. */
export function visibleWidth(text: string): number {
  let width = 0
  for (const part of text.split(ansiGlobal)) {
    for (const { segment } of segmenter.segment(part)) {
      width = width + graphemeWidth(segment)
    }
  }
  return width
}

function graphemeWidth(segment: string): number {
  let width = 0
  for (const character of segment) {
    const cp = character.codePointAt(0) ?? 0
    const charWidth = codePointWidth(cp)
    if (charWidth === 0) return 0
    width = Math.max(width, charWidth)
  }
  return width
}

function codePointWidth(cp: number): number {
  if (cp < 32 || cp >= 0x7f && cp <= 0x9f) return 0
  if (cp >= 0x300 && cp <= 0x36f || cp >= 0x1ab0 && cp <= 0x1aff
    || cp >= 0x1dc0 && cp <= 0x1dff || cp >= 0x20d0 && cp <= 0x20ff
    || cp >= 0xfe00 && cp <= 0xfe0f || cp >= 0xfe20 && cp <= 0xfe2f
    || cp === 0x200d || cp === 0x200b || cp === 0x200c || cp === 0x200e || cp === 0x200f) return 0
  if (cp >= 0x1100 && cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf
    || cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff
    || cp >= 0xfe10 && cp <= 0xfe19 || cp >= 0xfe30 && cp <= 0xfe6f
    || cp >= 0xff00 && cp <= 0xff60 || cp >= 0xffe0 && cp <= 0xffe6
    || cp >= 0x1f300 && cp <= 0x1faff || cp >= 0x20000 && cp <= 0x3fffd) return 2
  return 1
}

/** @returns ANSI-free text. */
export function stripAnsi(text: string): string {
  return text.replace(ansiGlobal, '')
}

/** @returns grapheme clusters of one line. */
export function graphemes(text: string): string[] {
  return [...segmenter.segment(text)].map(item => item.segment)
}

function scan(line: string): readonly Segment[] {
  const segments: Segment[] = []
  let rest = line
  while (rest !== '') {
    const match = ansiPattern.exec(rest)
    if (match !== null) {
      const raw = match[0]
      const params = /^\u001b\[([0-9;]*)m$/u.exec(raw)
      const digits = params?.[1] ?? ''
      segments.push({
        raw, width: 0,
        ...(params === null ? {} : { sgr: digits === '' ? [0] : digits.split(';').map(Number) }),
      })
      rest = rest.slice(raw.length)
      continue
    }
    const cluster = graphemes(rest)[0] ?? ''
    segments.push({ raw: cluster, width: graphemeWidth(cluster) })
    rest = rest.slice(cluster.length)
  }
  return segments
}

const cjkBreak = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u

/**
 * Wrap one ANSI-decorated line by visible columns, replaying styles on every new line.
 * Prefers a space boundary for Latin text; CJK clusters may break between characters.
 */
export function wrapLine(line: string, width: number): string[] {
  if (width < 1) return ['']
  const lines: string[] = []
  const state = blankState()
  let prefix = ''
  let buffer: Segment[] = []
  let column = 0
  const emit = (segments: readonly Segment[]): void => {
    lines.push(prefix + segments.map(segment => segment.raw).join('') + '\u001b[0m')
    for (const segment of segments) {
      if (segment.sgr !== undefined) applySgr(state, segment.sgr)
    }
    prefix = replay(state)
  }
  for (const segment of scan(line)) {
    if (segment.width === 0) { buffer.push(segment); continue }
    if (column + segment.width <= width) {
      buffer.push(segment)
      column += segment.width
      continue
    }
    let cut = buffer.length
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      const candidate = buffer[index]
      if (candidate === undefined || candidate.width === 0) continue
      if (candidate.raw === ' ' || cjkBreak.test(candidate.raw)) { cut = index + 1; break }
    }
    const head = buffer.slice(0, cut)
    const tail = buffer.slice(cut)
    emit(head)
    buffer = [...tail, segment]
    column = tail.reduce((sum, item) => sum + item.width, 0) + segment.width
  }
  emit(buffer)
  return lines
}

/** @returns text padded with spaces to exactly the requested visible width. */
export function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)))
}

/** @returns a single line clipped to visible columns with a trailing ellipsis. */
export function truncateTo(text: string, width: number, ellipsis = symbols.ellipsis): string {
  if (width < 1) return ''
  if (visibleWidth(text) <= width) return text
  const limit = width - visibleWidth(ellipsis)
  let result = ''
  let column = 0
  const state = blankState()
  for (const segment of scan(text)) {
    if (segment.width === 0) {
      result += segment.raw
      if (segment.sgr !== undefined) applySgr(state, segment.sgr)
      continue
    }
    if (column + segment.width > limit) break
    result += segment.raw
    column += segment.width
  }
  return result + '\u001b[0m' + ellipsis
}

/** Applies a semantic palette to terminal strings. */
export class Theme {
  /**
   * @param palette - color assignment for the current terminal background.
   * @param enabled - whether to emit ANSI colors at all.
   */
  constructor(readonly palette: Palette = darkPalette, readonly enabled = true) {}

  private sgr(token: ColorToken, text: string, open: readonly number[], close: number): string {
    if (!this.enabled || text === '') return text
    const color = this.palette[token]
    const rgb = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16))
    return `\u001b[${[...open, 38, 2, ...rgb].join(';')}m${text}\u001b[${String(close)}m\u001b[39m`
  }

  /** @returns text in a semantic foreground color. */
  fg(token: ColorToken, text: string): string {
    return this.sgr(token, text, [], 39)
  }

  /** @returns bold text in a semantic foreground color. */
  bold(token: ColorToken, text: string): string {
    return this.sgr(token, text, [1], 22)
  }

  /** @returns dimmed text in a semantic foreground color. */
  dim(token: ColorToken, text: string): string {
    return this.sgr(token, text, [2], 22)
  }

  /** @returns italic text in a semantic foreground color. */
  italic(token: ColorToken, text: string): string {
    return this.sgr(token, text, [3], 23)
  }

  /** @returns underlined text in a semantic foreground color. */
  underline(token: ColorToken, text: string): string {
    return this.sgr(token, text, [4], 24)
  }
}

/** True for terminal backgrounds that need the light palette. */
export function prefersLight(): boolean {
  if (process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === '0') return false
  const mode = process.env.DSH_TUI_THEME?.toLowerCase()
  if (mode === 'light') return true
  if (mode === 'dark') return false
  const foregroundBackground = process.env.COLORFGBG?.split(';').at(-1)
  return foregroundBackground !== undefined && /^(?:7|15|[bcdef])$/iu.test(foregroundBackground)
}

const inlinePattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|~~[^~\n]+~~)/gu
const fencePattern = /^\s*(`{3,}|~{3,})(.*)$/u
const headingPattern = /^(#{1,6})\s+(.+)$/u
const listPattern = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/u
const quotePattern = /^\s*>\s?(.*)$/u
const hrPattern = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u
const tableSeparator = /^\s*\|?[\s:|-]+\|[\s:|-]*$/u

/** @returns Markdown-ish inline styling without touching ANSI sequences. */
export function formatInline(text: string, theme: Theme): string {
  return text.replace(inlinePattern, (match) => {
    if (match.startsWith('**')) return theme.bold('textStrong', match.slice(2, -2))
    if (match.startsWith('`')) return theme.fg('accent', match.slice(1, -1))
    if (match.startsWith('~~')) return theme.dim('textMuted', match.slice(2, -2))
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(match)
    return link === null ? match
      : theme.underline('primary', link[1] ?? '') + theme.dim('textMuted', ` (${link[2] ?? ''})`)
  })
}

/**
 * Render streamed assistant text into terminal lines.
 * Streaming mode skips expensive decorations and trims partial closing fences.
 * @param text - complete Markdown text accumulated so far.
 * @param width - available columns.
 * @param theme - palette for the current terminal.
 * @param streaming - whether more chunks are expected.
 */
export function renderMarkdown(text: string, width: number, theme: Theme, streaming = false): string[] {
  const contentWidth = Math.max(8, width - 2)
  const source = text.split('\n')
  if (streaming) {
    const last = source.at(-1)
    if (last !== undefined && /^`{1,2}$/u.test(last.trim())) source[source.length - 1] = ''
  }
  const lines: string[] = []
  let fence: string | undefined
  let table: string[][] = []
  const flushTable = (): void => {
    if (table.length === 0) return
    const cells = table.filter(row => !tableSeparator.test(row.join('|')))
    const columns = Math.max(...cells.map(row => row.length), 0)
    if (columns > 0) {
      const sizes = Array.from({ length: columns }, (_, index) =>
        Math.max(...cells.map(row => visibleWidth(row[index] ?? '')), 3))
      const sizesFit = sizes.map(size => Math.max(1, Math.min(size, Math.floor(contentWidth / columns) - 3)))
      for (const [rowIndex, row] of cells.entries()) {
        const body = sizesFit.map((size, index) => padTo(truncateTo(formatInline(row[index] ?? '', theme), size), size)).join(' │ ')
        lines.push(...wrapLine(`  ${theme.fg('textMuted', '│')} ${body}`, width))
        if (rowIndex === 0) lines.push(...wrapLine(`  ${theme.fg('textMuted', '├')}${'─'.repeat(Math.min(contentWidth, 40))}`, width))
      }
    }
    table = []
  }
  for (const raw of source) {
    if (raw.trim().startsWith('|') && !fence) {
      table.push(raw.trim().replace(/^\||\|$/gu, '').split('|').map(cell => cell.trim()))
      continue
    }
    flushTable()
    const opening = fencePattern.exec(raw)
    if (fence !== undefined) {
      if (opening !== null && opening[2]?.trim() === '') {
        lines.push(...wrapLine(`  ${theme.fg('textMuted', fence)}`, width))
        fence = undefined
      } else {
        lines.push(...wrapLine(`  ${theme.fg('text', raw)}`, width))
      }
      continue
    }
    if (opening !== null) {
      fence = opening[1] ?? ''
      lines.push(...wrapLine(`  ${theme.fg('textMuted', `${fence}${opening[2] ?? ''}`)}`, width))
      continue
    }
    const heading = headingPattern.exec(raw)
    if (heading !== null) {
      const label = heading[2] ?? ''
      lines.push(...wrapLine(`  ${theme.bold('primary', formatInline(label, theme))}`, width))
      continue
    }
    if (hrPattern.test(raw)) {
      lines.push(...wrapLine(`  ${theme.fg('border', '─'.repeat(Math.min(contentWidth, 60)))}`, width))
      continue
    }
    const quote = quotePattern.exec(raw)
    if (quote !== null) {
      lines.push(...wrapLine(`  ${theme.fg('borderFocus', symbols.bar)} ${theme.italic('textDim', formatInline(quote[1] ?? '', theme))}`, width))
      continue
    }
    const list = listPattern.exec(raw)
    if (list !== null) {
      const indentSource = list[1] ?? ''
      const markerText = list[2] ?? '-'
      const indent = '  '.repeat(Math.min(4, Math.floor(indentSource.length / 2)))
      const marker = /^\d/u.test(markerText) ? `${markerText} ` : `${theme.fg('accent', symbols.bullet)} `
      const body = formatInline(list[3] ?? '', theme)
      const wrapped = wrapLine(body, contentWidth - visibleWidth(indent) - 3)
      lines.push(...wrapped.map((line, index) => `  ${indent}${index === 0 ? marker : '  '}${line}`))
      continue
    }
    if (raw === '') {
      lines.push('')
      continue
    }
    lines.push(...wrapLine(`  ${formatInline(raw, theme)}`, width))
  }
  flushTable()
  if (fence !== undefined && !streaming) lines.push(...wrapLine(`  ${theme.fg('textMuted', fence)}`, width))
  return lines
}

/** @returns colored unified diff lines, clipped to the terminal width. */
export function renderDiff(text: string, width: number, theme: Theme): string[] {
  return text.split('\n').flatMap((line) => {
    const token: ColorToken = line.startsWith('+') ? 'diffAdded'
      : line.startsWith('-') ? 'diffRemoved'
        : line.startsWith('@@') ? 'primary' : 'text'
    return wrapLine(`  ${theme.fg(token, line)}`, width)
  })
}
