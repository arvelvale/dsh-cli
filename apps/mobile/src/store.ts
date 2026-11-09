/** Native Session view state and cursor recovery. */

import { create } from 'zustand'
import type { RemoteApproval, RemoteClient } from '../../cli/src/remote-client.ts'
import { RemoteFailure } from '../../cli/src/remote-client.ts'
import type { SessionEvent, SessionSummary } from '../../cli/src/remote-contract.ts'
import { appendAssistantRow, compactRows, displayRows, type DisplayRow } from '../../cli/src/remote-presentation.ts'

interface Transcript {
  readonly cursor?: number
  readonly before?: number
  readonly hasMore: boolean
  readonly rows: readonly DisplayRow[]
}

/** A single displayed transcript and the independently reconnectable Assistant attempt. */
interface State {
  readonly status: 'connecting' | 'connected' | 'offline'
  readonly sessions: readonly SessionSummary[]
  readonly transcript: Transcript
  readonly active?: { readonly id: string; readonly rows: readonly DisplayRow[] }
  readonly approvals: readonly RemoteApproval[]
  readonly notice: string
}

const empty: Transcript = { rows: [], hasMore: false }

/** Read native Session state through narrow Zustand selectors. */
export const useRemoteState = create<State>(() => ({
  status: 'offline', sessions: [], transcript: empty, approvals: [], notice: '',
}))

/**
 * @param client - current configured Host.
 * @returns the latest Session rows after publishing them to the list.
 */
export async function refreshSessions(client: RemoteClient): Promise<readonly SessionSummary[]> {
  const { items } = await client.list()
  useRemoteState.setState({ sessions: items })
  return items
}

/**
 * @param client - current configured Host.
 * @param sessionId - selected Session.
 * @param signal - ends this Session selection before a different selection can publish.
 * @returns after cancellation or a permanent Host failure.
 */
export async function watchSession(client: RemoteClient, sessionId: string, signal: AbortSignal): Promise<void> {
  useRemoteState.setState({ transcript: empty, active: undefined, approvals: [], notice: '' })
  let failures = 0
  while (!signal.aborted) {
    useRemoteState.setState({ status: 'connecting' })
    try {
      await client.follow(sessionId, useRemoteState.getState().transcript.cursor, {
        opening: (value) => {
          const attempt = value.assistantStream?.activeAttempt
          failures = 0
          useRemoteState.setState(state => ({
            status: 'connected',
            notice: '',
            transcript: {
              cursor: value.cursor,
              before: state.transcript.before ?? value.events[0]?.seq,
              hasMore: state.transcript.cursor === undefined ? value.hasMore : state.transcript.hasMore,
              rows: [...state.transcript.rows, ...value.events.flatMap(displayRows)],
            },
            active: attempt === undefined ? undefined : { id: attempt.attemptId, rows: compactRows(attempt.stream, attempt.attemptId) },
          }))
        },
        event: (event) => {
          useRemoteState.setState(state => ({
            transcript: {
              ...state.transcript,
              cursor: event.seq,
              before: state.transcript.before ?? event.seq,
              rows: [...state.transcript.rows, ...displayRows(event)],
            },
            ...(event.type === 'assistant/message' || event.type === 'assistant/attempt' ? { active: undefined } : {}),
          }))
        },
        assistant: (frame) => {
          if (frame.type === 'start') useRemoteState.setState({ active: { id: frame.attemptId, rows: [] } })
          if (frame.type === 'end') useRemoteState.setState({ active: undefined })
          if (frame.type === 'chunk') useRemoteState.setState((state) => {
            const active = state.active
            if (active?.id !== frame.attemptId) return state
            const rows = appendAssistantRow(active.rows, frame.chunk, frame.attemptId)
            return rows === active.rows ? state : { active: { id: active.id, rows } }
          })
        },
        approvals: (approvals) => { useRemoteState.setState({ approvals }) },
      }, signal)
    } catch (error) {
      if (signal.aborted) return
      useRemoteState.setState({
        status: 'offline',
        notice: error instanceof Error ? error.message : String(error),
      })
      if (error instanceof RemoteFailure && (error.code === 'session/not-found' || error.code.startsWith('session/cursor-'))) return
      await reconnectDelay(Math.min(500 * 2 ** failures, 10_000), signal)
      failures += 1
    }
  }
}

/**
 * @param client - current configured Host.
 * @param sessionId - selected Session.
 * @param signal - prevents a late page from replacing a newer Session.
 */
export async function prependHistory(client: RemoteClient, sessionId: string, signal: AbortSignal): Promise<void> {
  const transcript = useRemoteState.getState().transcript
  if (!transcript.hasMore || transcript.before === undefined) return
  const page = await client.history(sessionId, transcript.before)
  if (signal.aborted) return
  const events: SessionEvent[] = page.records.map(record => record.event)
  useRemoteState.setState(state => ({
    transcript: {
      ...state.transcript,
      rows: [...events.flatMap(displayRows), ...state.transcript.rows],
      before: events[0]?.seq ?? state.transcript.before,
      hasMore: page.hasMore,
    },
  }))
}

function reconnectDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms * (0.5 + Math.random() * 0.5))
    signal.addEventListener('abort', done, { once: true })
  })
}
