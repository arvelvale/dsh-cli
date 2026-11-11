/** Command discovery and isolated secret entry for the terminal client. */

import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { TUI_VERSION } from './tui-version.ts'

export type TerminalStyle = (text: string, ...codes: number[]) => string

/** One slash command shown in completions and help. */
export interface CommandEntry {
  readonly name: string
  readonly args: string
  readonly description: string
}

/** A labelled group of slash commands. */
export interface CommandGroup {
  readonly heading: string
  readonly entries: readonly CommandEntry[]
}

export const commandDescriptors: readonly CommandGroup[] = [
  { heading: '会话', entries: [
    { name: '/new', args: '[服务器目录]', description: '新建会话' },
    { name: '/sessions', args: '', description: '查看会话列表' },
    { name: '/attach', args: 'ID', description: '接续指定会话' },
    { name: '/thinking', args: '', description: '展开或收起思考' },
    { name: '/diff', args: 'SEQ [序号]', description: '查看工作区差异' },
    { name: '/compact', args: '', description: '收起历史输出' },
  ] },
  { heading: '浏览与工作区', entries: [
    { name: '/skills', args: '', description: '浏览并调用 Host 技能' },
    { name: '/mcp', args: '', description: '管理 MCP 服务' },
    { name: '/plan', args: '', description: '查看计划与任务清单' },
    { name: '/search', args: '[关键词]', description: '搜索并接续会话' },
    { name: '/files', args: '[路径]', description: '浏览工作区文件' },
    { name: '/settings', args: '', description: '查看 Host 配置' },
  ] },
  { heading: '输入与附件', entries: [
    { name: '/image', args: '路径', description: '添加本机图片' },
    { name: '/paste', args: '', description: '粘贴剪贴板图片' },
    { name: '/images', args: '[clear]', description: '列出或清空待发送图片' },
    { name: '/send', args: '', description: '只发送待发送图片' },
  ] },
  { heading: '配置与审批', entries: [
    { name: '/login', args: '', description: '隐藏输入并保存 API Key' },
    { name: '/model', args: '[提供方 模型]', description: '选择或指定模型' },
    { name: '/theme', args: '[dark|light]', description: '切换配色' },
    { name: '/status', args: '', description: '查看连接与配置状态' },
    { name: '/approve', args: 'ID', description: '允许本次工具调用' },
    { name: '/deny', args: 'ID', description: '拒绝工具调用' },
  ] },
  { heading: '帮助', entries: [
    { name: '/help', args: '', description: '显示命令帮助' },
    { name: '/exit', args: '', description: '退出终端客户端' },
    { name: '/quit', args: '', description: '退出终端客户端' },
  ] },
]

const commands = commandDescriptors.map(group => [
  group.heading,
  group.entries.map(entry => [entry.name, entry.args, entry.description] as const),
] as const)

/**
 * @param width - available terminal columns, defaulting to 80 for redirected output.
 * @param pasteShortcut - shortcut available in the interactive editor.
 * @returns grouped syntax and descriptions for the CLI and interactive help.
 */
export function commandHelp(width = 80, pasteShortcut?: string): string {
  const help = commands.map(([heading, entries]) => [
    heading,
    ...entries.map(([name, args, description]) => {
      const syntax = args === '' ? name : `${name} ${args}`
      if (width < 52) return `  ${syntax}\n    ${description}`
      const hanColumns = syntax.match(/\p{Script=Han}/gu)?.length ?? 0
      return `  ${syntax.padEnd(27 - hanColumns)} ${description}`
    }),
  ].join('\n')).join('\n\n')
  return pasteShortcut === undefined ? help : `${help}\n\n输入技巧\n  Tab 补全命令，连按两次查看候选\n  ${pasteShortcut} 粘贴剪贴板图片`
}

/**
 * @param line - current editor text.
 * @returns command-only Tab completions and the prefix they replace.
 */
export function completeCommand(line: string): [string[], string] {
  if (!/^\/[a-z]*$/u.test(line)) return [[], line]
  const names = commandDescriptors.flatMap(group => group.entries.map(entry => entry.name))
  return [names.filter(name => name.startsWith(line)), line]
}

/** Sanitize a label and fit it into the remaining terminal columns. */
export function fitTerminalLine(text: string, width: number): string {
  let result = ''
  let columns = 0
  for (const character of stripVTControlCharacters(text).replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')) {
    columns += (character.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1
    if (columns > width) break
    result += character
  }
  return result
}

/**
 * @param width - terminal columns.
 * @param host - Host address to show without the scheme.
 * @param paint - styles for the wordmark and secondary text.
 * @param pasteShortcut - shortcut available in the interactive editor.
 * @returns a compact welcome header and a single line of entry points.
 */
export function welcome(width: number, host: string, paint: TerminalStyle, pasteShortcut?: string): string {
  const columns = Math.max(0, width - 1)
  const fit = (line: string): string => fitTerminalLine(line, columns)
  const version = `  v${TUI_VERSION}`
  const title = 'DSH CLI'
  const mark = columns >= `[>]  ${title}${version}`.length ? '[>]  ' : ''
  const wordmark = paint(fit(`${mark}${title}`), 1, 94)
  const versionLabel = columns >= mark.length + title.length + version.length ? paint(version, 2) : ''
  const hints = pasteShortcut === undefined ? '/help  ·  /model  ·  /login' : `/help  ·  /model  ·  ${pasteShortcut} 粘贴图片`
  const hintLine = [hints, '/help  ·  /model', '/help'].find(line => fit(line) === line) ?? ''
  const rule = pasteShortcut === undefined ? '-' : '─'
  return [
    '',
    wordmark + versionLabel,
    paint(fit(`${' '.repeat(mark.length)}${host}`), 2),
    '',
    paint(rule.repeat(Math.min(42, columns)), 2),
    paint(hintLine, 2),
  ].join('\n') + '\n'
}

/** Keep the AbortSignal check outside the type-narrowed call site. */
function wasCancelled(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Read a secret using an independent TTY editor with neither output nor history.
 * The caller must close its ordinary editor before invoking this function.
 * @param signal - cancellation of the terminal application.
 * @returns the entered key, or undefined on Ctrl+C or EOF.
 */
export async function readProviderKey(signal: AbortSignal): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在交互式终端中运行 /login')
  const cancelled = new AbortController()
  const lifetime = AbortSignal.any([signal, cancelled.signal])
  if (lifetime.aborted) return undefined
  const silent = new Writable({ write(_chunk, _encoding, done) { done() } })
  const editor = createInterface({ input: process.stdin, output: silent, terminal: true, historySize: 0 })
  const cancel = (): void => { cancelled.abort() }
  editor.once('close', cancel)
  editor.once('SIGINT', cancel)
  process.stdout.write('DeepSeek API Key（输入隐藏，Ctrl+C 取消） > ')
  try {
    const key = (await editor.question('', { signal: lifetime })).trim()
    return key === '' ? undefined : key
  } catch (error) {
    if (wasCancelled(lifetime)) return undefined
    throw error
  } finally {
    editor.close()
    silent.destroy()
    process.stdout.write('\n')
  }
}
