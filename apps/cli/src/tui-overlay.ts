/** Modal overlays for model selection and hidden credential entry. */

import {
  graphemes, padTo, symbols, truncateTo, visibleWidth, type Theme,
} from './tui-theme.ts'
import type { KeyEvent } from './tui-screen.ts'
import type { ModelCatalog, ModelSelection } from './remote-contract.ts'

interface Option extends ModelSelection {
  readonly name: string
}

/** Common overlay surface. `rows` is the terminal height, when known. */
export interface Overlay {
  render(width: number, theme: Theme, rows?: number): readonly string[]
  handleKey(key: KeyEvent): void
  close(): void
  /** Optional: panels use this to repaint when asynchronous data arrives. */
  bindRefresh?(refresh: () => void): void
}

/** Draw a bordered modal surface. Rows are already styled plain-text lines. */
export function frame(width: number, theme: Theme, label: string, rows: readonly string[], footer: string): string[] {
  const outer = Math.max(24, width - 1)
  const inner = outer - 4
  const title = `${symbols.horizontal} ${label} `
  const top = theme.fg('borderFocus', symbols.topLeft + title
    + symbols.horizontal.repeat(Math.max(0, outer - 2 - visibleWidth(title))) + symbols.topRight)
  const bottom = theme.fg('border', symbols.bottomLeft + symbols.horizontal.repeat(outer - 2) + symbols.bottomRight)
  return [
    top,
    ...rows.map(row => `${theme.fg('border', symbols.vertical)} ${padTo(truncateTo(row, inner), inner)} ${theme.fg('border', symbols.vertical)}`),
    bottom,
    `  ${theme.fg('textMuted', truncateTo(footer, outer))}`,
  ]
}

/** Keyboard-driven model catalog browser drawn above the prompt. */
export class ModelSelector implements Overlay {
  private readonly options: readonly Option[]
  private filtered: readonly Option[]
  private query = ''
  private index = 0
  private first = 0
  private closed = false
  readonly result: Promise<ModelSelection | undefined>
  private readonly resolve: (value: ModelSelection | undefined) => void

  /**
   * @param catalog - models offered by the Host.
   * @param current - selection highlighted initially.
   * @param defaultSelection - model used when no Session-specific choice exists.
   */
  constructor(catalog: ModelCatalog, current: ModelSelection | undefined, defaultSelection: ModelSelection) {
    this.options = catalog.groups.flatMap(group => group.models.map(item => ({
      provider: group.id, model: item.id, name: item.name || item.id,
    })))
    const active = current ?? defaultSelection
    this.currentProvider = active.provider
    this.currentModel = active.model
    this.filtered = this.options
    this.index = Math.max(0, this.options.findIndex(option =>
      option.provider === active.provider && option.model === active.model))
    const pending = Promise.withResolvers<ModelSelection | undefined>()
    this.result = pending.promise
    this.resolve = pending.resolve
  }

  /** @returns whether the catalog has any selectable model. */
  get empty(): boolean {
    return this.options.length === 0
  }

  render(width: number, theme: Theme): readonly string[] {
    const outer = Math.max(24, width - 1)
    const height = Math.min(8, Math.max(3, Math.min(this.filtered.length, 8)))
    this.first = Math.max(0, Math.min(this.first, this.index), this.index - height + 1)
    const rows: string[] = []
    const search = this.query === ''
      ? theme.fg('textMuted', '输入名称筛选')
      : theme.fg('textStrong', `/ ${this.query}`) + theme.fg('accent', '▌')
    rows.push(`${theme.fg('textDim', '  Host 模型目录')}   ${search}`)
    for (const [offset, option] of this.filtered.slice(this.first, this.first + height).entries()) {
      const active = this.first + offset === this.index
      const pointer = active ? theme.bold('primary', symbols.pointer) + ' ' : '  '
      const name = active ? theme.bold('primary', option.name) : theme.fg('text', option.name)
      const detail = `${option.provider}/${option.model}`
      const isCurrent = option.provider === this.currentProvider && option.model === this.currentModel
      const tail = isCurrent ? theme.fg('success', '  ← 当前') : ''
      rows.push(`${pointer}${name}${theme.fg('textMuted', `  ${detail}`)}${tail}`)
    }
    if (this.filtered.length === 0) rows.push(theme.fg('textMuted', '  没有匹配的模型'))
    rows.push(theme.fg('border', symbols.horizontal.repeat(Math.max(0, outer - 6))))
    return frame(width, theme, '选择模型', rows, '↑↓ 选择  ·  Enter 确认  ·  Esc 返回  ·  直接输入可筛选')
  }

  private currentProvider = ''
  private currentModel = ''

  /** Highlight the Host's current selection. */
  setCurrent(selection: ModelSelection): void {
    this.currentProvider = selection.provider
    this.currentModel = selection.model
  }

  handleKey(key: KeyEvent): void {
    if (this.closed) return
    const { name, ctrl } = key
    if (name === 'escape' || name === 'c' && ctrl || name === 'd' && ctrl) { this.close(); return }
    if (name === 'return') {
      const option = this.filtered[this.index]
      if (option !== undefined) this.finish({ provider: option.provider, model: option.model })
      return
    }
    if (name === 'up') { this.move(-1); return }
    if (name === 'down') { this.move(1); return }
    if (name === 'backspace') { this.query = graphemes(this.query).slice(0, -1).join(''); this.refilter(); return }
    if (name === 'text' || name === 'paste') {
      const text = key.text ?? ''
      if (text === '') return
      this.query = (this.query + text.replace(/\n/gu, '')).slice(0, 60)
      this.refilter()
    }
  }

  private move(direction: number): void {
    if (this.filtered.length === 0) return
    this.index = (this.index + direction + this.filtered.length) % this.filtered.length
  }

  private refilter(): void {
    const needle = this.query.trim().toLowerCase()
    this.filtered = this.options.filter(option =>
      `${option.name} ${option.provider}/${option.model}`.toLowerCase().includes(needle))
    this.index = 0
    this.first = 0
  }

  private finish(selection: ModelSelection | undefined): void {
    if (this.closed) return
    this.closed = true
    this.resolve(selection)
  }

  close(): void {
    this.finish(undefined)
  }
}

/** Hidden API Key entry that never echoes the secret. */
export class SecretPrompt implements Overlay {
  private value = ''
  private closed = false
  readonly result: Promise<string | undefined>
  private readonly resolve: (value: string | undefined) => void

  constructor() {
    const pending = Promise.withResolvers<string | undefined>()
    this.result = pending.promise
    this.resolve = pending.resolve
  }

  render(width: number, theme: Theme): readonly string[] {
    const masked = this.value === ''
      ? theme.fg('textMuted', '粘贴或输入 API Key')
      : theme.fg('textStrong', '•'.repeat(Math.min(this.value.length, 48)))
        + (this.value.length > 48 ? theme.fg('textMuted', ` +${String(this.value.length - 48)}`) : '')
    const rows = [
      theme.fg('textDim', '  DeepSeek API Key'),
      `  ${theme.fg('primary', symbols.userBullet)} ${masked}${theme.fg('accent', '▌')}`,
      theme.fg('border', symbols.horizontal.repeat(Math.max(0, width - 8))),
      theme.fg('textMuted', '  输入内容不会回显，也不会写入历史'),
    ]
    return frame(width, theme, '登录', rows, 'Enter 保存  ·  Esc / Ctrl+C 取消')
  }

  handleKey(key: KeyEvent): void {
    if (this.closed) return
    const { name, ctrl } = key
    if (name === 'escape' || name === 'c' && ctrl) { this.finish(undefined); return }
    if (name === 'return') { this.finish(this.value.trim() === '' ? undefined : this.value.trim()); return }
    if (name === 'backspace') { this.value = graphemes(this.value).slice(0, -1).join(''); return }
    if (name === 'text' || name === 'paste') {
      const text = (key.text ?? '').replace(/[\r\n]/gu, '')
      this.value += text
    }
  }

  private finish(value: string | undefined): void {
    if (this.closed) return
    this.closed = true
    this.resolve(value)
  }

  close(): void {
    this.finish(undefined)
  }
}
