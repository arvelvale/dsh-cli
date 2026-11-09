/** Native client types for the same journal and message vocabulary used by Desktop. */

import type {
  ModelCatalog,
  ModelSelection,
  PromptContentPart,
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionEventsPage,
  SessionListValue,
  SessionProjectionBaseline,
  SessionSummary,
  SessionWireEvent,
} from '@deepseek-ai/dsh-api-session-controller/types'

/** Durable Session entries after Host-side wire projection. */
export type SessionEvent = SessionWireEvent

/** Canonical model-visible message stored by DSH. */
export type { Message } from '@deepseek-ai/dsh-llm'

/** Desktop-compatible follow input, opening baseline, and live increments. */
export type {
  ModelCatalog,
  ModelSelection,
  PromptContentPart,
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionEventsPage,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionListValue,
  SessionSummary,
}

/** An opening cut through the durable journal with an independent live baseline. */
export interface SessionOpening {
  readonly cursor: number
  readonly events: readonly SessionEvent[]
  readonly hasMore: boolean
  readonly projections: SessionProjectionBaseline
  readonly assistantStream?: SessionAssistantStreamBaseline
}
