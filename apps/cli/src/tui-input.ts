/** Command discovery and isolated secret entry for the terminal client. */

import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { TUI_VERSION } from './tui-version.ts'

export type TerminalStyle = (text: string, ...codes: number[]) => string

const commands = [
  ['会话', [
    ['/new', '[服务器目录]', '新建会话'],
    ['/sessions', '', '查看会话列表'],
    ['/attach', 'ID', '接续指定会话'],
    ['/thinking', '', '展开或收起思考'],
    ['/diff', 'SEQ [序号]', '查看工作区差异'],
  ]],
  ['输入与附件', [
    ['/image', '路径', '添加终端所在机器的图片'],
    ['/paste', '', '从本机剪贴板添加图片'],
    ['/images', '[clear]', '列出或清空待发送图片'],
    ['/send', '', '只发送待发送图片'],
  ]],
  ['配置与审批', [
    ['/login', '', '隐藏输入并保存 DeepSeek API Key'],
    ['/model', '[提供方 模型]', '用方向键选择模型，或直接指定模型'],
    ['/status', '', '查看连接、会话和 API Key 状态'],
    ['/approve', 'ID', '仅允许本次工具调用'],
    ['/deny', 'ID', '拒绝工具调用'],
  ]],
  ['帮助', [
    ['/help', '', '显示命令帮助'],
    ['/exit', '', '退出终端客户端（也可用 /quit）'],
  ]],
] as const

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
  const names = commands.flatMap(([, group]) => group.map(([name]) => name))
  return [[...names, '/quit'].filter(name => name.startsWith(line)), line]
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
    if (lifetime.aborted) return undefined
    throw error
  } finally {
    editor.close()
    silent.destroy()
    process.stdout.write('\n')
  }
}
