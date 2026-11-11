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

// The types below are declared locally instead of importing package-private faces:
// the CLI only receives JSON over the Gateway wire and validates it at runtime.

/** One user-invocable Skill from the Host's Session-addressed catalog. */
export interface SkillEntry {
  readonly name: string
  readonly description: string
  readonly modelInvocable: boolean
  readonly path?: string
  readonly whenToUse?: string
}

/** Result of `skills/list`. */
export interface SkillListValue {
  readonly skills: readonly SkillEntry[]
}

/** Runtime state of one managed MCP server, kept loose because the Host extends it. */
export type McpStatus = Readonly<Record<string, unknown>> & { readonly state?: string }

/** One row of `mcpManager/watch`. */
export interface McpServerView {
  readonly name: string
  readonly configured: boolean
  readonly status: McpStatus
}

/** Result of `mcpManager/probe`. */
export interface McpProbeValue {
  readonly ok: boolean
  readonly stage?: string
  readonly toolNames?: readonly string[]
  readonly truncated?: boolean
  readonly durationMs?: number
  readonly error?: string
  readonly cleanupError?: string
  readonly closeConfirmed?: boolean
}

/** One Settings namespace as described by `settings/describe`. */
export interface SettingsNamespaceView {
  readonly ns: string
  readonly revision: number
  readonly value: unknown
  readonly applies?: unknown
  readonly autoGenerate?: boolean
}

/** Result of `settings/describe`. */
export interface SettingsDescribeValue {
  readonly writable: boolean
  readonly hasDocument: boolean
  readonly namespaces: readonly SettingsNamespaceView[]
}

/** One hit from `session/search`. */
export interface SessionSearchItem {
  readonly sessionId: string
  readonly snippet: string
}

/** Result of `session/search`. */
export interface SessionSearchValue {
  readonly items: readonly SessionSearchItem[]
  readonly hasMore: boolean
}

/** Plan-mode projection (`projections.values.plan`). */
export interface PlanProjection {
  readonly active: boolean
  readonly pending: boolean
}

/** One item of the TodoWrite projection (`projections.values.todos`). */
export interface TodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed' | string
}

/** The most recent plan submitted through `exit_plan_mode`. */
export interface PlanDocument {
  readonly callId: string
  readonly title: string
  readonly markdown: string
}

/** One entry of `daemon.files?mode=list`. */
export interface DirectoryEntry {
  readonly name: string
  readonly kind: 'directory' | 'file'
}

/** Result of `daemon.files?mode=list`. */
export interface DirectoryListing {
  readonly root: string
  readonly entries: readonly DirectoryEntry[]
}

/** Result of `daemon.files?mode=preview`. */
export interface FilePreview {
  readonly text: string
  readonly truncated: boolean
}

/** Session-scoped plan state assembled from projections and the durable journal. */
export interface PlanSnapshot {
  readonly mode: PlanProjection
  readonly todos: readonly TodoItem[]
  readonly document?: PlanDocument
}
