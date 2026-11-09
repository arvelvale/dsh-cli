/** Display rows shared by the terminal and mobile clients. */

import type { SessionEvent } from './remote-contract.ts'
import { isRecord } from './remote-client.ts'

/** One presentation block retaining the source event sequence. */
export interface DisplayRow {
  readonly key: string
  readonly kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'diff' | 'changes' | 'subagent' | 'file' | 'error'
  readonly title: string
  readonly text: string
  readonly path?: string
  readonly changesSeq?: number
}

/**
 * @param event - durable event from the DSH Session controller.
 * @returns ordered rows for recognized presentation events.
 */
export function displayRows(event: SessionEvent): readonly DisplayRow[] {
  const data: unknown = event.data
  if (!isRecord(data)) return []
  const rows: DisplayRow[] = []
  const add = (kind: DisplayRow['kind'], title: string, text: string, path?: string): void => {
    rows.push({ key: `${event.seq}:${rows.length}`, kind, title, text, ...(path === undefined ? {} : { path }) })
  }
  if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
    if (event.type === 'user/message' && (
      event.surfaceOp !== 'append' || !isRecord(data.source) || data.source.kind !== 'user'
    )) return rows
    const message = event.type === 'user/message' ? data : data.message
    if (isRecord(message) && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block)) continue
        if (block.type === 'reasoning' && typeof block.text === 'string') {
          add('reasoning', '思考过程', block.text)
        } else if (block.type === 'text' && typeof block.text === 'string') {
          if (event.type === 'tool/result') add(message.isError === true ? 'error' : 'tool', '工具结果', block.text)
          else if (event.type === 'user/message') add('user', '你', block.text)
          else add('assistant', 'DeepSeek', block.text)
        } else if (block.type === 'file' && isRecord(block.attachment)) {
          const path = block.attachment.path
          if (typeof path === 'string') add('file', '文件', path, path)
        } else if (block.type === 'image' && isRecord(block.attachment)) {
          const name = typeof block.attachment.name === 'string' ? block.attachment.name : '会话图片'
          add('file', '图片', name)
        }
      }
    }
    if (event.type === 'tool/result' && isRecord(data.meta) && Array.isArray(data.meta.diffs)) {
      for (const diff of data.meta.diffs) {
        if (!isRecord(diff) || typeof diff.path !== 'string' || typeof diff.newText !== 'string') continue
        const removed = typeof diff.oldText === 'string' ? diff.oldText.split('\n').map(line => `- ${line}`) : []
        const added = diff.newText.split('\n').map(line => `+ ${line}`)
        add('diff', diff.path, [...removed, ...added].join('\n'))
      }
    }
  } else if (event.type === 'tool/call') {
    add('tool', String(data.name ?? '工具调用'), String(data.arguments ?? ''))
  } else if (event.type === 'assistant/attempt' && Array.isArray(data.stream)) {
    for (const block of compactRows(data.stream, `attempt:${event.seq}`)) add(block.kind, block.title, block.text)
  } else if (event.type.startsWith('subagent/')) {
    add('subagent', event.type, JSON.stringify(data, null, 2))
  } else if (event.type === 'deliverables/presented' && Array.isArray(data.files)) {
    for (const file of data.files) {
      if (isRecord(file) && typeof file.path === 'string') add('file', '产物', file.path, file.path)
    }
  } else if (event.type === 'workspace/changes') {
    rows.push({
      key: `${event.seq}:changes`, kind: 'changes', title: '工作区差异', text: `第 ${String(data.turn)} 轮`, changesSeq: event.seq,
    })
  } else if (event.type.endsWith('/error')) {
    add('error', event.type, JSON.stringify(data))
  }
  return rows
}

/**
 * @param stream - compact opening records or live chunks of one Assistant attempt.
 * @param key - stable attempt key for the rendered blocks.
 * @returns the presentation blocks accumulated through the supplied chunk cut.
 */
export function compactRows(stream: readonly unknown[], key: string): readonly DisplayRow[] {
  const blocks = new Map<number, DisplayRow>()
  for (const record of stream) {
    const delta = assistantDelta(record, key)
    if (delta === undefined) continue
    blocks.set(delta.index, mergeDelta(blocks.get(delta.index), delta.row))
  }
  return [...blocks.values()]
}

/**
 * @param rows - previously accumulated blocks for the same attempt.
 * @param record - one incremental Assistant chunk.
 * @param key - stable attempt key.
 * @returns updated blocks without replaying the earlier chunks.
 */
export function appendAssistantRow(rows: readonly DisplayRow[], record: unknown, key: string): readonly DisplayRow[] {
  const delta = assistantDelta(record, key)
  if (delta === undefined) return rows
  if (!rows.some(row => row.key === delta.row.key)) return [...rows, delta.row]
  return rows.map(row => row.key === delta.row.key ? mergeDelta(row, delta.row) : row)
}

/** One changed file and its original position in the Host summary. */
export interface ChangedFile {
  readonly index: number
  readonly label: string
}

/**
 * @param value - JSON from the Desktop changes summary route.
 * @returns display labels with the indices needed by the diff route.
 */
export function changedFiles(value: unknown): readonly ChangedFile[] {
  if (!isRecord(value) || !Array.isArray(value.files)) throw new Error('服务器返回了无法读取的差异列表')
  return value.files.flatMap((file, index) => {
    if (!isRecord(file) || typeof file.display !== 'string') return []
    return [{ index, label: `${file.display}  +${String(file.added)} −${String(file.deleted)}` }]
  })
}

/**
 * @param value - JSON from the Desktop changes diff route.
 * @returns unified hunks, or a description of a file without a text diff.
 */
export function unifiedDiff(value: unknown): string {
  if (!isRecord(value)) throw new Error('服务器返回了无法读取的差异')
  if (value.kind === 'binary') return '二进制文件'
  if (value.kind === 'oversized') return '文件过大，无法显示差异'
  if (value.kind !== 'text' || !Array.isArray(value.hunks)) throw new Error('服务器返回了无法读取的差异')
  return value.hunks.flatMap((hunk) => {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) return []
    return [
      `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`,
      ...hunk.lines.filter(line => typeof line === 'string'),
    ]
  }).join('\n') || '没有文本差异'
}

function mergeDelta(previous: DisplayRow | undefined, row: DisplayRow): DisplayRow {
  if (previous === undefined) return row
  return { ...row, title: row.title === '工具调用' ? previous.title : row.title, text: previous.text + row.text }
}

function assistantDelta(record: unknown, key: string): { index: number; row: DisplayRow } | undefined {
  if (!isRecord(record)) return undefined
  const chunk = record.type === 'chunk' && isRecord(record.chunk) ? record.chunk : record
  if (typeof chunk.index !== 'number') return undefined
  const kind = chunk.type === 'reasoning-chunks' || chunk.type === 'reasoning-delta' ? 'reasoning'
    : chunk.type === 'tool-call-chunks' || chunk.type === 'tool-call-delta' ? 'tool'
      : chunk.type === 'text-chunks' || chunk.type === 'text-delta' ? 'assistant'
        : undefined
  if (kind === undefined) return undefined
  const packed = kind === 'tool' ? chunk.args : chunk.texts
  const delta = kind === 'tool' ? chunk.argumentsDelta : chunk.text
  const text = Array.isArray(packed) ? packed.filter(part => typeof part === 'string').join('')
    : typeof delta === 'string' ? delta : ''
  const title = kind === 'reasoning' ? '思考过程' : kind === 'assistant' ? 'DeepSeek'
    : typeof chunk.name === 'string' ? chunk.name : '工具调用'
  return { index: chunk.index, row: { key: `${key}:${chunk.index}`, kind, title, text } }
}
