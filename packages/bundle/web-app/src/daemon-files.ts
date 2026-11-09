/** Read-only file delivery for an explicitly configured local workspace. */

import { constants } from 'node:fs'
import { open, opendir, realpath, stat, type FileHandle } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

const PREVIEW_BYTES = 128 * 1024
const DOWNLOAD_BYTES = 100 * 1024 * 1024
const DIRECTORY_ENTRIES = 2_000
const PATH = '/api/daemon.files'
const securityHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }

/** Services required before registering the protected workspace route. */
export const inject = ['connection']

/** Workspace root resolved and verified at startup. */
export interface Config {
  readonly root: string
}

function visiblePart(part: string): boolean {
  return part !== '' && !part.startsWith('.') && !/[\\:\u0000-\u001F\u007F]/u.test(part)
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix.split(sep).every(visiblePart))
}

function refusal(message: string, status: number): Response {
  return new Response(message, { status, headers: securityHeaders })
}

async function checkedHandle(root: string, path: string, directory: boolean): Promise<FileHandle> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    | (directory ? constants.O_DIRECTORY : 0)
  const file = await open(path, flags)
  try {
    const actual = await realpath(`/proc/self/fd/${file.fd}`)
    if (!within(root, actual)) throw new Error('Workspace path escaped its root')
    return file
  } catch (error) {
    await file.close()
    throw error
  }
}

async function list(root: string, target: string): Promise<Response> {
  const handle = await checkedHandle(root, target, true)
  try {
    const directory = await opendir(`/proc/self/fd/${handle.fd}`)
    const entries: Array<{ name: string; kind: 'directory' | 'file' }> = []
    for await (const entry of directory) {
      if (!visiblePart(entry.name) || !(entry.isDirectory() || entry.isFile())) continue
      if (entries.length === DIRECTORY_ENTRIES) return refusal('Directory has more than 2000 visible entries', 413)
      entries.push({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })
    }
    entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
    return Response.json({ root, entries }, { headers: securityHeaders })
  } finally {
    await handle.close()
  }
}

async function read(root: string, target: string, mode: 'preview' | 'download'): Promise<Response> {
  const file = await checkedHandle(root, target, false)
  let handedOff = false
  try {
    const info = await file.stat()
    if (!info.isFile()) return refusal('Expected a regular file', 404)
    if (mode === 'preview') {
      const buffer = Buffer.alloc(Math.min(info.size, PREVIEW_BYTES))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      const slice = buffer.subarray(0, bytesRead)
      if (slice.includes(0)) return refusal('Binary file; use download', 415)
      const truncated = info.size > bytesRead
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(slice, { stream: truncated })
      } catch (error) {
        if (error instanceof TypeError) return refusal('File is not UTF-8; use download', 415)
        throw error
      }
      return Response.json({ text, truncated }, { headers: securityHeaders })
    }
    if (info.size > DOWNLOAD_BYTES) return refusal('File exceeds the 100 MiB download limit', 413)
    if (info.size === 0) return new Response(null, { headers: securityHeaders })
    const filename = encodeURIComponent(basename(target)).replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16)}`)
    const stream = file.createReadStream({ start: 0, end: info.size - 1, autoClose: true })
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.next()
        if (chunk.done === true) controller.close()
        else controller.enqueue(chunk.value)
      },
      cancel() { stream.destroy() },
    })
    const reader = stream[Symbol.asyncIterator]()
    handedOff = true
    return new Response(body, {
      headers: {
        ...securityHeaders,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
        'Content-Length': String(info.size),
      },
    })
  } finally {
    if (!handedOff) await file.close()
  }
}

/** Register the file tree, UTF-8 preview, and bounded download behind Connection admission.
 * @param ctx - Cordis context carrying the authenticated route registry.
 * @param config - local Linux workspace directory to export.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (process.platform !== 'linux') throw new Error('daemon workspace export requires Linux descriptor validation')
  const root = await realpath(config.root)
  if (!(await stat(root)).isDirectory() || root === resolve(root, sep)) {
    throw new Error('daemon workspace export requires a non-root directory')
  }
  ctx.connection.fetch.register({
    path: PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const query = new URL(request.url).searchParams
      const path = query.get('path') ?? ''
      const mode = query.get('mode')
      if (mode !== 'list' && mode !== 'preview' && mode !== 'download') return refusal('Unknown file operation', 400)
      if (path !== '' && !path.split('/').every(visiblePart)) return refusal('Invalid relative workspace path', 400)
      try {
        const target = await realpath(resolve(root, path))
        if (!within(root, target)) return refusal('Path is outside the workspace', 403)
        return mode === 'list' ? await list(root, target) : await read(root, target, mode)
      } catch {
        // Do not disclose whether a denied path exists outside the workspace.
        return refusal('Workspace entry is unavailable', 404)
      }
    },
  })
}
