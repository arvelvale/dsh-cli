/** HTTP RPC and live Session follow over the DSH Gateway's native wire protocol. */

import type {
  DirectoryListing,
  FilePreview,
  McpProbeValue,
  McpServerView,
  ModelCatalog,
  ModelSelection,
  PlanDocument,
  PromptContentPart,
  SessionAddress,
  SessionEventsPage,
  SessionFollowFrame,
  SessionListValue,
  SessionOpening,
  SessionEvent,
  SessionSearchValue,
  SettingsDescribeValue,
  SettingsNamespaceView,
  SkillListValue,
} from './remote-contract.ts'

const MCP_SETTINGS_MARK = 'dsh-mcp-manager'
const MCP_NAMESPACE = `@deepseek-ai/${MCP_SETTINGS_MARK}`

const DEEPSEEK_API_KEY_REF = 'DEEPSEEK_API_KEY'

/** DSH-supported media types for staged prompt images. */
export type PromptImageType = Extract<PromptContentPart, { type: 'image' }>['mediaType']

/** Whether the Host has a DeepSeek credential and where it resolves from. */
export interface ProviderKeyStatus {
  readonly configured: boolean
  readonly writable: boolean
  readonly source?: string
}

/** Socket operations shared by Node and React Native. */
export type RemoteSocket = Pick<WebSocket, 'addEventListener' | 'close' | 'send'>

/** An unsettled Host approval tied to one connection generation. */
export interface RemoteApproval {
  readonly id: string
  readonly sessionId: string
  readonly tool: string
  readonly reason: string
}

/** Socket and identity factories supplied by the client platform. */
export interface RemotePlatform {
  socket(url: string, headers: Readonly<Record<string, string>>): RemoteSocket
  id(): string
}

/** A Gateway failure with the status or Remote code required for client recovery. */
export class RemoteFailure extends Error {
  /**
   * @param code - HTTP status or the Host's Remote failure code.
   * @param message - description for the operator.
   */
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Validate a wire object before accessing its fields.
 * @param value - decoded JSON.
 * @returns whether it is a non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Watch callbacks receive durable data separately from process-local frames. */
export interface RemoteWatch {
  opening(value: SessionOpening): void
  event(event: SessionEvent): void
  assistant(frame: Extract<SessionFollowFrame, { type: 'assistant-stream' }>['frame']): void
  approvals(items: readonly RemoteApproval[]): void
}

/** A client owns one target origin and one administrator token. */
export class RemoteClient {
  private readonly base: string
  private readonly headers: Readonly<Record<string, string>>
  private interactions: {
    id?: string
    answered(eventId: string): void
  } | undefined

  /**
   * @param url - HTTP loopback or HTTPS origin of the daemon.
   * @param token - administrator token sent exclusively as a Bearer header.
   * @param platform - platform socket and correlation-id implementations.
   */
  constructor(url: string, token: string, private readonly platform: RemotePlatform) {
    const address = new URL(url)
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)
    if ((address.protocol !== 'https:' && !(address.protocol === 'http:' && loopback))
      || address.username || address.password || address.search || address.hash || address.pathname !== '/') {
      throw new Error('Use an HTTPS origin or an HTTP loopback origin')
    }
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error('Expected a 43-character DSH token')
    this.base = address.origin
    this.headers = { Authorization: `Bearer ${token}` }
  }

  /**
   * @param method - exact DSH Remote endpoint name.
   * @param args - named arguments for the Remote endpoint.
   * @param signal - optional cancellation for this HTTP call.
   * @returns the successful Host RPC result.
   */
  async rpc<T>(method: string, args: object, signal?: AbortSignal): Promise<T> {
    const rpcId = this.platform.id()
    const response = await fetch(`${this.base}/api/${method}`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', method, rpcId, payload: { args } }),
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new RemoteFailure(String(response.status), `Host returned HTTP ${response.status}`)
    const envelope: unknown = await response.json()
    if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !isRecord(envelope.result)) throw new Error('Invalid DSH RPC response')
    const result = envelope.result
    if (result.ok === true) return result.value as T
    throw failure(result.error)
  }

  /** @returns the live and persisted Session inventory. */
  list(): Promise<SessionListValue> {
    return this.rpc('session/list', { _request: {} })
  }

  /**
   * @param cwd - optional server-side working directory; omission uses the Host default.
   * @returns the created Session identity.
   */
  create(cwd?: string): Promise<{ readonly sessionId: string }> {
    return this.rpc('session/create', { request: cwd === undefined ? {} : { cwd } })
  }

  /**
   * @param sessionId - Session that receives the input.
   * @param text - user input queued at the next Host boundary, optionally empty with receipts.
   * @param receipts - staged uploads belonging to that Session.
   * @returns the admission receipt, which does not imply turn completion.
   */
  prompt(sessionId: string, text: string, receipts: readonly string[] = []): Promise<{ readonly accepted: true }> {
    return this.rpc('session/prompt', { request: {
      sessionId,
      requestId: this.platform.id(),
      mode: 'queue',
      content: [
        ...(text.trim() === '' && receipts.length > 0 ? [] : [{ type: 'text', text }]),
        ...receipts.map(receiptId => ({ type: 'file', receiptId })),
      ],
    } })
  }

  /**
   * Interrupt the active Agent turn without discarding its queued input.
   * @param sessionId - Session whose current turn should stop.
   * @returns the Host acknowledgement.
   */
  cancel(sessionId: string): Promise<{ readonly accepted: true }> {
    return this.rpc('session/cancel', { request: { sessionId } })
  }

  /**
   * @param sessionId - Session that will own the resulting receipt.
   * @param body - raw bytes of the image.
   * @param mediaType - image type verified again by the Host.
   * @param name - display name sent without a local directory.
   * @param signal - cancellation for the transfer, if supplied.
   * @returns the opaque receipt used in the next prompt.
   */
  async uploadImage(sessionId: string, body: Blob, mediaType: PromptImageType, name: string, signal?: AbortSignal): Promise<string> {
    const query = new URLSearchParams({ sessionId, mediaType, name })
    const response = await fetch(`${this.base}/api/session/uploadFileBinary?${query}`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/octet-stream' },
      body,
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new RemoteFailure(String(response.status), `图片上传失败（HTTP ${response.status}）`)
    const result: unknown = await response.json()
    if (isRecord(result)) {
      if (result.ok === false) throw failure(result.error)
      if (result.ok === true && isRecord(result.value) && typeof result.value.receiptId === 'string') {
        return result.value.receiptId
      }
    }
    throw new Error('Host 返回了无效的图片上传凭据')
  }

  /** @returns the DeepSeek key's availability and origin, without the secret. */
  async providerKeyStatus(): Promise<ProviderKeyStatus> {
    const refs = await this.rpc<Record<string, unknown>>('credentials/describe', { refs: [DEEPSEEK_API_KEY_REF] })
    const status = refs[DEEPSEEK_API_KEY_REF]
    if (!isRecord(status) || typeof status.configured !== 'boolean' || typeof status.writable !== 'boolean') {
      throw new Error('Host 返回了无效的 API Key 状态')
    }
    return {
      configured: status.configured,
      writable: status.writable,
      ...(typeof status.source === 'string' ? { source: status.source } : {}),
    }
  }

  /**
   * @param value - write-only DeepSeek API Key for the Host credential store.
   * @param signal - cancellation for the HTTP request, if supplied.
   */
  async setProviderKey(value: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.rpc('credentials/set', { ref: DEEPSEEK_API_KEY_REF, value }, signal)
    } catch (error) {
      const code = error instanceof RemoteFailure ? `（${error.code}）` : ''
      // Provider or transport diagnostics may echo submitted data.
      throw new Error(`保存 API Key 失败${code}。用 /status 确认 Host 配置`)
    }
  }

  /** @returns the model catalog and the Host default for unconfigured Sessions. */
  modelCatalog(): Promise<ModelCatalog> {
    return this.rpc('session/modelCatalog', {})
  }

  /**
   * @param sessionId - Session receiving a new model selection.
   * @param selection - provider and model ids published in the Host catalog.
   * @returns the selection normalized by the Host.
   */
  async selectModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection> {
    const result = await this.rpc<{ selected: ModelSelection }>('session/selectModel', { request: { sessionId, ...selection } })
    return result.selected
  }

  /**
   * @param sessionId - Session whose prior history is requested.
   * @param beforeSeq - exclusive upper bound before the oldest loaded event.
   * @returns the preceding chronological history page.
   */
  history(sessionId: string, beforeSeq: number): Promise<SessionEventsPage> {
    return this.rpc('session/events', { request: { address: { kind: 'session', sessionId }, beforeSeq, maxMessages: 30 } })
  }

  /**
   * @param sessionId - Session that announced its changed files.
   * @param seq - sequence of the workspace/changes event.
   * @param index - file position for a diff, or undefined for the summary.
   * @param signal - optional cancellation for the HTTP request.
   * @returns the same summary or unified diff served to the Desktop change view.
   */
  async changes(sessionId: string, seq: number, index?: number, signal?: AbortSignal): Promise<unknown> {
    const query = new URLSearchParams({ sessionId, seq: String(seq) })
    if (index !== undefined) query.set('index', String(index))
    const endpoint = index === undefined ? 'changes.summary' : 'changes.diff'
    const response = await fetch(`${this.base}/api/${endpoint}?${query}`, {
      headers: this.headers,
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new RemoteFailure(String(response.status), `Host returned HTTP ${response.status}`)
    return response.json()
  }

  /**
   * @param id - pending approval on the current socket.
   * @param decision - allow only this invocation or reject it.
   * @returns after the Host admits the answer.
   */
  async answer(id: string, decision: 'allowed-once' | 'rejected'): Promise<void> {
    const interactions = this.interactions
    await this.settleInteraction(id, { kind: 'result', value: decision })
    interactions?.answered(id)
  }

  private settleInteraction(id: string, outcome: object): Promise<unknown> {
    const clientId = this.interactions?.id
    if (clientId === undefined) return Promise.reject(new Error('Approval connection is unavailable'))
    return this.rpc('$events/result', { clientId, eventId: id, outcome })
  }

  /**
   * @param path - relative workspace path, or empty for its root.
   * @param mode - browse entries, preview text, or retrieve the file.
   * @returns request data for fetch or the platform's download manager.
   */
  fileRequest(path: string, mode: 'list' | 'preview' | 'download'): {
    readonly url: string
    readonly headers: Readonly<Record<string, string>>
  } {
    return { url: `${this.base}/api/daemon.files?mode=${mode}&path=${encodeURIComponent(path)}`, headers: this.headers }
  }

  /** @returns user-invocable Skills visible to one Session's cwd and preset. */
  skills(sessionId: string): Promise<SkillListValue> {
    return this.rpc('skills/list', { request: { sessionId } })
  }

  /**
   * Read the first full snapshot of `mcpManager/watch` without keeping a subscription.
   * @param signal - cancellation of the terminal application.
   * @returns one row per configured or retained MCP server.
   */
  async mcpServers(signal?: AbortSignal): Promise<readonly McpServerView[]> {
    const first = await this.streamOnce<unknown>('mcpManager/watch', {}, signal)
    if (!Array.isArray(first)) throw new Error('Host 返回了无效的 MCP 服务列表')
    return first.filter(isRecord).map(item => ({
      name: typeof item.name === 'string' ? item.name : '',
      configured: item.configured === true,
      status: isRecord(item.status) ? item.status : {},
    })).filter(item => item.name !== '')
  }

  /**
   * @param name - configured MCP server key.
   * @returns the Host acknowledgement after it schedules a fresh connection.
   */
  mcpRestart(name: string): Promise<void> {
    return this.rpc('mcpManager/restart', { name })
  }

  /** @returns the staged connection probe for one MCP server. */
  mcpProbe(name: string): Promise<McpProbeValue> {
    return this.rpc('mcpManager/probe', { name })
  }

  /** @returns every Settings namespace with redacted values and revisions. */
  settingsDescribe(): Promise<SettingsDescribeValue> {
    return this.rpc('settings/describe', {})
  }

  /**
   * Flip one MCP server's Volatile `enabled` flag, preserving its profile revision.
   * The manager's watch stream publishes the resulting status change.
   * @param name - configured MCP server key.
   * @param enabled - whether the server should run.
   */
  async setMcpEnabled(name: string, enabled: boolean): Promise<void> {
    const { namespaces, writable } = await this.settingsDescribe()
    if (!writable) throw new Error('当前 Host 配置只读，无法启用或停用 MCP 服务')
    const namespace: SettingsNamespaceView | undefined = namespaces.find(item =>
      item.ns === MCP_NAMESPACE || item.ns.includes(MCP_SETTINGS_MARK))
    if (namespace === undefined) throw new Error('Host 未挂载 MCP 配置命名空间')
    await this.rpc('settings/mutate', {
      ns: namespace.ns,
      ops: [{ op: 'set', path: ['servers', name, 'enabled'], value: enabled }],
      expectedRevision: namespace.revision,
    })
  }

  /**
   * @param query - free-text Session search.
   * @returns matching Sessions with short snippets.
   */
  searchSessions(query: string): Promise<SessionSearchValue> {
    return this.rpc('session/search', { request: { query } })
  }

  /**
   * Find the most recent `exit_plan_mode` tool call in the durable journal.
   * @param sessionId - Session whose history is paged backwards.
   * @param pages - maximum number of history pages to inspect.
   * @returns the submitted Markdown plan, or undefined when none was logged.
   */
  async planDocument(sessionId: string, pages = 6): Promise<PlanDocument | undefined> {
    const address = { kind: 'session', sessionId } as SessionAddress
    let page = await this.rpc<SessionEventsPage>('session/events', {
      request: { address, maxMessages: 30 },
    })
    const throughSeq = page.cursor
    for (let depth = 0; depth < pages; depth += 1) {
      for (let index = page.records.length - 1; index >= 0; index -= 1) {
        const plan = submittedPlan(page.records[index]?.event)
        if (plan !== undefined) return plan
      }
      const beforeSeq = page.records[0]?.event.seq
      if (!page.hasMore || beforeSeq === undefined || !Number.isFinite(throughSeq)) return undefined
      page = await this.rpc<SessionEventsPage>('session/events', {
        request: { address, throughSeq, beforeSeq, maxMessages: 30 },
      })
    }
    return undefined
  }

  /**
   * Read the protected workspace file route used by the Desktop file tree.
   * @param path - relative workspace path, or empty for its root.
   * @param mode - directory listing or UTF-8 text preview.
   * @returns decoded JSON from the Host.
   */
  async workspaceFiles(path: string, mode: 'list' | 'preview'): Promise<DirectoryListing | FilePreview> {
    const query = new URLSearchParams({ mode, path })
    const response = await fetch(`${this.base}/api/daemon.files?${query}`, {
      headers: this.headers,
      redirect: 'error',
    })
    if (!response.ok) throw new RemoteFailure(String(response.status), `文件读取失败（HTTP ${response.status}）`)
    return response.json() as Promise<DirectoryListing | FilePreview>
  }

  /**
   * Open a Host Remote stream over the Gateway mux and settle on its first item.
   * @param endpoint - exact stream endpoint name.
   * @param args - named arguments for the stream.
   * @param signal - cancellation of the terminal application.
   * @returns the first streamed value.
   */
  private streamOnce<T>(endpoint: string, args: object, signal?: AbortSignal): Promise<T> {
    const streamId = this.platform.id()
    const socket = this.platform.socket(`${this.base.replace(/^http/u, 'ws')}/api/remote.mux`, this.headers)
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error, value?: T): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
        socket.close()
        if (error !== undefined) reject(error)
        else resolve(value as T)
      }
      const abort = (): void => { finish(new Error('已取消')) }
      const timeout = setTimeout(() => { finish(new Error('Host 数据流超时')) }, 10_000)
      signal?.addEventListener('abort', abort, { once: true })
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
      })
      socket.addEventListener('close', () => { finish(new Error('DSH WebSocket disconnected')) })
      socket.addEventListener('error', () => { finish(new Error('DSH WebSocket failed')) })
      socket.addEventListener('message', (event) => {
        try {
          if (typeof event.data !== 'string') throw new Error('Expected a DSH WebSocket text frame')
          const message: unknown = JSON.parse(event.data)
          if (!isRecord(message)) throw new Error('Invalid DSH WebSocket frame')
          if (message.type === 'error') throw failure(message.error)
          if (message.type === 'end' || message.streamId !== streamId) return
          if (message.type !== 'item' || message.value === undefined) return
          finish(undefined, message.value as T)
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
  }

  /**
   * @param sessionId - Session to follow without starting a model turn.
   * @param after - last applied durable sequence, or undefined for a fresh window.
   * @param watch - callbacks for the opening cut, journal, and approvals.
   * @param signal - aborts this generation and its in-flight history repair.
   * @returns when aborted, or rejects when a new generation is required.
   */
  follow(sessionId: string, after: number | undefined, watch: RemoteWatch, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    if (this.interactions !== undefined) return Promise.reject(new Error('This client already has a Session follow connection'))
    const address = { kind: 'session', sessionId } as SessionAddress
    const sessionStream = this.platform.id()
    const eventStream = this.platform.id()
    const pending = new Map<string, RemoteApproval>()
    const socket = this.platform.socket(`${this.base.replace(/^http/u, 'ws')}/api/remote.mux`, this.headers)
    const lifetime = new AbortController()
    let cursor = after
    let revision: number | undefined
    return new Promise<void>((resolve, reject) => {
      let closed = false
      let queue = Promise.resolve()
      const timeout = setTimeout(() => { finish(new Error('DSH Session opening timed out')) }, 15_000)
      const publishApprovals = (): void => { watch.approvals([...pending.values()]) }
      const interactions: NonNullable<RemoteClient['interactions']> = {
        answered: (id) => { if (pending.delete(id)) publishApprovals() },
      }
      this.interactions = interactions
      const finish = (error?: Error): void => {
        if (closed) return
        closed = true
        lifetime.abort()
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        this.interactions = undefined
        socket.close()
        pending.clear()
        publishApprovals()
        if (error === undefined) resolve()
        else reject(error)
      }
      const abort = (): void => { finish() }
      signal.addEventListener('abort', abort, { once: true })
      const open = (streamId: string, endpoint: string, args: object): void => {
        socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
      }
      socket.addEventListener('open', () => {
        open(eventStream, '$events', {})
        open(sessionStream, 'session/follow', { request: { address, assistantStream: true, maxMessages: 30 } })
      })
      socket.addEventListener('close', () => { finish(new Error('DSH WebSocket disconnected')) })
      socket.addEventListener('error', () => { finish(new Error('DSH WebSocket failed')) })
      socket.addEventListener('message', (event) => {
        queue = queue.then(async () => {
          if (closed) return
          if (typeof event.data !== 'string') throw new Error('Expected a DSH WebSocket text frame')
          const message: unknown = JSON.parse(event.data)
          if (!isRecord(message)) throw new Error('Invalid DSH WebSocket frame')
          if (message.type === 'error') throw failure(message.error)
          if (message.type === 'end') throw new Error('DSH ended the live stream')
          if (message.type !== 'item' || !isRecord(message.value)) throw new Error('Invalid DSH stream item')
          const value = message.value
          if (message.streamId === eventStream) {
            if (value.type === 'ready' && typeof value.clientId === 'string') interactions.id = value.clientId
            if (value.type === 'cancel' && typeof value.eventId === 'string' && pending.delete(value.eventId)) publishApprovals()
            if (value.type === 'waterfall' && typeof value.eventId === 'string') {
              if (value.event === 'approval/request' && typeof value.agentId === 'string' && isRecord(value.request)) {
                pending.set(value.eventId, {
                  id: value.eventId,
                  sessionId: value.agentId,
                  tool: String(value.request.toolName ?? ''),
                  reason: String(value.request.reason ?? ''),
                })
                publishApprovals()
              } else {
                await this.settleInteraction(value.eventId, { kind: 'next' })
              }
            }
            return
          }
          if (message.streamId !== sessionStream) throw new Error('Unknown DSH stream id')
          const frame = value as SessionFollowFrame
          switch (frame.type) {
            case 'snapshot': {
              if (revision !== undefined || frame.assistantStream === undefined) throw new Error('Invalid Session opening')
              const events = await this.repair(address, frame, cursor, lifetime.signal)
              if (closed) return
              cursor = frame.cursor
              revision = frame.assistantStream.revision
              clearTimeout(timeout)
              watch.opening({
                cursor, events, hasMore: frame.hasMore, projections: frame.projections, assistantStream: frame.assistantStream,
              })
              break
            }
            case 'event':
              if (revision === undefined || cursor === undefined || frame.event.seq !== cursor + 1) {
                throw new Error('Gap in the durable DSH Session journal')
              }
              cursor = frame.event.seq
              watch.event(frame.event)
              break
            case 'assistant-stream':
              if (revision === undefined || frame.frame.revision !== revision + 1) {
                throw new Error('Gap in the live DSH Assistant stream')
              }
              revision = frame.frame.revision
              watch.assistant(frame.frame)
              break
            default:
              throw new Error('Unknown DSH Session frame')
          }
        }).catch((error: unknown) => { finish(error instanceof Error ? error : new Error(String(error))) })
      })
    })
  }

  private async repair(
    address: SessionAddress,
    opening: Extract<SessionFollowFrame, { type: 'snapshot' }>,
    after: number | undefined,
    signal: AbortSignal,
  ): Promise<readonly SessionEvent[]> {
    const events = opening.records.map(record => record.event)
    if (after === undefined) return events
    if (after > opening.cursor) throw new RemoteFailure('session/cursor-regressed', 'The Host journal is behind this client')
    let before = events[0]?.seq ?? opening.cursor + 1
    const pages: SessionEvent[][] = [events]
    while (before > after + 1) {
      const page = await this.rpc<SessionEventsPage>('session/events', {
        request: { address, throughSeq: opening.cursor, beforeSeq: before, maxMessages: 30 },
      }, signal)
      const records = page.records.map(record => record.event)
      const first = records[0]?.seq
      if (first === undefined || first >= before || records.at(-1)?.seq !== before - 1) {
        throw new RemoteFailure('session/cursor-gap', 'The Host could not provide a contiguous journal suffix')
      }
      pages.push(records)
      before = first
    }
    return pages.reverse().flat().filter(event => event.seq > after)
  }
}

/** Rebuild a submitted plan from an untrusted logged tool-call argument. */
function submittedPlan(event: SessionEvent | undefined): PlanDocument | undefined {
  if (event === undefined || !['tool/call', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch'].includes(event.type)) return undefined
  const data = event.data
  if (!isRecord(data) || data.name !== 'exit_plan_mode') return undefined
  const callId = event.type === 'tool/call' ? data.callId : data.subCallId
  if (typeof callId !== 'string' || callId === '') return undefined
  let args: unknown = data.arguments
  if (event.type === 'tool/call') {
    if (typeof args !== 'string') return undefined
    try { args = JSON.parse(args) as unknown }
    catch { return undefined }
  }
  if (!isRecord(args) || typeof args.plan !== 'string') return undefined
  const markdown = args.plan
  const title = /^#\s+(\S[^\r\n]*)/u.exec(markdown.trim())?.[1]
  return title === undefined ? undefined : { callId, markdown, title }
}

function failure(error: unknown): RemoteFailure {
  return new RemoteFailure(
    isRecord(error) && typeof error.code === 'string' ? error.code : 'gateway/invalid-response',
    isRecord(error) && typeof error.message === 'string' ? error.message : 'DSH rejected the request',
  )
}
