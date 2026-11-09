/** Keyboard-driven model selection in the terminal transcript. */

import { clearScreenDown, cursorTo, emitKeypressEvents, moveCursor, type Key } from 'node:readline'
import type { ModelCatalog, ModelSelection } from './remote-contract.ts'
import { fitTerminalLine, type TerminalStyle } from './tui-input.ts'

interface Option extends ModelSelection {
  readonly name: string
}

/** Owns terminal input until the model picker is selected, dismissed, or aborted. */
interface ModelPicker {
  readonly result: Promise<ModelSelection | undefined>
  print(text: string): void
}

/**
 * @param catalog - models offered by the Host.
 * @param current - selection to highlight initially.
 * @param signal - cancellation of the terminal application.
 * @param paint - styles for the selected row and supporting text.
 * @returns the picker lifetime and a way to print incoming transcript output above it.
 */
export function openModelPicker(
  catalog: ModelCatalog, current: ModelSelection | undefined, signal: AbortSignal, paint: TerminalStyle,
): ModelPicker {
  const options: Option[] = catalog.groups.flatMap(group => group.models.map(item => ({
    provider: group.id, model: item.id, name: item.name || item.id,
  })))
  if (options.length === 0) throw new Error('Host 未提供可切换的模型。用 /login 检查 API Key')
  const active = current ?? catalog.default
  const { stdin, stdout } = process
  const { promise: result, resolve } = Promise.withResolvers<ModelSelection | undefined>()
  let filtered = options
  let query = ''
  let index = Math.max(0, options.findIndex(option => option.provider === active.provider && option.model === active.model))
  let first = 0
  let rows = 0
  let closed = false
  const wasRaw = stdin.isRaw === true
  const erase = (): void => {
    if (rows === 0) return
    moveCursor(stdout, 0, -rows)
    cursorTo(stdout, 0)
    clearScreenDown(stdout)
    rows = 0
  }
  const draw = (): void => {
    erase()
    const width = Math.max(1, stdout.columns - 1)
    const height = Math.max(1, Math.min(8, stdout.rows - 4))
    const fit = (line: string): string => fitTerminalLine(line, width)
    const heading = fit('选择模型')
    const search = query === '' ? '  输入筛选' : `  / ${query}`
    const headingLine = fit(`${heading}${search}`)
    first = Math.max(0, Math.min(first, index), index - height + 1)
    const lines = [
      paint(heading, 1) + paint(headingLine.slice(heading.length), 2),
      ...filtered.slice(first, first + height).map((option, offset) => {
        const selected = first + offset === index
        const isActive = option.provider === active.provider && option.model === active.model
        const label = fit(`${selected ? '›' : ' '} ${option.name}`)
        const provider = option.name.toLowerCase() === option.model.toLowerCase() ? option.provider : `${option.provider}/${option.model}`
        const details = isActive ? [`  当前 · ${provider}`, '  当前'] : [`  ${provider}`]
        const detail = details.find(value => fit(`${label}${value}`) === `${label}${value}`) ?? ''
        return (selected ? paint(label, 94) : label) + paint(detail, 2)
      }),
    ]
    if (filtered.length === 0) lines.push(fit('  没有匹配的模型'))
    const controls = '↑↓ 选择  ·  Enter 确认  ·  Esc 返回'
    lines.push(paint(fit(controls) === controls ? controls : fit('↑↓ · Enter · Esc'), 2))
    stdout.write(`${lines.join('\n')}\n`)
    rows = lines.length
  }
  const finish = (option?: Option): void => {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', abort)
    stdin.removeListener('keypress', press)
    stdin.removeListener('end', abort)
    stdout.removeListener('resize', draw)
    stdin.pause()
    stdin.setRawMode(wasRaw)
    erase()
    resolve(option === undefined ? undefined : { provider: option.provider, model: option.model })
  }
  const abort = (): void => { finish() }
  const press = (value: string | undefined, key: Key): void => {
    if (key.name === 'escape' || key.ctrl && (key.name === 'c' || key.name === 'd')) return finish()
    if (key.name === 'return' || key.name === 'enter') {
      const option = filtered[index]
      if (option !== undefined) finish(option)
      return
    }
    if (key.name === 'up' || key.name === 'down') {
      if (filtered.length !== 0) index = (index + (key.name === 'up' ? -1 : 1) + filtered.length) % filtered.length
    } else {
      if (key.name === 'backspace') query = Array.from(query).slice(0, -1).join('')
      else if (!key.ctrl && !key.meta && value !== undefined && /^[^\u0000-\u001f\u007f]+$/u.test(value)) {
        query = (query + value).slice(0, 160)
      } else return
      const search = query.trim().toLowerCase()
      filtered = options.filter(option => `${option.name} ${option.provider}/${option.model}`.toLowerCase().includes(search))
      index = 0
      first = 0
    }
    draw()
  }
  if (signal.aborted) {
    resolve(undefined)
  } else {
    emitKeypressEvents(stdin)
    stdin.setRawMode(true)
    stdin.on('keypress', press)
    stdin.once('end', abort)
    stdout.on('resize', draw)
    signal.addEventListener('abort', abort, { once: true })
    draw()
    stdin.resume()
  }
  return {
    result,
    print(text) {
      erase()
      stdout.write(`${text}\n`)
      if (!closed && !signal.aborted) draw()
    },
  }
}
