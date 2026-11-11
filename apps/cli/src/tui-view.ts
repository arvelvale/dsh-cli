/** Glue between terminal events, the transcript, the editor and modal overlays. */

import { renderBanner, renderBlock, renderHelp, type Block, type BlockOptions } from './tui-blocks.ts'
import type { Editor, EditorStatus } from './tui-editor.ts'
import type { Overlay } from './tui-overlay.ts'
import type { KeyEvent, TerminalScreen } from './tui-screen.ts'
import type { Palette, Theme } from './tui-theme.ts'
import { Theme as ThemeClass } from './tui-theme.ts'

interface Committed {
  readonly block?: Block
  readonly lines: readonly string[]
}

/** Renders the whole interactive client and owns its redraw cycles. */
export class TranscriptView {
  private readonly committed: Committed[] = []
  private live: readonly Block[] = []
  private overlay: Overlay | undefined
  private expanded = false
  private streaming = false
  private theme: Theme
  private spinnerTimer: NodeJS.Timeout | undefined
  private readonly removeKey: () => void
  private readonly removeResize: () => void

  /**
   * @param screen - raw terminal driver.
   * @param editor - prompt editor.
   * @param theme - initial palette.
   * @param status - supplies the two status rows.
   */
  constructor(
    readonly screen: TerminalScreen,
    readonly editor: Editor,
    theme: Theme,
    readonly status: () => EditorStatus,
  ) {
    this.theme = theme
    this.removeKey = screen.onKey(this.onKey)
    this.removeResize = screen.onResize(() => { this.refresh() })
  }

  /** Enter raw mode and draw the first frame. */
  start(): void {
    this.screen.start()
    this.refresh()
  }

  /** Restore the terminal and release listeners. */
  stop(): void {
    if (this.spinnerTimer !== undefined) clearInterval(this.spinnerTimer)
    this.removeKey()
    this.removeResize()
    this.screen.stop()
  }

  /** @returns whether thinking and tool output are fully expanded. */
  get isExpanded(): boolean {
    return this.expanded
  }

  /** @returns the palette currently in use. */
  get currentTheme(): Theme {
    return this.theme
  }

  /** Switch palette without restarting the client. */
  setPalette(palette: Palette, enabled = true): void {
    this.theme = new ThemeClass(palette, enabled)
    this.replay()
  }

  /** Show the startup banner. */
  banner(host: string): void {
    this.commitRaw(renderBanner(this.screen.columns, this.theme, host))
  }

  /** Show grouped command help. */
  help(): void {
    this.commitRaw(renderHelp(this.screen.columns, this.theme, this.status().pasteShortcut))
  }

  /** Commit pre-rendered lines to the native scrollback. */
  commitRaw(lines: readonly string[]): void {
    if (lines.length === 0) return
    this.committed.push({ lines })
    if (this.committed.length > 400) this.committed.shift()
    this.screen.commit(lines)
  }

  /** Commit one final transcript block. */
  commit(block: Block): void {
    const lines = renderBlock(block, this.screen.columns - 1, this.theme, this.options())
    this.committed.push({ block, lines })
    if (this.committed.length > 400) this.committed.shift()
    this.screen.commit(lines)
    this.refresh()
  }

  /** Show a short system notice. */
  system(text: string, kind: 'system' | 'error' = 'system'): void {
    this.commit({ id: `system:${String(Date.now())}`, kind, title: kind === 'error' ? '错误' : '', text })
  }

  /** Replace the in-progress turn's blocks. */
  setLive(blocks: readonly Block[]): void {
    this.live = blocks
    this.refresh()
  }

  /** Remove the in-progress turn from the dock. */
  clearLive(): void {
    this.live = []
    this.refresh()
  }

  /** Update streaming state and animate spinners while a turn is active. */
  setStreaming(value: boolean): void {
    this.streaming = value
    this.editor.setStreaming(value)
    if (value && this.spinnerTimer === undefined) {
      this.spinnerTimer = setInterval(() => { this.refresh() }, 120)
    } else if (!value && this.spinnerTimer !== undefined) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = undefined
    }
    this.refresh()
  }

  /** Toggle thinking/tool expansion and replay the visible transcript. */
  toggleExpanded(): void {
    this.expanded = !this.expanded
    this.replay()
  }

  /** Drop older transcript entries (/compact). */
  compact(): void {
    const keep = this.committed.slice(-12)
    this.committed.length = 0
    this.committed.push(...keep)
    this.replay()
  }

  /** Show a modal overlay until its result settles. */
  async showOverlay<T>(overlay: Overlay, result: Promise<T>): Promise<T> {
    overlay.bindRefresh?.(() => { this.refresh() })
    this.overlay = overlay
    this.refresh()
    try {
      return await result
    } finally {
      this.overlay = undefined
      this.refresh()
    }
  }

  private options(): BlockOptions {
    return { expanded: this.expanded, streaming: this.streaming, now: Date.now() }
  }

  private replay(): void {
    this.screen.clearAll()
    const lines = this.committed.flatMap(entry => entry.block === undefined ? entry.lines
      : renderBlock(entry.block, this.screen.columns - 1, this.theme, this.options()))
    this.screen.commit(lines)
    this.refresh()
  }

  /** Redraw dock, live blocks, completion menu and overlays. */
  refresh(): void {
    const width = this.screen.columns
    const current = this.status()
    const frame = this.editor.render(width, this.theme, current, current.attachments)
    const modal = this.overlay?.render(width, this.theme, this.screen.rows) ?? []
    this.screen.setOverlay(modal)
    this.screen.setMenu(this.overlay === undefined ? frame.overlay : [])
    // A modal owns the free space above the dock; live blocks return after it closes.
    this.screen.setActive(this.overlay === undefined
      ? this.live.flatMap(block => renderBlock(block, width - 1, this.theme, this.options())) : [])
    this.screen.setDock(frame.dock, frame.cursor)
  }

  private readonly onKey = (event: KeyEvent): void => {
    if (this.overlay !== undefined) {
      this.overlay.handleKey(event)
      this.refresh()
      return
    }
    this.editor.handleKey(event)
    this.refresh()
  }
}
