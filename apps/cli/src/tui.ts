/** SSH-friendly interactive client for an existing DSH daemon. */

import { randomUUID } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { stripVTControlCharacters, parseArgs } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { isRecord, RemoteClient, RemoteFailure, type PromptImageType, type RemoteApproval } from './remote-client.ts'
import type {
  DirectoryListing, ModelCatalog, ModelSelection, PlanSnapshot,
  SessionEvent, SessionListValue, SessionOpening, TodoItem,
} from './remote-contract.ts'
import {
  appendAssistantRow, changedFiles, compactRows, displayRows, unifiedDiff, type DisplayRow,
} from './remote-presentation.ts'
import { clipboardImageLimit, readClipboardImage } from './tui-clipboard.ts'
import { commandHelp, completeCommand, readProviderKey, welcome, type TerminalStyle } from './tui-input.ts'
import { openModelPicker } from './tui-model.ts'
import { darkPalette, lightPalette, prefersLight, Theme, renderDiff, type Palette } from './tui-theme.ts'
import { TerminalScreen } from './tui-screen.ts'
import { Editor, type EditorStatus } from './tui-editor.ts'
import { TranscriptView } from './tui-view.ts'
import { ModelSelector, SecretPrompt, type Overlay } from './tui-overlay.ts'
import {
  filePanel, mcpPanel, planPanel, planText, searchPanel, settingsPanel, skillsPanel,
  type PanelDeps, type PanelResult,
} from './tui-panels.ts'
import type { Block, BlockKind } from './tui-blocks.ts'
import { TUI_VERSION } from './tui-version.ts'

const imageTypes = new Map<string, PromptImageType>([
  ['.png', 'image/png'], ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'],
])

interface ImageInfo {
  readonly name: string
  readonly size: number
}

type DraftImage = ImageInfo & (
  | { readonly kind: 'uploaded'; readonly receipt: string }
  | { readonly kind: 'clipboard'; readonly body: Blob }
)

interface RunOptions {
  readonly client: RemoteClient
  readonly url: string
  readonly inventory: SessionListValue
  readonly initialSession?: string
  readonly signal: AbortSignal
  readonly pasteShortcut?: string
  readonly terminal: boolean
}

// Node 24 accepts Undici WebSocketInit in addition to the DOM protocols argument.
const NodeWebSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: { headers: Readonly<Record<string, string>> }): WebSocket
}

/** Start the terminal app after the selected profile finishes mounting.
 * @param ctx - terminal profile Cordis context.
 * @param config - whether to connect to the Host mounted in this profile.
 */
export function apply(ctx: Context, config?: { local?: boolean }): void {
  const args = ctx.get('cmdlineArgs')
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (args === undefined || ready === undefined || exit === undefined) throw new Error('dsh tui requires the profile launcher')
  const local = config?.local === true
  const lifetime = new AbortController()
  ctx.effect(() => {
    const cancel = ready.onReady(() => {
      void run(ctx, local ? [] : args.get(), lifetime.signal, local).then(exit, (error: unknown) => {
        process.stderr.write(`dsh-cli tui: ${safe(error instanceof Error ? error.message : String(error))}\n`)
        exit(1)
      })
    })
    return () => {
      cancel()
      lifetime.abort()
    }
  }, 'dsh tui: terminal lifetime')
}

function safe(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu, '')
}

function unquotePath(argument: string): string {
  const quoted = argument.length >= 2 && (argument[0] === '"' || argument[0] === "'") && argument.at(-1) === argument[0]
  return quoted ? argument.slice(1, -1) : argument
}

function readSelection(value: unknown): ModelSelection | undefined {
  return isRecord(value) && typeof value.provider === 'string' && typeof value.model === 'string'
    ? { provider: value.provider, model: value.model }
    : undefined
}

function projectedModel(value: unknown): ModelSelection | undefined {
  return isRecord(value) ? readSelection(value.next) ?? readSelection(value.lastUsed) : undefined
}

function shortCwd(): string {
  const parts = process.cwd().split(/[\\/]/u).filter(part => part !== '')
  return parts.length <= 2 ? join(...parts) : `${symbolsEllipsis()} ${parts.slice(-2).join('/')}`
}

function symbolsEllipsis(): string {
  return '…'
}

/** Resolve the active Session, creating one when the client has not attached yet. */
async function ensureSessionFor(
  client: RemoteClient, current: () => string | undefined, attach: (id: string) => void,
): Promise<string> {
  const existing = current()
  if (existing !== undefined) return existing
  const { sessionId } = await client.create()
  attach(sessionId)
  return sessionId
}

interface PlanTracker {
  snapshot(): PlanSnapshot
  adopt(values: unknown): void
  apply(event: SessionEvent): void
  reset(): void
}

/** Keep the plan/todo projection current for both the full TUI and the line fallback. */
function createPlanTracker(): PlanTracker {
  let snapshot: PlanSnapshot = { mode: { active: false, pending: false }, todos: [] }
  return {
    snapshot: () => snapshot,
    adopt: (values) => {
      if (!isRecord(values)) return
      const mode = isRecord(values.plan)
        ? { active: values.plan.active === true, pending: values.plan.pending === true }
        : snapshot.mode
      const todos = values.todos === null ? []
        : Array.isArray(values.todos) ? parseTodos(values.todos) : snapshot.todos
      snapshot = { ...snapshot, mode, todos }
    },
    apply: (event) => {
      const data = event.data
      if (!isRecord(data)) return
      if (event.type === 'plan/mode') {
        snapshot = { ...snapshot, mode: { active: data.active === true, pending: false } }
      } else if (event.type === 'todo/write' && Array.isArray(data.todos)) {
        snapshot = { ...snapshot, todos: parseTodos(data.todos) }
      }
    },
    reset: () => { snapshot = { mode: { active: false, pending: false }, todos: [] } },
  }
}

function parseTodos(value: readonly unknown[]): readonly TodoItem[] {
  return value.filter(isRecord).map(item => ({
    content: typeof item.content === 'string' ? item.content : '',
    status: typeof item.status === 'string' ? item.status : 'pending',
  })).filter(item => item.content !== '')
}

function displayBlock(row: DisplayRow, live = false, elapsedMs?: number): Block {
  const kind: BlockKind = row.kind === 'subagent' ? 'tool' : row.kind === 'file' ? 'system' : row.kind
  return {
    id: row.key,
    kind,
    title: row.title,
    text: row.text,
    ...(row.path === undefined ? {} : { meta: row.path }),
    ...(row.changesSeq === undefined ? {} : { changesSeq: row.changesSeq }),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    status: live ? 'running' : row.kind === 'error' ? 'error' : 'done',
  }
}

async function run(ctx: Context, args: readonly string[], signal: AbortSignal, local: boolean): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      url: { type: 'string' },
      session: { type: 'string', short: 's' },
      resume: { type: 'string' },
      version: { type: 'boolean', short: 'V' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.version === true) {
    process.stdout.write(`${TUI_VERSION}\n`)
    return 0
  }
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true
  const canRedraw = terminal && process.env.TERM !== 'dumb'
  const pasteShortcut = canRedraw ? (process.platform === 'win32' ? 'Alt+V' : 'Ctrl+V') : undefined
  if (values.help === true) {
    process.stdout.write(`dsh-cli tui [--url URL] [--session ID]\ndsh-cli --version\n\n${commandHelp(process.stdout.columns, pasteShortcut)}\n`)
    return 0
  }
  const tokenFile = process.env.DSH_DAEMON_TOKEN_FILE
  const token = process.env.DSH_DAEMON_TOKEN ?? (tokenFile === undefined ? '' : (await readFile(tokenFile, 'utf8')).trimEnd())
  const localOrigin = local ? ctx.get('webServer')?.getOrigin() : undefined
  if (local && localOrigin === undefined) throw new Error('本地 Host 未启动')
  const url = localOrigin ?? values.url ?? process.env.DSH_DAEMON_URL ?? 'http://127.0.0.1:3080'
  const client = new RemoteClient(url, token, {
    id: randomUUID,
    socket: (address, headers) => new NodeWebSocket(address, { headers }),
  })
  const inventory = await client.list()
  if (signal.aborted) return 0
  const options: RunOptions = {
    client, url, inventory, signal, terminal,
    ...(pasteShortcut === undefined ? {} : { pasteShortcut }),
    ...(typeof values.session === 'string' || typeof values.resume === 'string'
      ? { initialSession: (values.session ?? values.resume) as string } : {}),
  }
  return canRedraw ? runTerminal(options) : runLine(options)
}

/** Full-screen style interactive client with a dock, live blocks and overlays. */
async function runTerminal(options: RunOptions): Promise<number> {
  const { client, url, inventory, signal, pasteShortcut = 'Ctrl+V' } = options
  let palette: Palette = prefersLight() ? lightPalette : darkPalette
  let theme = new Theme(palette, process.env.NO_COLOR === undefined)
  const screen = new TerminalScreen(process.stdin, process.stdout)
  const finished = Promise.withResolvers<number>()
  const ui: { view?: TranscriptView } = {}
  let selected: string | undefined
  let model: ModelSelection | undefined
  let connection = '已连接'
  let connected = true
  let imageLimits: SessionOpening['projections']['values']['imageLimits']
  let approvals: readonly RemoteApproval[] = []
  let watch: AbortController | undefined
  const drafts = new Map<string | undefined, DraftImage[]>()
  const images = (): readonly DraftImage[] => drafts.get(selected) ?? []
  let activeId: string | undefined
  let streamRows: readonly DisplayRow[] = []
  let turnStartedAt = 0
  let lastFlushAt = 0
  let flushTimer: NodeJS.Timeout | undefined
  let suppressUntil = 0
  const plan = createPlanTracker()

  const status = (): EditorStatus => ({
    model: model === undefined ? 'Host 默认模型' : `${model.provider}/${model.model}`,
    session: selected === undefined ? '未选择会话' : `会话 ${selected.slice(0, 8)}`,
    cwd: shortCwd(),
    connection,
    connected,
    expanded: ui.view?.isExpanded ?? false,
    streaming: editor.isStreaming,
    attachments: images().length,
    version: `v${TUI_VERSION}`,
    pasteShortcut,
  })

  const editor = new Editor({
    submit: (text) => { void handle(text) },
    cancel: () => { void cancelTurn() },
    exit: () => { finished.resolve(0) },
    toggleExpanded: () => { ui.view?.toggleExpanded() },
    pasteImage: () => { void pasteImage() },
  })
  const view = new TranscriptView(screen, editor, theme, status)
  ui.view = view
  view.start()
  view.banner(new URL(url).host)

  const commit = (row: DisplayRow, live = false, elapsedMs?: number): void => {
    if (live) { view.setLive([displayBlock(row, true)]); return }
    view.commit(displayBlock(row, false, elapsedMs))
  }

  const renderLive = (): void => {
    lastFlushAt = Date.now()
    view.setLive(streamRows.map(row => displayBlock(row, true, Date.now() - turnStartedAt)))
  }

  const scheduleLive = (): void => {
    if (flushTimer !== undefined) return
    const wait = Math.max(0, 50 - (Date.now() - lastFlushAt))
    flushTimer = setTimeout(() => { flushTimer = undefined; renderLive() }, wait)
  }

  const finishLive = (): void => {
    if (flushTimer !== undefined) { clearTimeout(flushTimer); flushTimer = undefined }
    const rows = streamRows
    const elapsedMs = Date.now() - turnStartedAt
    // The durable journal repeats the same text right after the live stream ends.
    suppressUntil = Date.now() + 4000
    view.clearLive()
    for (const row of rows) commit(row, false, elapsedMs)
    view.setStreaming(false)
    activeId = undefined
    streamRows = []
  }

  const attach = (id: string): void => {
    watch?.abort()
    watch = new AbortController()
    const localSignal = watch.signal
    plan.reset()
    if (selected === undefined) {
      const draft = drafts.get(undefined)
      if (draft !== undefined) { drafts.set(id, draft); drafts.delete(undefined) }
    }
    selected = id
    connection = '连接中'
    connected = false
    imageLimits = undefined
    const summary = inventory.items.find(item => item.sessionId === id)?.projections?.values
    model = summary !== undefined && 'modelSelection' in summary ? projectedModel(summary.modelSelection) : undefined
    approvals = []
    activeId = undefined
    streamRows = []
    suppressUntil = 0
    if (flushTimer !== undefined) { clearTimeout(flushTimer); flushTimer = undefined }
    view.setStreaming(false)
    view.setLive([])
    view.system(`会话 ${safe(id)}`)
    let cursor: number | undefined
    let retries = 0
    const follow = async (): Promise<void> => {
      while (!localSignal.aborted) {
        try {
          await client.follow(id, cursor, {
            opening: (opening) => {
              cursor = opening.cursor
              retries = 0
              connection = '已连接'
              connected = true
              imageLimits = opening.projections.values.imageLimits
              model = projectedModel(opening.projections.values.modelSelection)
              plan.adopt(opening.projections.values)
              for (const event of opening.events) {
                for (const row of displayRows(event)) commit(row)
              }
              const attempt = opening.assistantStream?.activeAttempt
              if (attempt !== undefined) {
                activeId = attempt.attemptId
                streamRows = compactRows(attempt.stream, attempt.attemptId)
                turnStartedAt = Date.now()
                view.setStreaming(true)
                renderLive()
              }
            },
            event: (event) => {
              cursor = event.seq
              if (event.type === 'model/selection') model = readSelection(event.data) ?? model
              plan.apply(event)
              for (const row of displayRows(event)) {
                if (Date.now() < suppressUntil && (row.kind === 'assistant' || row.kind === 'reasoning')) continue
                commit(row)
              }
            },
            assistant: (frame) => {
              if (frame.type === 'start') {
                activeId = frame.attemptId
                streamRows = []
                turnStartedAt = Date.now()
                view.setStreaming(true)
                renderLive()
              } else if (frame.type === 'chunk' && frame.attemptId === activeId) {
                streamRows = appendAssistantRow(streamRows, frame.chunk, frame.attemptId)
                scheduleLive()
              } else if (frame.type === 'end' && frame.attemptId === activeId) {
                finishLive()
              }
            },
            approvals: (items) => {
              const previous = new Set(approvals.map(item => item.id))
              approvals = items
              for (const item of items) {
                if (previous.has(item.id)) continue
                view.commit({
                  id: `approval:${item.id}`, kind: 'approval', title: item.tool,
                  text: `${item.sessionId}  ·  ${item.reason}`, meta: item.id, status: 'running',
                })
              }
            },
          }, localSignal)
        } catch (error) {
          if (localSignal.aborted) return
          connection = '连接断开'
          connected = false
          view.system(safe(error instanceof Error ? error.message : String(error)), 'error')
          if (error instanceof RemoteFailure && (error.code === 'session/not-found' || error.code.startsWith('session/cursor-'))) return
          await delay(Math.min(500 * 2 ** retries, 10_000), undefined, { signal: localSignal })
          retries += 1
        }
      }
    }
    void follow().catch((error: unknown) => {
      if (!localSignal.aborted) view.system(safe(error instanceof Error ? error.message : String(error)), 'error')
    })
  }


  const checkImageBudget = (size: number, staged: readonly DraftImage[]): void => {
    const maxImageBytes = imageLimits?.maxImageBytes ?? clipboardImageLimit
    const maxImages = imageLimits?.maxImagesPerMessage ?? 20
    const maxTotalBytes = imageLimits?.maxMessageImageBytes ?? 200 * 1024 * 1024
    if (size > maxImageBytes || staged.length >= maxImages
      || staged.reduce((bytes, image) => bytes + image.size, size) > maxTotalBytes) {
      throw new Error('图片或待发送附件超过图片限额')
    }
  }

  const pasteImage = async (): Promise<void> => {
    const body = await readClipboardImage(signal)
    if (body === undefined) { view.system('剪贴板里没有图片'); return }
    const staged = images()
    checkImageBudget(body.size, staged)
    const name = `clipboard-${randomUUID().slice(0, 8)}.png`
    drafts.set(selected, [...staged, { kind: 'clipboard', name, size: body.size, body }])
    view.system('已粘贴 [剪贴板图片]，回车随文字发送')
    view.refresh()
  }

  const stageImage = async (argument: string): Promise<void> => {
    if (argument === '') throw new Error('用法 /image 路径')
    const supplied = unquotePath(argument)
    const path = /^~[\\/]/u.test(supplied) ? join(homedir(), supplied.slice(2)) : supplied
    const mediaType = imageTypes.get(extname(path).toLowerCase())
    if (mediaType === undefined) throw new Error('支持 PNG、JPEG、WebP 和 GIF 图片')
    const info = await stat(path)
    if (!info.isFile() || info.size === 0) throw new Error('请选择一个非空图片文件')
    const sessionId = await ensureSessionFor(client, () => selected, attach)
    const staged = drafts.get(sessionId) ?? []
    const body = await openAsBlob(path, { type: mediaType })
    checkImageBudget(body.size, staged)
    const name = basename(path)
    view.system(`正在上传 ${safe(name)}…`)
    const receipt = await client.uploadImage(sessionId, body, mediaType, name, signal)
    drafts.set(sessionId, [...staged, { kind: 'uploaded', name, receipt, size: body.size }])
    view.system(`已添加 [图片：${safe(name)}]，输入文字发送，或用 /send 单独发送`)
  }

  const send = async (text: string): Promise<void> => {
    const sessionId = await ensureSessionFor(client, () => selected, attach)
    const staged = [...(drafts.get(sessionId) ?? [])]
    const receipts: string[] = []
    for (const [index, image] of staged.entries()) {
      if (image.kind === 'uploaded') receipts.push(image.receipt)
      else {
        const receipt = await client.uploadImage(sessionId, image.body, 'image/png', image.name, signal)
        staged[index] = { kind: 'uploaded', receipt, name: image.name, size: image.size }
        receipts.push(receipt)
      }
    }
    await client.prompt(sessionId, text, receipts)
    drafts.delete(sessionId)
    view.refresh()
  }

  const cancelTurn = async (): Promise<void> => {
    if (selected === undefined) return
    try {
      await client.cancel(selected)
      view.system('已中断当前回答')
    } catch (error) {
      view.system(`中断失败：${safe(error instanceof Error ? error.message : String(error))}`, 'error')
    }
  }

  const changeModel = async (selection: ModelSelection): Promise<void> => {
    const result = await client.selectModel(await ensureSessionFor(client, () => selected, attach), selection)
    model = result
    view.system(`已选择 ${result.provider} / ${result.model}`)
    view.refresh()
  }

  const openModel = async (argument: string): Promise<void> => {
    if (argument !== '') {
      const [provider, id, extra] = argument.split(/\s+/u)
      if (provider === undefined || id === undefined || extra !== undefined) throw new Error('用法 /model 提供方 模型')
      await changeModel({ provider, model: id })
      return
    }
    const catalog: ModelCatalog = await client.modelCatalog()
    if (catalog.groups.every(group => group.models.length === 0)) {
      view.system('Host 未提供可切换的模型，先用 /login 配置 API Key', 'error')
      return
    }
    const selector = new ModelSelector(catalog, model, catalog.default)
    selector.setCurrent(model ?? catalog.default)
    const choice = await view.showOverlay(selector, selector.result)
    if (choice !== undefined && !signal.aborted) await changeModel(choice)
  }

  const openLogin = async (): Promise<void> => {
    const prompt = new SecretPrompt()
    const key = await view.showOverlay(prompt, prompt.result)
    if (key === undefined) { view.system('已取消 API Key 配置'); return }
    await client.setProviderKey(key, signal)
    view.system('DeepSeek API Key 已保存到 Host')
  }

  const showSessions = async (): Promise<void> => {
    const { items } = await client.list()
    if (items.length === 0) { view.system('还没有会话'); return }
    view.commitRaw([
      `  ${theme.bold('textStrong', '会话')}`,
      ...items.map((session) => {
        const state = session.running ? '运行中' : session.blank ? '空会话' : '历史'
        const values = session.projections?.values
        const title = values !== undefined && 'title' in values ? values.title : undefined
        const marker = session.sessionId === selected ? theme.fg('success', '●') : theme.fg('textMuted', '○')
        return `  ${marker} ${theme.fg('textDim', state)}  ${theme.fg('text', session.sessionId.slice(0, 12))}  ${theme.fg('textDim', safe(typeof title === 'string' ? title : session.cwd ?? ''))}`
      }),
      '',
    ])
  }

  const showStatus = async (): Promise<void> => {
    const key = await client.providerKeyStatus()
    view.commitRaw([
      `  ${theme.bold('textStrong', '状态')}`,
      `    Host      ${theme.fg('textDim', new URL(url).origin)} · ${theme.fg(connected ? 'success' : 'warning', connection)}`,
      `    会话      ${theme.fg('textDim', selected ?? '尚未选择')}`,
      `    模型      ${theme.fg('textDim', model === undefined ? 'Host 默认模型' : `${model.provider} / ${model.model}`)}`,
      `    API Key   ${theme.fg(key.configured ? 'success' : 'warning', key.configured ? '已配置' : '未配置 · /login')}`,
      '',
    ])
  }

  const panelDeps: PanelDeps = {
    client,
    signal,
    sessionId: () => ensureSessionFor(client, () => selected, attach),
    snapshot: () => plan.snapshot(),
  }

  const applyPanelResult = (result: PanelResult): void => {
    switch (result.kind) {
      case 'insert':
        editor.setText(result.text)
        view.system('已填入输入框，回车发送')
        break
      case 'submit': void handle(result.text); break
      case 'session': attach(result.id); break
    }
  }

  const showPanel = async (
    panel: Overlay & { readonly result: Promise<PanelResult | undefined> },
  ): Promise<void> => {
    const result = await view.showOverlay(panel, panel.result)
    if (result !== undefined && !signal.aborted) applyPanelResult(result)
  }

  const handle = async (line: string): Promise<void> => {
    const [, command = '', argument = ''] = /^(\S+)(?:\s+([\s\S]+))?$/u.exec(line.trim()) ?? []
    const rest = argument.split(/\s+/u)
    try {
      switch (command) {
        case '':
          if (images().length !== 0) await send('')
          break
        case '/quit':
        case '/exit': finished.resolve(0); break
        case '/':
        case '/help': view.help(); break
        case '/compact': view.compact(); view.system('已收起较早的输出'); break
        case '/skills': await showPanel(skillsPanel(panelDeps)); break
        case '/mcp': await showPanel(mcpPanel(panelDeps)); break
        case '/plan': await showPanel(planPanel(panelDeps)); break
        case '/search': await showPanel(searchPanel(panelDeps, argument)); break
        case '/files':
          await showPanel(filePanel(panelDeps, argument === '' ? '' : unquotePath(argument)))
          break
        case '/settings': await showPanel(settingsPanel(panelDeps)); break
        case '/sessions': await showSessions(); break
        case '/attach':
          if (argument === '') throw new Error('输入 /attach ID')
          attach(argument)
          break
        case '/new': attach((await client.create(argument === '' ? undefined : unquotePath(argument))).sessionId); break
        case '/image': await stageImage(argument); break
        case '/paste': await pasteImage(); break
        case '/images':
          if (argument === 'clear') { drafts.delete(selected); view.system('已清空待发送图片') }
          else if (argument !== '') throw new Error('用法 /images [clear]')
          else view.system(images().map(image => `[图片：${safe(image.name)}]`).join('\n') || '没有待发送图片')
          break
        case '/send':
          if (argument !== '' || images().length === 0) throw new Error('先用 /image 添加图片，再输入 /send')
          await send('')
          break
        case '/login': await openLogin(); break
        case '/status': await showStatus(); break
        case '/model': await openModel(argument); break
        case '/theme': {
          const mode = rest[0] ?? (palette === darkPalette ? 'light' : 'dark')
          palette = mode === 'light' ? lightPalette : darkPalette
          theme = new Theme(palette, process.env.NO_COLOR === undefined)
          view.setPalette(palette, process.env.NO_COLOR === undefined)
          view.system(`已切换到 ${mode === 'light' ? '浅色' : '深色'}配色`)
          break
        }
        case '/thinking': view.toggleExpanded(); break
        case '/diff': {
          const [seq, index] = rest
          if (selected === undefined || seq === undefined || !/^\d+$/u.test(seq)
            || (index !== undefined && !/^\d+$/u.test(index))) throw new Error('输入 /diff SEQ [文件序号]')
          const result = await client.changes(selected, Number(seq), index === undefined ? undefined : Number(index))
          if (index === undefined) {
            for (const file of changedFiles(result)) view.system(`${String(file.index)}  ${file.label}`)
          } else {
            view.commitRaw(renderDiff(unifiedDiff(result), screen.columns - 1, view.currentTheme))
          }
          break
        }
        case '/approve':
        case '/deny':
          if (!approvals.some(item => item.id === argument)) throw new Error('审批已结束或 ID 不存在')
          await client.answer(argument, command === '/approve' ? 'allowed-once' : 'rejected')
          break
        default:
          if (command.startsWith('/')) throw new Error('未知命令。输入 /help 查看命令')
          await send(line)
      }
    } catch (error) {
      view.system(safe(error instanceof Error ? error.message : String(error)), 'error')
    }
    view.refresh()
  }

  const initial = options.initialSession ?? inventory.items.find(item => item.origin !== 'subagent')?.sessionId
  if (initial !== undefined) attach(initial)
  else view.system('直接输入开始对话，或用 /new 指定服务器工作目录')

  const onAbort = (): void => { finished.resolve(0) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await finished.promise
  } finally {
    signal.removeEventListener('abort', onAbort)
    watch?.abort()
    view.stop()
  }
}

/** Line-oriented fallback for dumb terminals, pipes and scripted input. */
async function runLine(options: RunOptions): Promise<number> {
  const { client, url, inventory, signal, pasteShortcut, terminal } = options
  const columns = Number.isFinite(process.stdout.columns) ? process.stdout.columns : 80
  const paint: TerminalStyle = (text, ...codes) => terminal && process.env.NO_COLOR === undefined && text !== ''
    ? `\u001b[${codes.join(';')}m${text}\u001b[0m` : text
  if (terminal) process.stdout.write(welcome(process.stdout.columns, new URL(url).host, paint, pasteShortcut))
  let input: Interface | undefined
  let selected: string | undefined
  let model: ModelSelection | undefined
  let connection = '已连接'
  let pickerOutput: ((text: string) => void) | undefined
  let watch: AbortController | undefined
  let activeId: string | undefined
  let streamRows: readonly DisplayRow[] = []
  const plan = createPlanTracker()
  const drafts = new Map<string | undefined, DraftImage[]>()
  const images = (): readonly DraftImage[] => drafts.get(selected) ?? []
  const prompt = (): string => images().length === 0 ? '› ' : `[${String(images().length)} 图] › `
  const openInput = (): Interface => createInterface({
    input: process.stdin, output: process.stdout, terminal, prompt: prompt(), completer: completeCommand,
  })
  const print = (text: string): void => {
    if (pickerOutput !== undefined) { pickerOutput(text); return }
    process.stdout.write(`${text}\n`)
    input?.prompt(true)
  }
  const commit = (row: DisplayRow): void => {
    const title = paint(safe(row.title), row.kind === 'error' ? 31 : 36)
    const body = row.kind === 'diff' ? renderDiff(row.text, columns, new Theme(darkPalette, false)).join('\n')
      : row.kind === 'changes' ? `${safe(row.text)} · /diff ${String(row.changesSeq)}` : safe(row.text)
    print(`${title}\n${body}`)
  }
  const attach = (id: string): void => {
    watch?.abort()
    watch = new AbortController()
    const localSignal = watch.signal
    plan.reset()
    selected = id
    connection = '连接中'
    const summary = inventory.items.find(item => item.sessionId === id)?.projections?.values
    model = summary !== undefined && 'modelSelection' in summary ? projectedModel(summary.modelSelection) : undefined
    print(`会话 ${safe(id)}`)
    let cursor: number | undefined
    let retries = 0
    const follow = async (): Promise<void> => {
      while (!localSignal.aborted) {
        try {
          await client.follow(id, cursor, {
            opening: (opening) => {
              cursor = opening.cursor
              connection = '已连接'
              model = projectedModel(opening.projections.values.modelSelection)
              plan.adopt(opening.projections.values)
              for (const event of opening.events) displayRows(event).forEach(commit)
              const attempt = opening.assistantStream?.activeAttempt
              if (attempt !== undefined) {
                activeId = attempt.attemptId
                streamRows = compactRows(attempt.stream, attempt.attemptId)
              }
            },
            event: (event) => {
              cursor = event.seq
              if (event.type === 'model/selection') model = readSelection(event.data) ?? model
              plan.apply(event)
              displayRows(event).forEach(commit)
            },
            assistant: (frame) => {
              if (frame.type === 'start') { activeId = frame.attemptId; streamRows = [] }
              else if (frame.type === 'chunk' && frame.attemptId === activeId) {
                streamRows = appendAssistantRow(streamRows, frame.chunk, frame.attemptId)
              } else if (frame.type === 'end' && frame.attemptId === activeId) {
                streamRows.forEach(commit)
                streamRows = []
                activeId = undefined
              }
            },
            approvals: (items) => {
              for (const item of items) print(safe(`待审批 ${item.id}\n${item.sessionId} · ${item.tool}\n${item.reason}`))
            },
          }, localSignal)
        } catch (error) {
          if (localSignal.aborted) return
          connection = '连接断开'
          print(safe(error instanceof Error ? error.message : String(error)))
          if (error instanceof RemoteFailure && (error.code === 'session/not-found' || error.code.startsWith('session/cursor-'))) return
          await delay(Math.min(500 * 2 ** retries, 10_000), undefined, { signal: localSignal })
          retries += 1
        }
      }
    }
    void follow().catch((error: unknown) => {
      if (!localSignal.aborted) print(safe(error instanceof Error ? error.message : String(error)))
    })
  }
  const changeModel = async (selection: ModelSelection): Promise<void> => {
    const result = await client.selectModel(await ensureSessionFor(client, () => selected, attach), selection)
    model = result
    print(safe(`已选择 ${result.provider} / ${result.model}`))
  }
  const handle = async (line: string): Promise<'continue' | 'login' | 'model' | 'exit'> => {
    const [, command = '', argument = ''] = /^(\S+)(?:\s+([\s\S]+))?$/u.exec(line.trim()) ?? []
    const rest = argument.split(/\s+/u)
    try {
      switch (command) {
        case '': if (images().length !== 0) await client.prompt(await ensureSessionFor(client, () => selected, attach), ''); break
        case '/quit': case '/exit': return 'exit'
        case '/': case '/help': print(commandHelp(process.stdout.columns, pasteShortcut)); break
        case '/sessions': print((await client.list()).items.map(item => safe(item.sessionId)).join('\n') || '还没有会话'); break
        case '/skills': {
          const { skills } = await client.skills(await ensureSessionFor(client, () => selected, attach))
          print(safe(skills.map(skill => `/${skill.name}  ${skill.description}`).join('\n') || '没有可用技能'))
          break
        }
        case '/mcp': {
          const servers = await client.mcpServers(signal)
          print(safe(servers.map(server =>
            `${server.name}  ${typeof server.status.state === 'string' ? server.status.state : 'unknown'}`
            + (server.configured ? '' : '  (配置已移除)'))
            .join('\n') || '没有 MCP 服务'))
          break
        }
        case '/plan': {
          const id = await ensureSessionFor(client, () => selected, attach)
          const document = await client.planDocument(id).catch(() => undefined)
          print(safe(planText(plan.snapshot(), document)))
          break
        }
        case '/search': {
          const hits = argument.trim() === ''
            ? (await client.list()).items.map(item =>
              `${item.sessionId}  ${typeof item.cwd === 'string' ? item.cwd : '已有会话'}`)
            : (await client.searchSessions(argument)).items.map(item => `${item.sessionId}  ${item.snippet}`)
          print(safe(hits.join('\n') || '没有匹配的会话'))
          break
        }
        case '/files': {
          const listing = await client.workspaceFiles(argument === '' ? '' : unquotePath(argument), 'list') as DirectoryListing
          print(safe(listing.entries.map(entry => `${entry.kind === 'directory' ? '目录' : '文件'}  ${entry.name}`)
            .join('\n') || '目录为空'))
          break
        }
        case '/settings': {
          const described = await client.settingsDescribe()
          print(safe(described.namespaces.map(namespace =>
            `${namespace.ns}  revision ${String(namespace.revision)}`).join('\n') || '没有配置命名空间'))
          break
        }
        case '/compact':
        case '/thinking':
        case '/theme':
        case '/paste':
        case '/image':
        case '/images':
        case '/send':
          print('该命令需要支持重绘的交互式终端（TERM 不能为 dumb）')
          break
        case '/approve':
        case '/deny':
          if (argument === '') throw new Error('输入审批 ID')
          await client.answer(argument, command === '/approve' ? 'allowed-once' : 'rejected')
          break
        case '/attach': if (argument === '') throw new Error('输入 /attach ID'); attach(argument); break
        case '/new': attach((await client.create(argument === '' ? undefined : unquotePath(argument))).sessionId); break
        case '/status': {
          const key = await client.providerKeyStatus()
          print(safe([
            `Host     ${new URL(url).origin} · ${connection}`,
            `会话     ${selected ?? '尚未选择'}`,
            `模型     ${model === undefined ? 'Host 默认模型' : `${model.provider} / ${model.model}`}`,
            `API Key  ${key.configured ? '已配置' : '未配置 · /login'}`,
          ].join('\n')))
          break
        }
        case '/model':
          if (argument === '') {
            if (terminal) return 'model'
            const catalog = await client.modelCatalog()
            print(safe([`Host 默认  ${catalog.default.provider} / ${catalog.default.model}`,
              ...catalog.groups.flatMap(group => group.models.map(item => `  ${group.id}  ${item.id}  ${item.name}`))].join('\n')))
          } else {
            const [provider, id, extra] = rest
            if (provider === undefined || id === undefined || extra !== undefined) throw new Error('用法 /model 提供方 模型')
            await changeModel({ provider, model: id })
          }
          break
        case '/login':
          if (!terminal) throw new Error('请在交互式终端中运行 /login')
          return 'login'
        case '/diff': {
          const [seq, index] = rest
          if (selected === undefined || seq === undefined || !/^\d+$/u.test(seq)) throw new Error('输入 /diff SEQ [文件序号]')
          const result = await client.changes(selected, Number(seq), index === undefined ? undefined : Number(index))
          if (index === undefined) for (const file of changedFiles(result)) print(safe(`${String(file.index)}  ${file.label}`))
          else print(renderDiff(unifiedDiff(result), columns, new Theme(darkPalette, false)).join('\n'))
          break
        }
        default:
          if (command.startsWith('/')) throw new Error('未知命令。输入 /help 查看命令')
          await client.prompt(await ensureSessionFor(client, () => selected, attach), line)
      }
    } catch (error) {
      print(safe(error instanceof Error ? error.message : String(error)))
    }
    return 'continue'
  }
  const close = (): void => { watch?.abort(); input?.close() }
  signal.addEventListener('abort', close, { once: true })
  try {
    const initial = options.initialSession ?? inventory.items.find(item => item.origin !== 'subagent')?.sessionId
    if (initial !== undefined) attach(initial)
    else if (!terminal) print('直接输入开始对话，或用 /new 指定服务器工作目录')
    while (!signal.aborted) {
      input = openInput()
      if (terminal) input.prompt()
      let modal: 'login' | 'model' | undefined
      for await (const line of input) {
        if (signal.aborted) return 0
        const action = await handle(line)
        if (action === 'exit') return 0
        if (action === 'login' || action === 'model') { modal = action; break }
        input.setPrompt(prompt())
        input.prompt(true)
      }
      input.close()
      input = undefined
      if (modal === undefined) break
      try {
        if (modal === 'model') {
          const catalog = await client.modelCatalog()
          const picker = openModelPicker(catalog, model, signal, paint)
          pickerOutput = (text) => { picker.print(text) }
          const choice = await picker.result
          pickerOutput = undefined
          if (choice !== undefined && !signal.aborted) await changeModel(choice)
        } else {
          const key = await readProviderKey(signal)
          if (key === undefined) print('已取消 API Key 配置')
          else { await client.setProviderKey(key, signal); print('DeepSeek API Key 已保存到 Host') }
        }
      } catch (error) {
        print(safe(error instanceof Error ? error.message : String(error)))
      }
    }
    return 0
  } finally {
    signal.removeEventListener('abort', close)
    close()
  }
}
