/** Transcript blocks: messages, collapsible thinking, tool cards and chrome. */

import {
  renderDiff, renderMarkdown, symbols, truncateTo, visibleWidth, wrapLine,
  type Theme,
} from './tui-theme.ts'
import { commandDescriptors } from './tui-input.ts'
import { TUI_VERSION } from './tui-version.ts'

/** Transcript block categories. */
export type BlockKind =
  | 'user' | 'assistant' | 'reasoning' | 'tool' | 'tool-result'
  | 'diff' | 'changes' | 'system' | 'error' | 'approval'

/** One renderable transcript unit. */
export interface Block {
  readonly id: string
  readonly kind: BlockKind
  readonly title: string
  readonly text: string
  readonly meta?: string
  readonly status?: 'running' | 'done' | 'error'
  readonly startedAt?: number
  readonly elapsedMs?: number
  readonly changesSeq?: number
}

/** Shared rendering options for a whole frame. */
export interface BlockOptions {
  readonly expanded: boolean
  readonly streaming: boolean
  readonly now: number
}

const thinkingPreviewLines = 2
const resultPreviewLines = 3
const diffPreviewLines = 6

function spinner(theme: Theme, now: number): string {
  const frame = symbols.spinner[Math.floor(now / 80) % symbols.spinner.length] ?? symbols.spinner[0]
  return theme.fg('accent', frame)
}

function elapsed(block: Block, now: number): string {
  const started = block.elapsedMs ?? (block.startedAt === undefined ? undefined : now - block.startedAt)
  if (started === undefined || started < 2000) return ''
  return ` · ${String(Math.round(started / 1000))}s`
}

/** @returns a compact, dimmed prefix used for quoted content. */
function quote(text: string, width: number, theme: Theme, token: 'textDim' | 'error' = 'textDim'): string[] {
  return text.split('\n').flatMap(line => wrapLine(line, Math.max(8, width - 6))
    .map(wrapped => `    ${theme.fg('border', symbols.bar)} ${theme.italic(token, wrapped)}`))
}

/** @returns the final or live rendering of one transcript block. */
export function renderBlock(block: Block, width: number, theme: Theme, options: BlockOptions): string[] {
  const { expanded, streaming, now } = options
  switch (block.kind) {
    case 'user': {
      const body = wrapLine(block.text, Math.max(8, width - 4))
      return [
        '',
        ...body.map((line, index) => `${index === 0 ? theme.bold('roleUser', symbols.userBullet) + ' ' : '  '}${line}`),
      ]
    }
    case 'assistant': {
      if (block.text.trim() === '') return []
      const heading = block.status === 'running'
        ? `${spinner(theme, now)} ${theme.bold('roleAssistant', 'DeepSeek')}${theme.fg('textDim', ` 正在回答${elapsed(block, now)}`)}`
        : `${theme.fg('roleAssistant', symbols.bullet)} ${theme.bold('roleAssistant', 'DeepSeek')}`
        + (block.elapsedMs === undefined ? '' : theme.fg('textMuted', elapsed(block, now)))
      return ['', `  ${heading}`, ...renderMarkdown(block.text, width - 2, theme, streaming && block.status === 'running')]
    }
    case 'reasoning': {
      const content = block.text.replace(/\n+$/u, '')
      if (content.trim() === '') return []
      const lines = content.split('\n')
      const quoted = quote(lines.join('\n'), width, theme)
      const running = block.status === 'running'
      const hidden = quoted.length > thinkingPreviewLines
      const hint = expanded ? 'Ctrl+O 收起' : 'Ctrl+O 展开'
      const head = `  ${running ? spinner(theme, now) : theme.fg('thinking', symbols.bullet)} `
        + theme.italic('thinking', running ? 'Thinking' : 'Thought')
        + theme.fg('textMuted', `${elapsed(block, now)}${hidden ? `  ·  ${hint}` : ''}`)
      const visible = expanded || !hidden ? quoted
        : running ? quoted.slice(-thinkingPreviewLines) : quoted.slice(0, thinkingPreviewLines)
      const rest = quoted.length - visible.length
      const more = rest > 0 ? [`    ${theme.fg('textMuted', `${symbols.ellipsis} 还有 ${String(rest)} 行 · Ctrl+O 展开`)}`] : []
      return ['', head, ...visible, ...more]
    }
    case 'tool':
    case 'tool-result': {
      const running = block.status === 'running'
      const marker = block.status === 'error' ? theme.fg('error', symbols.failure)
        : running ? spinner(theme, now) : theme.fg('success', symbols.success)
      const verb = running ? 'Using' : block.status === 'error' ? 'Failed' : 'Used'
      const label = theme.bold('primary', block.title)
      const detail = block.meta === undefined || block.meta === '' ? '' : theme.fg('textDim', `  ${truncateTo(block.meta, Math.max(8, width - 24))}`)
      const heading = `  ${marker} ${theme.fg('textDim', verb)} ${label}${detail}${theme.fg('textMuted', elapsed(block, now))}`
      if (block.text.trim() === '') return [heading]
      const quoted = quote(block.text, width, theme, block.status === 'error' ? 'error' : 'textDim')
      const limit = block.status === 'error' ? resultPreviewLines * 3 : resultPreviewLines
      const visible = expanded || quoted.length <= limit ? quoted : quoted.slice(-limit)
      const rest = quoted.length - visible.length
      return [
        heading,
        ...visible,
        ...(rest > 0 ? [`    ${theme.fg('textMuted', `${symbols.ellipsis} 还有 ${String(rest)} 行 · Ctrl+O 展开`)}`] : []),
      ]
    }
    case 'diff': {
      const lines = renderDiff(block.text, width - 2, theme)
      const visible = expanded ? lines : lines.slice(0, diffPreviewLines)
      const rest = lines.length - visible.length
      return [
        `  ${theme.fg('accent', symbols.bullet)} ${theme.bold('textStrong', block.title)}`,
        ...visible,
        ...(rest > 0 ? [`    ${theme.fg('textMuted', `${symbols.ellipsis} 还有 ${String(rest)} 行 · Ctrl+O 展开`)}`] : []),
      ]
    }
    case 'changes':
      return [`  ${theme.fg('accent', symbols.bullet)} ${theme.fg('textStrong', block.title)}`
        + theme.fg('textMuted', `  ·  /diff ${String(block.changesSeq ?? '')}`)]
    case 'system':
      return [`  ${theme.fg('textMuted', '!')} ${theme.fg('textDim', block.text)}`]
    case 'error':
      return [`  ${theme.fg('error', symbols.failure)} ${theme.fg('error', block.title)}`,
        ...wrapLine(block.text, width - 4).map(line => `    ${theme.fg('error', line)}`)]
    case 'approval':
      return [
        `  ${theme.fg('warning', symbols.bullet)} ${theme.bold('warning', '等待审批')}  ${theme.fg('textDim', block.title)}`,
        ...wrapLine(block.text, width - 6).map(line => `    ${theme.fg('textDim', line)}`),
        `    ${theme.fg('textMuted', `/approve ${block.meta ?? ''}  ·  /deny ${block.meta ?? ''}`)}`,
      ]
    default:
      return []
  }
}

/** @returns the startup banner, aligned to the terminal width. */
export function renderBanner(width: number, theme: Theme, host: string): string[] {
  const title = theme.bold('primary', 'DSH CLI')
  const version = theme.fg('textMuted', `  v${TUI_VERSION}`)
  const rule = theme.fg('border', symbols.horizontal.repeat(Math.min(46, Math.max(12, width - 2))))
  return [
    '',
    `  ${title}${version}   ${theme.fg('textDim', 'DeepSeek Harness 终端客户端')}`,
    `  ${theme.fg('textMuted', host)}`,
    `  ${rule}`,
    `  ${theme.fg('textDim', '输入 /help 查看命令  ·  /model 选择模型  ·  /login 配置 API Key')}`,
    `  ${theme.fg('textMuted', '/skills 技能  ·  /mcp 服务  ·  /plan 计划  ·  /search 会话  ·  /files 文件')}`,
    '',
  ]
}

/** @returns grouped slash-command help rendered as aligned rows. */
export function renderHelp(width: number, theme: Theme, pasteShortcut: string): string[] {
  const lines: string[] = [`  ${theme.bold('textStrong', '命令')}`, '']
  for (const group of commandDescriptors) {
    lines.push(`  ${theme.fg('accent', group.heading)}`)
    for (const entry of group.entries) {
      const syntax = `${entry.name}${entry.args === '' ? '' : ` ${entry.args}`}`
      const gap = ' '.repeat(Math.max(1, 30 - visibleWidth(syntax)))
      lines.push(`    ${theme.fg('primary', syntax)}${gap}${theme.fg('textDim', entry.description)}`)
    }
    lines.push('')
  }
  lines.push(`  ${theme.fg('accent', '快捷键')}`)
  for (const [keys, description] of [
    ['Enter', '发送消息'],
    ['Shift+Enter / Ctrl+J', '换行'],
    ['↑ / ↓', '浏览历史或在补全菜单中移动'],
    ['Tab', '补全 slash 命令'],
    ['Ctrl+O', '展开 / 收起思考过程与工具输出'],
    ['/ 或 Tab', '在浮层中进入筛选输入'],
    ['Ctrl+R', '刷新当前浮层的数据'],
    ['I', '把浮层文档内容插入输入框'],
    ['Esc / Ctrl+C', '中断当前回答'],
    ['Ctrl+C × 2', '退出'],
    [pasteShortcut, '粘贴剪贴板图片'],
  ] as const) {
    const gap = ' '.repeat(Math.max(1, 24 - visibleWidth(keys)))
    lines.push(`    ${theme.fg('primary', keys)}${gap}${theme.fg('textDim', description)}`)
  }
  return lines.map(line => truncateTo(line, width - 1))
}
