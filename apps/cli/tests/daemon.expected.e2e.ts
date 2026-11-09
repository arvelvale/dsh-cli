/** Two independent clients share a real daemon and recover its durable output. */

import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
import { expect, it, vi } from 'vitest'
import WebSocketClient from 'ws'
import { RemoteClient, type RemoteApproval, type RemoteWatch } from '../src/remote-client.ts'
import type { SessionEvent } from '../src/remote-contract.ts'
import { displayRows } from '../src/remote-presentation.ts'

const bin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const wsOptions = WebSocket as typeof WebSocket & {
  new (url: string, options: { headers: Readonly<Record<string, string>> }): WebSocket
}

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() })
  })
  if (address === null || typeof address === 'string') throw new Error('Missing test Host port')
  return address.port
}

function observe(events: SessionEvent[], chunks: string[] = []): RemoteWatch {
  return {
    opening: (opening) => { events.push(...opening.events) },
    event: (event) => { events.push(event) },
    assistant: (frame) => { if (frame.type === 'chunk') chunks.push(JSON.stringify(frame.chunk)) },
    approvals: () => {},
  }
}

function rejectedUpgrade(origin: string, token?: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketClient(`${origin.replace('http:', 'ws:')}/api/remote.mux`, {
      handshakeTimeout: 5_000,
      ...(token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }),
    })
    socket.once('unexpected-response', (request, response) => {
      response.resume()
      request.destroy()
      resolve(response.statusCode)
    })
    socket.once('open', () => { socket.close(); reject(new Error('Unauthorized upgrade was accepted')) })
    socket.once('error', reject)
  })
}

it('rejects unauthenticated HTTP and WebSocket clients and resumes one shared Session from a cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-daemon-'))
  const outside = join(root, 'approval-target.txt')
  const model = await startMockLlmServer({
    sequence: ['reasoning_success', 'reasoning_success', 'tool_call_success', 'reasoning_success'],
    reasoningText: 'deterministic reasoning',
    successText: 'deterministic reply',
    toolName: 'write',
    toolArguments: JSON.stringify({
      file_path: outside,
      content: 'unexpected write',
      sandbox_permissions: 'danger-full-access',
      justification: 'Write a disposable test fixture outside the workspace.',
    }),
  })
  const token = randomBytes(32).toString('base64url')
  const tokenFile = join(root, 'token')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(tokenFile, token, { mode: 0o600 })
  await writeFile(join(workspace, 'result.txt'), 'artifact data')
  await writeFile(join(workspace, '.env'), 'private fixture')
  const screenshot = join(workspace, 'test  screenshot.png')
  await writeFile(screenshot, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64',
  ))
  if (process.platform === 'linux') await symlink(tokenFile, join(workspace, 'outside.txt'))
  const patch = join(root, 'test.patch.yml')
  await writeFile(patch, `
- id: session-log-deepseek
  disabled: true
- id: session-title-llm
  disabled: true
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-flash-vision-exp
- id: llm-deepseek
  config:
    models:
      - id: deepseek-v4-flash-vision-exp
        contextWindow: 32768
        maxTokens: 1024
        inputModalities: [text, image]
`)
  const port = await reservePort()
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [bin, 'daemon', '--patch', patch, '--port', String(port)], {
    cwd: workspace,
    env: {
      ...process.env,
      DSH_HOME: join(root, 'home'),
      DSH_AGENTS_HOME: join(root, 'agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DSH_DAEMON_TOKEN_FILE: tokenFile,
      DSH_DAEMON_WORKSPACE: process.platform === 'linux' ? workspace : undefined,
      DSH_PERMISSION_MODE: 'workspace-write',
      DEEPSEEK_API_KEY: 'fixture-api-key',
      DEEPSEEK_BASE_URL: model.baseURL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ended = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
  let logs = ''
  child.stdout.on('data', (data: Buffer) => { logs = (logs + data.toString()).slice(-12_000) })
  child.stderr.on('data', (data: Buffer) => { logs = (logs + data.toString()).slice(-12_000) })
  const platform = { id: randomUUID, socket: (url: string, headers: Readonly<Record<string, string>>) => new wsOptions(url, { headers }) }
  const first = new RemoteClient(origin, token, platform)
  const second = new RemoteClient(origin, token, platform)
  const watchers = [new AbortController(), new AbortController(), new AbortController()] as const
  const tasks: Promise<void>[] = []
  const start = (client: RemoteClient, id: string, cursor: number | undefined, watch: RemoteWatch, signal: AbortSignal): void => {
    const task = client.follow(id, cursor, watch, signal)
    void task.catch(() => {}) // Collected with the other watcher lifetimes in finally.
    tasks.push(task)
  }
  try {
    await vi.waitFor(() => first.list(), { timeout: 60_000, interval: 200 })
    expect((await fetch(`${origin}/api/session/list`, { method: 'POST' })).status).toBe(401)
    await expect(new RemoteClient(origin, 'x'.repeat(43), platform).list()).rejects.toMatchObject({ code: '401' })
    await vi.waitFor(async () => { expect(await rejectedUpgrade(origin)).toBe(401) }, { timeout: 10_000 })
    expect(await rejectedUpgrade(origin, 'x'.repeat(43))).toBe(401)
    expect((await fetch(origin)).status).toBe(404)
    expect(await first.providerKeyStatus()).toMatchObject({ configured: true, source: 'env' })
    await first.setProviderKey('fixture-rotated-key')
    expect(await second.providerKeyStatus()).toEqual({ configured: true, writable: true, source: 'file' })

    const { sessionId } = await first.create()
    const firstEvents: SessionEvent[] = []
    const secondEvents: SessionEvent[] = []
    const streamed: string[] = []
    let firstApprovals: readonly RemoteApproval[] = []
    let secondApprovals: readonly RemoteApproval[] = []
    start(first, sessionId, undefined, {
      ...observe(firstEvents, streamed), approvals: (items) => { firstApprovals = items },
    }, watchers[0].signal)
    start(second, sessionId, undefined, observe(secondEvents), watchers[1].signal)
    await vi.waitFor(() => { expect(firstEvents.length).toBeGreaterThan(0); expect(secondEvents.length).toBeGreaterThan(0) })
    const tui = await execa(process.execPath, [bin, 'tui', '--url', origin, '--session', sessionId], {
      cwd: workspace,
      env: { DSH_HOME: join(root, 'tui-home'), DSH_DAEMON_TOKEN: token },
      input: ['/status', '/model', '/image "test  screenshot.png"', '/images', 'First', '/exit'].join('\n') + '\n',
      timeout: 25_000,
    })
    expect(tui.stdout).toContain('API Key  已配置')
    expect(tui.stdout).toContain('deepseek-v4-flash-vision-exp')
    expect(tui.stdout).toContain('已添加 [图片：test  screenshot.png]')
    expect(tui.stdout).not.toContain('fixture-rotated-key')
    await vi.waitFor(() => {
      expect(firstEvents.flatMap(displayRows)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'assistant', text: 'deterministic reply' }),
        expect.objectContaining({ kind: 'reasoning', text: 'deterministic reasoning' }),
        expect.objectContaining({ title: '图片', text: 'test  screenshot.png' }),
      ]))
      expect(firstEvents.at(-1)?.type).toBe('turn/end')
      expect(secondEvents).toEqual(firstEvents)
    }, { timeout: 20_000 })
    expect(model.requests[0]?.headers['x-api-key']).toBe('fixture-rotated-key')
    expect(JSON.stringify(model.requests[0]?.body)).toContain('"type":"image"')
    expect(streamed.some(chunk => chunk.includes('reasoning-delta'))).toBe(true)
    const cursor = secondEvents.at(-1)?.seq
    expect(cursor).toBeTypeOf('number')
    watchers[1].abort()
    await second.prompt(sessionId, 'Second')
    await vi.waitFor(() => {
      expect(firstEvents.filter(event => event.type === 'turn/end')).toHaveLength(2)
    }, { timeout: 20_000 })
    const recovered: SessionEvent[] = []
    start(second, sessionId, cursor, {
      ...observe(recovered), approvals: (items) => { secondApprovals = items },
    }, watchers[2].signal)
    await vi.waitFor(() => {
      expect(recovered).toEqual(firstEvents.filter(event => cursor !== undefined && event.seq > cursor))
    })
    expect(recovered.flatMap(displayRows)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'assistant', text: 'deterministic reply' }),
    ]))
    expect(model.requests).toHaveLength(2)
    await first.prompt(sessionId, 'Request the test approval')
    await vi.waitFor(() => {
      expect(firstApprovals).toHaveLength(1)
      expect(secondApprovals).toEqual(firstApprovals)
    }, { timeout: 15_000 })
    const approval = secondApprovals[0]
    if (approval === undefined) throw new Error('Second client missed approval')
    await second.answer(approval.id, 'rejected')
    await vi.waitFor(() => {
      expect(firstApprovals).toHaveLength(0)
      expect(secondApprovals).toHaveLength(0)
      expect(firstEvents.filter(event => event.type === 'turn/end')).toHaveLength(3)
      expect(firstEvents.some(event => event.type === 'tool/result')).toBe(true)
    }, { timeout: 15_000 })
    await expect(stat(outside)).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.platform === 'linux') {
      const preview = first.fileRequest('result.txt', 'preview')
      expect(await (await fetch(preview.url, { headers: preview.headers })).json()).toEqual({
        text: 'artifact data', truncated: false,
      })
      const download = first.fileRequest('result.txt', 'download')
      expect(await (await fetch(download.url, { headers: download.headers })).text()).toBe('artifact data')
      expect((await fetch(download.url)).status).toBe(401)
      for (const [path, status] of [['../token', 400], ['.env', 400], ['outside.txt', 403]] as const) {
        const denied = first.fileRequest(path, 'download')
        expect((await fetch(denied.url, { headers: denied.headers })).status).toBe(status)
      }
    }
  } catch (error) {
    throw new Error(`${String(error)}\n${logs}`, { cause: error })
  } finally {
    for (const watcher of watchers) watcher.abort()
    const settled = await Promise.allSettled(tasks)
    child.kill('SIGTERM')
    const force = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
    await ended
    clearTimeout(force)
    await model.close()
    await rm(root, { recursive: true, force: true })
    for (const result of settled) if (result.status === 'rejected') throw result.reason
  }
})
