/** SSH-friendly interactive client for an existing DSH daemon. */

import { randomUUID } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { clearLine, createInterface, cursorTo, type Interface, type Key } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { stripVTControlCharacters, parseArgs } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { isRecord, RemoteClient, RemoteFailure, type PromptImageType, type RemoteApproval } from './remote-client.ts'
import type { ModelSelection, SessionOpening } from './remote-contract.ts'
import { changedFiles, compactRows, displayRows, unifiedDiff, type DisplayRow } from './remote-presentation.ts'
import { clipboardImageLimit, readClipboardImage } from './tui-clipboard.ts'
import { commandHelp, completeCommand, readProviderKey, welcome, type TerminalStyle } from './tui-input.ts'
import { openModelPicker } from './tui-model.ts'
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

// Node 24 accepts Undici WebSocketInit in addition to the DOM protocols argument.
const NodeWebSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: { headers: Readonly<Record<string, string>> }): WebSocket
}

/** Start the terminal app after the selected profile finishes mounting.
 * @param ctx - terminal profile Cordis context.
 */
export function apply(ctx: Context): void {
  const args = ctx.get('cmdlineArgs')
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (args === undefined || ready === undefined || exit === undefined) throw new Error('dsh tui requires the profile launcher')
  const lifetime = new AbortController()
  ctx.effect(() => {
    const cancel = ready.onReady(() => {
      void run(args.get(), lifetime.signal).then(exit, (error: unknown) => {
        process.stderr.write(`dsh tui: ${safe(error instanceof Error ? error.message : String(error))}\n`)
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

async function run(args: readonly string[], signal: AbortSignal): Promise<number> {
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
  if (values.help === true) {
    process.stdout.write(`dsh tui [--url URL] [--session ID]\ndsh tui --version\n\n${commandHelp(process.stdout.columns)}\n`)
    return 0
  }
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true
  const canRedraw = terminal && process.env.TERM !== 'dumb'
  const pasteShortcut = canRedraw ? (process.platform === 'win32' ? 'Alt+V' : 'Ctrl+V') : undefined
  const paint: TerminalStyle = (text, ...codes) => canRedraw && process.env.NO_COLOR === undefined && text !== ''
    ? `\u001b[${codes.join(';')}m${text}\u001b[0m`
    : text
  const tokenFile = process.env.DSH_DAEMON_TOKEN_FILE
  const token = process.env.DSH_DAEMON_TOKEN ?? (tokenFile === undefined ? '' : (await readFile(tokenFile, 'utf8')).trimEnd())
  const url = values.url ?? process.env.DSH_DAEMON_URL ?? 'http://127.0.0.1:3080'
  if (terminal) process.stdout.write(welcome(process.stdout.columns, new URL(url).host, paint, pasteShortcut))
  const client = new RemoteClient(url, token, {
    id: randomUUID,
    socket: (url, headers) => new NodeWebSocket(url, { headers }),
  })
  const inventory = await client.list()
  if (signal.aborted) return 0
  let input: Interface | undefined
  let selected: string | undefined
  let model: ModelSelection | undefined
  let connection = '已连接'
  let pickerOutput: ((text: string) => void) | undefined
  let paste: Promise<void> | undefined
  let handling = false
  const drafts = new Map<string | undefined, DraftImage[]>()
  const images = (): readonly DraftImage[] => drafts.get(selected) ?? []
  const prompt = (): string => {
    const count = images().length
    const marker = canRedraw ? paint('›', 94) : 'dsh >'
    return count === 0 ? `${marker} ` : `${paint(`[${count} 图]`, 2)} ${marker} `
  }
  const openInput = (): Interface => createInterface({
    input: process.stdin, output: process.stdout, terminal, prompt: prompt(), completer: completeCommand,
  })
  const redrawPrompt = (): void => {
    if (!terminal || input === undefined) return
    if (canRedraw) {
      clearLine(process.stdout, 0)
      cursorTo(process.stdout, 0)
    }
    input.setPrompt(prompt())
    input.prompt(canRedraw)
  }
  const print = (text: string): void => {
    if (pickerOutput !== undefined) {
      pickerOutput(text)
      return
    }
    if (canRedraw && input !== undefined) {
      clearLine(process.stdout, 0)
      cursorTo(process.stdout, 0)
    }
    process.stdout.write(`${text}\n`)
    if (canRedraw) redrawPrompt()
  }
  const paintDiff = (text: string): string => safe(text).split('\n').map((line) => {
    if (line.startsWith('+')) return paint(line, 32)
    if (line.startsWith('-')) return paint(line, 31)
    return line.startsWith('@@') ? paint(line, 36) : line
  }).join('\n')
  const markdown = (text: string): string => safe(text)
    .replace(/^#{1,6}[ \t]+(.+)$/gmu, (_match, heading: string) => paint(heading, 36))
    .replace(/\*\*([^*\n]+)\*\*/gu, (_match, bold: string) => paint(bold, 1))
    .replace(/`([^`\n]+)`/gu, (_match, code: string) => paint(code, 33))
  let imageLimits: SessionOpening['projections']['values']['imageLimits']
  let watch: AbortController | undefined
  let approvals: readonly RemoteApproval[] = []
  let thinking = false
  const thoughts: DisplayRow[] = []
  const render = (row: DisplayRow): void => {
    if (row.kind === 'reasoning') {
      thoughts.push(row)
      if (thoughts.length > 100) thoughts.shift()
      if (!thinking) return
    }
    const text = row.kind === 'diff' ? paintDiff(row.text)
      : row.kind === 'changes' ? `${safe(row.text)} · /diff ${String(row.changesSeq)}`
        : row.kind === 'assistant' || row.kind === 'user' ? markdown(row.text)
          : safe(row.text)
    print(`${paint(safe(row.title), row.kind === 'error' ? 31 : 36)}\n${text}`)
  }
  const attach = (id: string): void => {
    watch?.abort()
    watch = new AbortController()
    const local = watch.signal
    if (selected === undefined) {
      const draft = drafts.get(undefined)
      if (draft !== undefined) {
        drafts.set(id, draft)
        drafts.delete(undefined)
      }
    }
    selected = id
    connection = '连接中'
    imageLimits = undefined
    const summary = inventory.items.find(item => item.sessionId === id)?.projections?.values
    model = summary !== undefined && 'modelSelection' in summary ? projectedModel(summary.modelSelection) : undefined
    approvals = []
    thoughts.length = 0
    print(`会话 ${safe(id)}`)
    let cursor: number | undefined
    let retries = 0
    let activeId: string | undefined
    const follow = async (): Promise<void> => {
      while (!local.aborted) {
        try {
          await client.follow(id, cursor, {
            opening: (opening) => {
              cursor = opening.cursor
              retries = 0
              connection = '已连接'
              imageLimits = opening.projections.values.imageLimits
              model = projectedModel(opening.projections.values.modelSelection)
              for (const event of opening.events) displayRows(event).forEach(render)
              const attempt = opening.assistantStream?.activeAttempt
              activeId = attempt?.attemptId
              if (attempt !== undefined) compactRows(attempt.stream, attempt.attemptId).forEach(render)
            },
            event: (event) => {
              cursor = event.seq
              if (event.type === 'model/selection') model = readSelection(event.data) ?? model
              displayRows(event).forEach(render)
            },
            assistant: (frame) => {
              if (frame.type === 'start') activeId = frame.attemptId
              if (frame.type === 'end') activeId = undefined
              if (frame.type === 'chunk' && frame.attemptId === activeId) compactRows([frame.chunk], frame.attemptId).forEach(render)
            },
            approvals: (items) => {
              const previous = new Set(approvals.map(item => item.id))
              approvals = items
              for (const item of items) {
                if (!previous.has(item.id)) print(safe(`待审批 ${item.id}\n${item.sessionId} · ${item.tool}\n${item.reason}`))
              }
            },
          }, local)
        } catch (error) {
          if (local.aborted) return
          connection = '连接断开'
          print(safe(error instanceof Error ? error.message : String(error)))
          if (error instanceof RemoteFailure && (error.code === 'session/not-found' || error.code.startsWith('session/cursor-'))) return
          await delay(Math.min(500 * 2 ** retries, 10_000), undefined, { signal: local })
          retries += 1
        }
      }
    }
    void follow().catch((error: unknown) => {
      if (!local.aborted) print(safe(error instanceof Error ? error.message : String(error)))
    })
  }
  const showSessions = async (): Promise<void> => {
    const { items } = await client.list()
    print(items.length === 0 ? '还没有会话' : items.map((session) => {
      const status = session.running ? '运行中' : session.blank ? '空会话' : '历史'
      const values = session.projections?.values
      const title = values !== undefined && 'title' in values ? values.title : undefined
      return safe(`${session.sessionId === selected ? '*' : ' '} ${status}  ${session.sessionId}  ${typeof title === 'string' ? title : session.cwd ?? ''}`)
    }).join('\n'))
  }
  const ensureSession = async (): Promise<string> => {
    if (selected !== undefined) return selected
    const { sessionId } = await client.create()
    attach(sessionId)
    return sessionId
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
    if (body === undefined) {
      print('剪贴板里没有图片')
      return
    }
    const staged = images()
    checkImageBudget(body.size, staged)
    const name = `clipboard-${randomUUID().slice(0, 8)}.png`
    drafts.set(selected, [...staged, { kind: 'clipboard', name, size: body.size, body }])
    print('已粘贴 [剪贴板图片]，回车随文字发送')
  }
  const onPaste = (_value: string | undefined, key: Key): void => {
    if (key.name !== 'v' || (!key.ctrl && !key.meta) || paste !== undefined) return
    if (handling) {
      print('当前操作完成后再粘贴图片')
      return
    }
    paste = pasteImage().catch((error: unknown) => {
      if (!signal.aborted) print(safe(error instanceof Error ? error.message : String(error)))
    }).finally(() => { paste = undefined })
  }
  const stageImage = async (argument: string): Promise<void> => {
    if (argument === '') throw new Error('用法 /image 路径')
    const supplied = unquotePath(argument)
    const path = /^~[\\/]/u.test(supplied) ? join(homedir(), supplied.slice(2)) : supplied
    const mediaType = imageTypes.get(extname(path).toLowerCase())
    if (mediaType === undefined) throw new Error('支持 PNG、JPEG、WebP 和 GIF 图片')
    const info = await stat(path)
    if (!info.isFile() || info.size === 0) throw new Error('请选择一个非空图片文件')
    const sessionId = await ensureSession()
    const staged = drafts.get(sessionId) ?? []
    const body = await openAsBlob(path, { type: mediaType })
    checkImageBudget(body.size, staged)
    const name = basename(path)
    print(safe(`正在上传 ${name}…`))
    const receipt = await client.uploadImage(sessionId, body, mediaType, name, signal)
    drafts.set(sessionId, [...staged, { kind: 'uploaded', name, receipt, size: body.size }])
    print(safe(`已添加 [图片：${name}]，输入文字发送，或用 /send 单独发送`))
  }
  const send = async (text: string): Promise<void> => {
    const sessionId = await ensureSession()
    const staged = drafts.get(sessionId) ?? []
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
  }
  const changeModel = async (selection: ModelSelection): Promise<void> => {
    const result = await client.selectModel(await ensureSession(), selection)
    model = result
    print(safe(`已选择 ${result.provider} / ${result.model}`))
  }
  const close = (): void => {
    process.stdin.removeListener('keypress', onPaste)
    watch?.abort()
    input?.close()
  }
  signal.addEventListener('abort', close, { once: true })
  try {
    const initial = values.session ?? values.resume ?? inventory.items.find(item => item.origin !== 'subagent')?.sessionId
    if (initial !== undefined) attach(initial)
    else if (!terminal) print('直接输入开始对话，或用 /new 指定服务器工作目录')
    const handle = async (line: string): Promise<'continue' | 'login' | 'model' | 'exit'> => {
      const [, command = '', argument = ''] = /^(\S+)(?:\s+([\s\S]+))?$/u.exec(line.trim()) ?? []
      const rest = argument.split(/\s+/u)
      try {
        switch (command) {
          case '':
            if (images().length !== 0) await send('')
            break
          case '/quit':
          case '/exit': return 'exit'
          case '/':
          case '/help': print(commandHelp(process.stdout.columns, pasteShortcut)); break
          case '/sessions': await showSessions(); break
          case '/attach':
            if (argument === '') throw new Error('输入 /attach ID')
            attach(argument)
            break
          case '/new': attach((await client.create(argument === '' ? undefined : unquotePath(argument))).sessionId); break
          case '/image': await stageImage(argument); break
          case '/paste': await pasteImage(); break
          case '/images':
            if (argument === 'clear') {
              drafts.delete(selected)
              print('已清空待发送图片')
            } else if (argument !== '') throw new Error('用法 /images [clear]')
            else print(images().map(image => safe(`[图片：${image.name}]`)).join('\n') || '没有待发送图片')
            break
          case '/send':
            if (argument !== '' || images().length === 0) throw new Error('先用 /image 添加图片，再输入 /send')
            await send('')
            break
          case '/login':
            if (argument !== '') throw new Error('输入 /login 后在隐藏提示中填写 API Key')
            if (!terminal) throw new Error('请在交互式终端中运行 /login')
            return 'login'
          case '/status': {
            const status = await client.providerKeyStatus()
            print(safe([
              `Host     ${new URL(url).origin} · ${connection}`,
              `会话     ${selected ?? '尚未选择'}`,
              `模型     ${model === undefined ? 'Host 默认模型' : `${model.provider} / ${model.model}`}`,
              `API Key  ${status.configured ? '已配置' : '未配置 · /login'}`,
            ].join('\n')))
            break
          }
          case '/model': {
            if (argument === '') {
              if (canRedraw) return 'model'
              const catalog = await client.modelCatalog()
              const options = catalog.groups.flatMap(group => group.models.map(item => `  ${group.id}  ${item.id}  ${item.name}`))
              print(safe([`Host 默认  ${catalog.default.provider} / ${catalog.default.model}`, ...options, '用法 /model 提供方 模型'].join('\n')))
            } else {
              const [provider, id, extra] = rest
              if (provider === undefined || id === undefined || extra !== undefined) throw new Error('用法 /model 提供方 模型')
              await changeModel({ provider, model: id })
            }
            break
          }
          case '/thinking':
            thinking = !thinking
            if (thinking) for (const row of thoughts) print(`${row.title}\n${safe(row.text)}`)
            else print('思考过程已收起')
            break
          case '/diff': {
            const [seq, index] = rest
            if (selected === undefined || seq === undefined || !/^\d+$/u.test(seq)
              || (index !== undefined && !/^\d+$/u.test(index))) throw new Error('输入 /diff SEQ [文件序号]')
            const result = await client.changes(selected, Number(seq), index === undefined ? undefined : Number(index))
            if (index === undefined) {
              for (const file of changedFiles(result)) print(safe(`${file.index}  ${file.label}`))
            } else print(paintDiff(unifiedDiff(result)))
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
        print(safe(error instanceof Error ? error.message : String(error)))
      }
      return 'continue'
    }
    while (!signal.aborted) {
      input = openInput()
      if (canRedraw) process.stdin.on('keypress', onPaste)
      if (terminal) input.prompt()
      let modal: 'login' | 'model' | undefined
      for await (const line of input) {
        await paste
        if (signal.aborted) return 0
        handling = true
        const action = await handle(line).finally(() => { handling = false })
        if (action === 'exit') return 0
        if (action === 'login' || action === 'model') {
          modal = action
          break
        }
        redrawPrompt()
      }
      process.stdin.removeListener('keypress', onPaste)
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
          else {
            await client.setProviderKey(key, signal)
            print('DeepSeek API Key 已保存到 Host')
          }
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
