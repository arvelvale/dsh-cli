/** Reusable modal browsers for Host catalogs, plans, files and settings. */

import { stripVTControlCharacters } from 'node:util'
import { isRecord, type RemoteClient } from './remote-client.ts'
import type {
  DirectoryEntry, DirectoryListing, FilePreview, McpServerView, PlanDocument, PlanSnapshot,
  SessionSearchItem, SettingsNamespaceView, SkillEntry,
} from './remote-contract.ts'
import {
  graphemes, renderMarkdown, symbols, truncateTo, visibleWidth, wrapLine,
  type ColorToken, type Theme,
} from './tui-theme.ts'
import type { KeyEvent } from './tui-screen.ts'
import { frame, type Overlay } from './tui-overlay.ts'

/** What a panel hands back to the terminal client when it closes with a choice. */
export type PanelResult =
  | { readonly kind: 'insert'; readonly text: string }
  | { readonly kind: 'submit'; readonly text: string }
  | { readonly kind: 'session'; readonly id: string }

/** One visual row in a browser panel. */
export interface PanelItem {
  readonly label: string
  readonly detail?: string
  readonly badge?: string
  readonly tone?: ColorToken
  readonly search?: string
  readonly notes?: readonly string[]
}

/** Keyboard action available while the list is in command mode. */
export interface PanelAction<T, R> {
  /** `return`, a plain character (`r`), or a control combination (`ctrl+r`). */
  readonly key: string
  /** Short footer hint; omit for hidden actions. */
  readonly label?: string
  readonly run: (context: PanelContext<T, R>) => void | Promise<void>
}

/** Everything an action needs about the current selection. */
export interface PanelContext<T, R> {
  readonly value: T | undefined
  readonly item: PanelItem | undefined
  readonly index: number
  readonly panel: BrowserPanel<T, R>
}

/** Declarative description of one browser panel. */
export interface BrowserSpec<T, R> {
  readonly title: string
  readonly caption: string
  readonly load: () => Promise<readonly T[]>
  readonly item: (value: T) => PanelItem
  readonly actions?: readonly PanelAction<T, R>[]
  /** When present, Enter in typing mode re-runs the query against the Host. */
  readonly remoteFilter?: (query: string) => Promise<readonly T[]>
  readonly filterable?: boolean
  readonly initialFilter?: string
  readonly empty?: string
}

/** Host access shared by every panel opened from the interactive client. */
export interface PanelDeps {
  readonly client: RemoteClient
  readonly signal: AbortSignal
  /** Resolves (and lazily creates) the Session the panel should address. */
  readonly sessionId: () => Promise<string>
  /** Latest plan/todo projection observed for the active Session. */
  readonly snapshot: () => PlanSnapshot
}

interface Indexed<T> {
  readonly value: T
  readonly item: PanelItem
}

interface DocumentState {
  readonly title: string
  readonly text: string
  readonly markdown: boolean
  first: number
  count: number
}

/** A filterable, scrollable list with a detail pane and asynchronous actions. */
export class BrowserPanel<T, R> implements Overlay {
  readonly result: Promise<R | undefined>
  private readonly resolve: (value: R | undefined) => void
  private spec: BrowserSpec<T, R>
  private values: readonly T[] = []
  private rows: readonly Indexed<T>[] = []
  private query: string
  private typing: boolean
  private remoteMode = false
  private index = 0
  private first = 0
  private state: 'loading' | 'ready' | 'error' = 'loading'
  private error = ''
  private notice = ''
  private noticeTone: ColorToken = 'success'
  private busy = false
  private closed = false
  private generation = 0
  private document: DocumentState | undefined
  private docVisible = 8
  private listCapacity = 3
  private refresh: (() => void) | undefined

  /** @param spec - declarative panel content and actions. */
  constructor(spec: BrowserSpec<T, R>) {
    this.spec = spec
    this.query = spec.initialFilter ?? ''
    this.typing = spec.remoteFilter !== undefined && this.query === ''
    const pending = Promise.withResolvers<R | undefined>()
    this.result = pending.promise
    this.resolve = pending.resolve
    void this.reload()
  }

  /** Register the redraw callback so async loads repaint without a key press. */
  bindRefresh(refresh: () => void): void {
    this.refresh = refresh
  }

  /** Reload the catalog, discarding stale in-flight loads. */
  async reload(): Promise<void> {
    const generation = ++this.generation
    this.state = 'loading'
    this.notify()
    try {
      const values = await this.spec.load()
      if (generation !== this.generation || this.closed) return
      this.values = values
      this.state = 'ready'
      this.listCapacity = Math.max(3, values.length)
      this.refilter()
    } catch (error) {
      if (generation !== this.generation || this.closed) return
      this.values = []
      this.state = 'error'
      this.error = messageOf(error)
      this.refilter()
    }
    this.notify()
  }

  /** Swap the data source, used when a file browser enters another directory. */
  setLoader(load: () => Promise<readonly T[]>): Promise<void> {
    this.spec = { ...this.spec, load }
    this.index = 0
    this.first = 0
    return this.reload()
  }

  /** Change the caption shown above the list. */
  setCaption(caption: string): void {
    this.spec = { ...this.spec, caption }
    this.notify()
  }

  /** Show a transient action result in the footer. */
  setNotice(text: string, tone: ColorToken = 'success'): void {
    this.notice = text
    this.noticeTone = tone
    this.notify()
  }

  /** Open a scrollable document in place of the list; Esc returns to the list. */
  openDocument(title: string, text: string, markdown = false): void {
    this.document = { title, text: plain(text), markdown, first: 0, count: 0 }
    this.notify()
  }

  /** Resolve the panel with a choice and close it. */
  finish(value: R | undefined): void {
    if (this.closed) return
    this.closed = true
    this.resolve(value)
  }

  close(): void {
    this.finish(undefined)
  }

  /** @returns the value under the cursor, or undefined for an empty list. */
  get selected(): T | undefined {
    return this.rows[this.index]?.value
  }

  handleKey(event: KeyEvent): void {
    if (this.closed) return
    if (isQuit(event)) { this.close(); return }
    if (this.document !== undefined) { this.handleDocumentKey(event); return }
    if (this.typing) { this.handleTypingKey(event); return }
    if (event.name === 'escape') { this.close(); return }
    if (event.name === 'r' && event.ctrl) { void this.reload(); return }
    if (event.name === 'tab' || actionKey(event) === '/' || actionKey(event) === '?') {
      if (this.spec.filterable !== false) {
        this.typing = true
        this.remoteMode = false
        this.notify()
        return
      }
    }
    const delta = navigation(event)
    if (delta !== undefined) { this.move(delta); return }
    const key = event.name === 'return' ? 'return' : actionKey(event)
    const action = this.spec.actions?.find(candidate => candidate.key === key)
    if (action !== undefined && !this.busy) void this.run(action)
  }

  render(width: number, theme: Theme, rows = 24): readonly string[] {
    const budget = Math.max(9, Math.min(20, rows - 10))
    const content = Math.max(5, budget - 3)
    const inner = Math.max(20, width - 5)
    if (this.document !== undefined) {
      return this.renderDocument(width, theme, content, inner).lines
    }
    const detailRows = Math.max(2, Math.min(4, Math.floor(content / 3)))
    const maxListRows = Math.max(3, content - 2 - detailRows)
    // Fix the height when the catalog loads so filtering never makes the frame jump.
    const listRows = Math.min(maxListRows, this.state === 'ready' ? this.listCapacity : 3)
    const header = this.header(theme, inner)
    const body: string[] = [header]
    if (this.state === 'loading') {
      body.push(theme.fg('textMuted', `  ${spinner(theme)} 正在读取 Host…`))
      for (let index = 1; index < listRows; index += 1) body.push('')
    } else if (this.state === 'error') {
      body.push(theme.fg('error', `  ${symbols.failure} ${this.error}`))
      for (let index = 1; index < listRows; index += 1) body.push('')
    } else if (this.rows.length === 0) {
      body.push(theme.fg('textMuted', `  ${this.spec.empty ?? '没有可显示的条目'}`))
      for (let index = 1; index < listRows; index += 1) body.push('')
    } else {
      this.clampFirst(listRows)
      for (let offset = 0; offset < listRows; offset += 1) {
        const entry = this.rows[this.first + offset]
        body.push(entry === undefined ? '' : this.renderItem(entry, this.first + offset === this.index, inner, theme))
      }
    }
    body.push(theme.fg('border', symbols.horizontal.repeat(inner)))
    const selected = this.rows[this.index]?.item
    const notes = selected?.notes ?? []
    const detail = notes.flatMap(note => wrapLine(theme.fg('textDim', note), inner - 2)).slice(0, detailRows)
    for (let offset = 0; offset < detailRows; offset += 1) {
      body.push(detail[offset] === undefined ? '' : `  ${detail[offset]}`)
    }
    return frame(width, theme, `${this.spec.title} ${this.state === 'ready' ? `(${String(this.rows.length)})` : ''}`,
      body, this.footer(theme))
  }

  private handleTypingKey(event: KeyEvent): void {
    const { name } = event
    if (name === 'escape' || name === 'return' || name === 'tab') {
      this.typing = false
      const remote = this.spec.remoteFilter
      if (name === 'return' && remote !== undefined && this.query.trim() !== '') {
        const query = this.query.trim()
        // Host-side hits may match body text that is absent from the snippet,
        // so the returned rows must not be filtered again by the query locally.
        this.remoteMode = true
        this.index = 0
        this.first = 0
        void this.setLoader(() => remote(query)).then(() => { this.notify() })
      } else this.refilter()
      this.notify()
      return
    }
    if (name === 'backspace') {
      this.query = graphemes(this.query).slice(0, -1).join('')
      this.refilter()
      this.notify()
      return
    }
    if (name === 'text' || name === 'paste') {
      const text = (event.text ?? '').replace(/[\r\n]/gu, '')
      if (text !== '') { this.query = (this.query + text).slice(0, 120); this.refilter(); this.notify() }
    }
  }

  private handleDocumentKey(event: KeyEvent): void {
    if (event.name === 'escape') { this.document = undefined; this.notify(); return }
    if (event.name === 'r' && event.ctrl) { void this.reload(); return }
    if (actionKey(event) === 'i') {
      this.finish({ kind: 'insert', text: this.document?.text ?? '' } as unknown as R)
      return
    }
    const delta = navigation(event)
    const doc = this.document
    if (delta !== undefined && doc !== undefined) {
      const last = Math.max(0, doc.count - this.docVisible)
      if (delta === Number.NEGATIVE_INFINITY) doc.first = 0
      else if (delta === Number.POSITIVE_INFINITY) doc.first = last
      else doc.first = Math.max(0, Math.min(
        doc.first + Math.sign(delta) * (Math.abs(delta) >= 100 ? this.docVisible : 1), last))
      this.notify()
    }
  }

  private renderDocument(width: number, theme: Theme, content: number, inner: number): { lines: readonly string[] } {
    const doc = this.document
    if (doc === undefined) return { lines: [] }
    const lines = doc.markdown
      ? renderMarkdown(doc.text, inner - 2, theme, false)
      : doc.text.split('\n').flatMap(line => wrapLine(theme.fg('textDim', line), inner - 2))
    doc.count = lines.length
    const visible = Math.max(3, content - 1)
    this.docVisible = visible
    doc.first = Math.max(0, Math.min(doc.first, Math.max(0, lines.length - visible)))
    const caption = `${theme.fg('textDim', doc.title)}   ${theme.fg('textMuted', `${String(Math.min(doc.first + visible, lines.length))}/${String(lines.length)} 行`)}`
    const body = [caption, ...lines.slice(doc.first, doc.first + visible).map(line => `  ${line}`)]
    return {
      lines: frame(width, theme, this.spec.title, body,
        '↑↓ / PgUp PgDn 滚动  ·  I 插入输入框  ·  Esc 返回  ·  Ctrl+R 刷新'),
    }
  }

  private header(theme: Theme, inner: number): string {
    const left = theme.fg('textDim', this.spec.caption)
    const right = this.typing
      ? theme.fg('textMuted', '/ ') + theme.fg('textStrong', this.query) + theme.fg('accent', '▌')
      : this.query === ''
        ? theme.fg('textMuted', this.spec.filterable === false ? '' : '/ 筛选')
        : theme.fg('textMuted', `/ ${this.query}`)
    return columns(left, right, inner)
  }

  private renderItem(entry: Indexed<T>, active: boolean, inner: number, theme: Theme): string {
    const pointer = active ? theme.bold('primary', symbols.pointer) + ' ' : '  '
    const label = active ? theme.bold('primary', entry.item.label) : theme.fg('text', entry.item.label)
    const detail = entry.item.detail === undefined || entry.item.detail === ''
      ? '' : theme.fg('textDim', `  ${entry.item.detail}`)
    const badge = entry.item.badge === undefined || entry.item.badge === ''
      ? '' : theme.fg(entry.item.tone ?? 'textMuted', entry.item.badge)
    return columns(`${pointer}${label}${detail}`, badge, inner)
  }

  private refilter(): void {
    const needle = this.remoteMode ? '' : this.query.trim().toLowerCase()
    this.rows = this.values.map(value => ({ value, item: this.spec.item(value) }))
      .filter(entry => needle === '' || `${entry.item.label} ${entry.item.detail ?? ''} ${entry.item.search ?? ''}`
        .toLowerCase().includes(needle))
    this.index = Math.max(0, Math.min(this.index, this.rows.length - 1))
  }

  private clampFirst(listRows: number): void {
    if (this.index < this.first) this.first = this.index
    if (this.index >= this.first + listRows) this.first = this.index - listRows + 1
    this.first = Math.max(0, Math.min(this.first, Math.max(0, this.rows.length - listRows)))
  }

  private move(delta: number): void {
    if (this.rows.length === 0) return
    const step = Math.abs(delta) >= 100 ? 8 : 1
    if (delta === Number.NEGATIVE_INFINITY) { this.index = 0; this.notify(); return }
    if (delta === Number.POSITIVE_INFINITY) { this.index = this.rows.length - 1; this.notify(); return }
    this.index = Math.max(0, Math.min(this.rows.length - 1, this.index + Math.sign(delta) * step))
    this.notify()
  }

  private context(): PanelContext<T, R> {
    const entry = this.rows[this.index]
    return { value: entry?.value, item: entry?.item, index: this.index, panel: this }
  }

  private async run(action: PanelAction<T, R>): Promise<void> {
    this.busy = true
    this.notice = ''
    this.notify()
    try {
      await action.run(this.context())
    } catch (error) {
      this.setNotice(messageOf(error), 'error')
    } finally {
      this.busy = false
      this.notify()
    }
  }

  private footer(theme: Theme): string {
    if (this.notice !== '') return `${theme.fg(this.noticeTone, this.notice)}  ·  ${this.baseFooter()}`
    return this.baseFooter()
  }

  private baseFooter(): string {
    if (this.typing) return '输入关键词  ·  Enter 搜索/返回  ·  Backspace 删除  ·  Esc 退出输入'
    if (this.document !== undefined) return 'Esc 返回'
    const hints = ['↑↓ 选择', ...(this.spec.actions ?? []).flatMap(action => action.label === undefined ? [] : [action.label])]
    if (this.spec.filterable !== false) hints.push('/ 筛选')
    hints.push('Ctrl+R 刷新', 'Esc 关闭')
    return hints.join('  ·  ')
  }

  private notify(): void {
    this.refresh?.()
  }
}

/** A standalone scrollable Markdown / text panel, used for the plan view. */
export class DocumentPanel<R> implements Overlay {
  readonly result: Promise<R | undefined>
  private readonly resolve: (value: R | undefined) => void
  private lines: readonly string[] = []
  private text = ''
  private state: 'loading' | 'ready' | 'error' = 'loading'
  private error = ''
  private first = 0
  private visible = 8
  private closed = false
  private generation = 0
  private refresh: (() => void) | undefined

  /**
   * @param title - frame label.
   * @param caption - short source description.
   * @param load - asynchronous Markdown or text source.
   * @param markdown - whether to render Markdown.
   */
  constructor(
    readonly title: string,
    readonly caption: string,
    readonly load: () => Promise<string>,
    readonly markdown = true,
  ) {
    const pending = Promise.withResolvers<R | undefined>()
    this.result = pending.promise
    this.resolve = pending.resolve
    void this.reload()
  }

  bindRefresh(refresh: () => void): void {
    this.refresh = refresh
  }

  /** Re-read the document from its source. */
  async reload(): Promise<void> {
    const generation = ++this.generation
    this.state = 'loading'
    this.notify()
    try {
      const text = await this.load()
      if (generation !== this.generation || this.closed) return
      this.text = plain(text)
      this.state = 'ready'
    } catch (error) {
      if (generation !== this.generation || this.closed) return
      this.state = 'error'
      this.error = messageOf(error)
    }
    this.notify()
  }

  finish(value: R | undefined): void {
    if (this.closed) return
    this.closed = true
    this.resolve(value)
    this.refresh?.()
  }

  close(): void {
    this.finish(undefined)
  }

  handleKey(event: KeyEvent): void {
    if (this.closed) return
    if (isQuit(event) || event.name === 'escape') { this.close(); return }
    if (event.name === 'r' && event.ctrl) { void this.reload(); return }
    if (actionKey(event) === 'i') { this.finish({ kind: 'insert', text: this.text } as unknown as R); return }
    const delta = navigation(event)
    if (delta !== undefined) {
      const step = delta === Number.NEGATIVE_INFINITY ? -this.lines.length
        : delta === Number.POSITIVE_INFINITY ? this.lines.length
          : Math.sign(delta) * (Math.abs(delta) >= 100 ? this.visible : 1)
      this.first = Math.max(0, Math.min(this.first + step, Math.max(0, this.lines.length - this.visible)))
      this.notify()
    }
  }

  render(width: number, theme: Theme, rows = 24): readonly string[] {
    const budget = Math.max(9, Math.min(20, rows - 10))
    const content = Math.max(5, budget - 3)
    const inner = Math.max(20, width - 5)
    this.visible = Math.max(3, content - 1)
    this.lines = this.state === 'ready'
      ? this.markdown ? renderMarkdown(this.text, inner - 2, theme, false)
        : this.text.split('\n').flatMap(line => wrapLine(theme.fg('textDim', line), inner - 2))
      : this.state === 'loading' ? [theme.fg('textMuted', `${spinner(theme)} 正在读取 Host…`)]
        : [theme.fg('error', `${symbols.failure} ${this.error}`)]
    this.first = Math.max(0, Math.min(this.first, Math.max(0, this.lines.length - this.visible)))
    const caption = columns(theme.fg('textDim', this.caption),
      theme.fg('textMuted', `${String(Math.min(this.first + this.visible, this.lines.length))}/${String(this.lines.length)} 行`), inner)
    const body = [caption, ...this.lines.slice(this.first, this.first + this.visible).map(line => `  ${line}`)]
    return frame(width, theme, this.title, body,
      '↑↓ / PgUp PgDn 滚动  ·  I 插入输入框  ·  Ctrl+R 刷新  ·  Esc 关闭')
  }

  private notify(): void {
    this.refresh?.()
  }
}

/** @returns a browser for the Host's user-invocable Skill catalog. */
export function skillsPanel(deps: PanelDeps): BrowserPanel<SkillEntry, PanelResult> {
  return new BrowserPanel<SkillEntry, PanelResult>({
    title: '技能',
    caption: 'Host 技能目录',
    load: async () => (await deps.client.skills(await deps.sessionId())).skills,
    item: skill => ({
      label: skill.name,
      detail: skill.description,
      badge: skill.modelInvocable ? '模型可调用' : '仅手动',
      tone: skill.modelInvocable ? 'success' : 'textMuted',
      search: `${skill.name} ${skill.description} ${skill.whenToUse ?? ''}`,
      notes: [
        skill.description,
        ...(skill.whenToUse === undefined ? [] : [`适用：${skill.whenToUse}`]),
        ...(skill.path === undefined ? [] : [`路径：${skill.path}`]),
        `调用：/${skill.name}`,
      ],
    }),
    actions: [
      { key: 'return', label: 'Enter 插入 /命令', run: ({ value, panel }) => {
        if (value !== undefined) panel.finish({ kind: 'insert', text: `/${value.name} ` })
      } },
      { key: 's', label: 'S 直接发送', run: ({ value, panel }) => {
        if (value !== undefined) panel.finish({ kind: 'submit', text: `/${value.name}` })
      } },
    ],
    empty: '当前会话没有可用技能',
  })
}

interface McpRow {
  readonly name: string
  readonly configured: boolean
  readonly status: Readonly<Record<string, unknown>>
  readonly enabled: boolean | undefined
  readonly entry: unknown
}

/** @returns a browser for managed MCP servers with restart, probe and enable actions. */
export function mcpPanel(deps: PanelDeps): BrowserPanel<McpRow, PanelResult> {
  const load = async (): Promise<readonly McpRow[]> => {
    let views: readonly McpServerView[] = []
    try { views = await deps.client.mcpServers(deps.signal) }
    catch { /* The settings namespace still describes configured servers. */ }
    let servers: Readonly<Record<string, unknown>> = {}
    try {
      const described = await deps.client.settingsDescribe()
      const namespace = described.namespaces.find(item => item.ns.includes('dsh-mcp-manager'))
      if (namespace !== undefined && isRecord(namespace.value) && isRecord(namespace.value.servers)) {
        servers = namespace.value.servers
      }
    } catch { /* Read-only or absent settings still allow status browsing. */ }
    const names = new Set([...views.map(view => view.name), ...Object.keys(servers)])
    return [...names].sort().map((name) => {
      const view = views.find(item => item.name === name)
      const entry = servers[name]
      const enabled = isRecord(entry) ? entry.enabled !== false : undefined
      return {
        name,
        configured: view?.configured ?? true,
        status: view?.status ?? (enabled === false ? { state: 'disabled' } : { state: 'unknown' }),
        enabled,
        entry,
      }
    })
  }
  return new BrowserPanel<McpRow, PanelResult>({
    title: 'MCP 服务',
    caption: 'Host MCP 管理器',
    load,
    item: (row) => {
      const [badge, tone] = mcpBadge(row.status)
      return {
        label: row.name,
        detail: mcpDetail(row),
        badge,
        tone,
        search: `${row.name} ${scalar(row.status.state)}`,
        notes: [
          `状态：${badge}${row.configured ? '' : '（配置已移除）'}`,
          `开关：${row.enabled === false ? '已停用' : row.enabled === undefined ? '由 Host 管理' : '已启用'}`,
          `传输：${mcpTransport(row.entry)}`,
          ...(typeof row.status.lastError === 'string' ? [`诊断：${row.status.lastError}`] : []),
        ],
      }
    },
    actions: [
      { key: 'return', label: 'Enter 探测', run: async ({ value, panel }) => { await probe(value, panel) } },
      { key: 'p', run: async ({ value, panel }) => { await probe(value, panel) } },
      { key: 'r', label: 'R 重启', run: async ({ value, panel }) => {
        if (value === undefined) return
        await deps.client.mcpRestart(value.name)
        await panel.reload()
        panel.setNotice(`已请求重启 ${value.name}`)
      } },
      { key: 'e', label: 'E 启停', run: async ({ value, panel }) => {
        if (value === undefined) return
        const next = value.enabled === false
        await deps.client.setMcpEnabled(value.name, next)
        await panel.reload()
        panel.setNotice(`已${next ? '启用' : '停用'} ${value.name}`)
      } },
    ],
    empty: 'Host 没有配置 MCP 服务',
  })

  async function probe(value: McpRow | undefined, panel: BrowserPanel<McpRow, PanelResult>): Promise<void> {
    if (value === undefined) return
    const result = await deps.client.mcpProbe(value.name)
    panel.setNotice(result.ok
      ? `探测成功 · ${String(result.toolNames?.length ?? 0)} 个工具 · ${String(result.durationMs ?? 0)}ms`
      : `探测失败（${result.stage ?? '未知阶段'}）：${result.error ?? 'Host 未提供诊断'}`,
    result.ok ? 'success' : 'error')
  }
}

function mcpBadge(status: Readonly<Record<string, unknown>>): [string, ColorToken] {
  switch (status.state) {
    case 'connected': return [`已连接 · ${scalar(status.toolCount, '0')} 工具`, 'success']
    case 'connecting': return ['连接中', 'warning']
    case 'reconnecting': return [`重连中 · 第 ${scalar(status.attempt, '0')} 次`, 'warning']
    case 'disabled': return ['已停用', 'textMuted']
    case 'failed': return ['连接失败', 'error']
    case 'closed': return ['已关闭', 'textMuted']
    case 'waiting-credentials': return ['等待凭据', 'warning']
    default: return ['状态未知', 'textDim']
  }
}

function mcpDetail(row: McpRow): string {
  if (typeof row.status.lastError === 'string') return row.status.lastError
  if (isRecord(row.entry)) {
    if (typeof row.entry.url === 'string') return row.entry.url
    if (typeof row.entry.command === 'string') return row.entry.command
  }
  return row.configured ? '' : '配置已移除'
}

function mcpTransport(entry: unknown): string {
  if (!isRecord(entry)) return '未公开'
  if (entry.transport === 'streamable-http') return `HTTP ${scalar(entry.url)}`
  if (entry.transport === 'stdio') return `stdio ${scalar(entry.command)}`
  return typeof entry.transport === 'string' ? entry.transport : '未公开'
}

/** @returns a scrollable view of plan mode, the todo list and the last submitted plan. */
export function planPanel(deps: PanelDeps): DocumentPanel<PanelResult> {
  return new DocumentPanel<PanelResult>('计划', '会话计划与任务清单', async () => {
    const snapshot = deps.snapshot()
    const document = await deps.client.planDocument(await deps.sessionId()).catch(() => undefined)
    return planText(snapshot, document)
  })
}

/** @returns the Markdown shown by the plan panel. */
export function planText(snapshot: PlanSnapshot, document: PlanDocument | undefined): string {
  const mode = snapshot.mode.active ? snapshot.mode.pending ? '计划模式 · 等待确认' : '计划模式 · 进行中'
    : '普通模式'
  const todos = snapshot.todos.length === 0 ? ['_暂无任务_']
    : snapshot.todos.map(item => `${todoMark(item.status)}  ${item.content.replace(/\s+/gu, ' ')}`)
  return [
    `# 计划 · ${mode}`,
    '',
    '## 任务清单',
    ...todos,
    '',
    '## 最近提交的计划',
    '',
    document === undefined ? '_当前会话还没有提交过计划。模型可在计划模式下调用 exit_plan_mode 提交。_' : document.markdown,
  ].join('\n')
}

function todoMark(status: string): string {
  return status === 'completed' ? '✓' : status === 'in_progress' ? '▸' : '○'
}

/** @returns a browser over Host Session search results. */
export function searchPanel(deps: PanelDeps, query = ''): BrowserPanel<SessionSearchItem, PanelResult> {
  return new BrowserPanel<SessionSearchItem, PanelResult>({
    title: '搜索会话',
    caption: 'Host 会话全文检索',
    initialFilter: query,
    remoteFilter: async needle => (await deps.client.searchSessions(needle)).items,
    load: async () => query.trim() === ''
      ? (await deps.client.list()).items.map(item => ({
        sessionId: item.sessionId,
        snippet: typeof item.cwd === 'string' ? item.cwd : '已有会话',
      }))
      : (await deps.client.searchSessions(query)).items,
    item: hit => ({
      label: hit.sessionId.slice(0, 12),
      detail: hit.snippet.replace(/\s+/gu, ' ').trim(),
      badge: '会话',
      tone: 'textDim',
      search: `${hit.sessionId} ${hit.snippet}`,
      notes: [`会话 ${hit.sessionId}`, hit.snippet.replace(/\s+/gu, ' ').trim()],
    }),
    actions: [{ key: 'return', label: 'Enter 接续会话', run: ({ value, panel }) => {
      if (value !== undefined) panel.finish({ kind: 'session', id: value.sessionId })
    } }],
    empty: '没有匹配的会话',
  })
}

interface FileRow extends DirectoryEntry {
  readonly path: string
}

/** @returns a browser over the Host's protected workspace file route. */
export function filePanel(deps: PanelDeps, initial = ''): BrowserPanel<FileRow, PanelResult> {
  let current = initial
  const listing = async (path: string): Promise<readonly FileRow[]> => {
    const result = await deps.client.workspaceFiles(path, 'list') as DirectoryListing
    return result.entries.map(entry => ({ ...entry, path: joinPath(path, entry.name) }))
  }
  const enter = (path: string, panel: BrowserPanel<FileRow, PanelResult>): Promise<void> => {
    current = path
    panel.setCaption(path === '' ? '工作区根目录' : `工作区 /${path}`)
    return panel.setLoader(() => listing(path))
  }
  return new BrowserPanel<FileRow, PanelResult>({
    title: '文件',
    caption: current === '' ? '工作区根目录' : `工作区 /${current}`,
    load: () => listing(current),
    item: entry => ({
      label: entry.kind === 'directory' ? `${entry.name}/` : entry.name,
      detail: entry.kind === 'directory' ? '目录' : '文件',
      badge: entry.kind === 'directory' ? '可进入' : '可预览',
      tone: entry.kind === 'directory' ? 'primary' : 'textMuted',
      notes: [`路径：/${entry.path}`, entry.kind === 'directory' ? 'Enter 进入目录' : 'Enter 预览文本'],
    }),
    actions: [
      { key: 'return', label: 'Enter 打开', run: async ({ value, panel }) => {
        if (value === undefined) return
        if (value.kind === 'directory') { await enter(value.path, panel); return }
        const result = await deps.client.workspaceFiles(value.path, 'preview') as FilePreview
        panel.openDocument(value.name, result.text === '' ? '（空文件）' : result.text, false)
        if (result.truncated) panel.setNotice('预览已截断到前 128 KiB', 'warning')
      } },
      { key: 'u', label: 'U 上一级', run: async ({ panel }) => {
        const parent = parentPath(current)
        if (parent === current) return
        await enter(parent, panel)
      } },
      { key: 'left', run: async ({ panel }) => {
        const parent = parentPath(current)
        if (parent !== current) await enter(parent, panel)
      } },
    ],
    empty: '目录为空，或 Host 未开放工作区文件',
  })
}

/** @returns a read-only browser over Host Settings namespaces. */
export function settingsPanel(deps: PanelDeps): BrowserPanel<SettingsNamespaceView, PanelResult> {
  return new BrowserPanel<SettingsNamespaceView, PanelResult>({
    title: '配置',
    caption: 'Host 设置命名空间',
    load: async () => (await deps.client.settingsDescribe()).namespaces,
    item: namespace => ({
      label: namespace.ns,
      detail: `revision ${String(namespace.revision)}`,
      badge: typeof namespace.applies === 'string' ? namespace.applies : '',
      tone: 'textDim',
      search: `${namespace.ns} ${JSON.stringify(namespace.value ?? '')}`,
      notes: [`命名空间 ${namespace.ns}`, `revision ${String(namespace.revision)}`, 'Enter 查看配置值'],
    }),
    actions: [{ key: 'return', label: 'Enter 查看值', run: ({ value, panel }) => {
      if (value === undefined) return
      const text = value.value === undefined ? '{}' : JSON.stringify(value.value, null, 2)
      panel.openDocument(value.ns, text, false)
    } }],
    empty: 'Host 没有可描述的配置命名空间',
  })
}

function joinPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function columns(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right)
  const available = width - rightWidth - 2
  if (rightWidth === 0) return truncateTo(left, width)
  if (available < 12) return truncateTo(left, width)
  const fitted = truncateTo(left, available)
  return `${fitted}${' '.repeat(Math.max(2, width - visibleWidth(fitted) - rightWidth))}${right}`
}

function navigation(event: KeyEvent): number | undefined {
  switch (event.name) {
    case 'up': return -1
    case 'down': return 1
    case 'pageup': return -100
    case 'pagedown': return 100
    case 'home': return Number.NEGATIVE_INFINITY
    case 'end': return Number.POSITIVE_INFINITY
    default: return undefined
  }
}

function actionKey(event: KeyEvent): string {
  if (event.ctrl) return `ctrl+${event.name}`
  return event.name === 'text' ? event.text ?? '' : event.name
}

function isQuit(event: KeyEvent): boolean {
  return event.ctrl && (event.name === 'c' || event.name === 'd')
}

function spinner(theme: Theme): string {
  const frames = symbols.spinner
  return theme.fg('accent', frames[Math.floor(Date.now() / 80) % frames.length] ?? frames[0])
}

/** Render an unknown Host scalar without falling back to Object stringification. */
function scalar(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return fallback
}

function plain(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu, '')
}

function messageOf(error: unknown): string {
  return plain(error instanceof Error ? error.message : String(error)).slice(0, 220)
}
