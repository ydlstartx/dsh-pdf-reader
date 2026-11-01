/**
 * dsh-pdf-reader browser half: register the PDF reader as a page tab type in
 * the Web GUI's right Sidebar (`ctx.sidebarRightTabs` + the keyed
 * `sidebar.right.pane.tab` seat), a frame-wide draggable floating entry
 * (`shell.overlay`) that opens that tab, and the outline/search surface that
 * shadows the left column's workspace browser while a reader is open.
 * Documents arrive exclusively through the user's own file picker. Raw PDF
 * bytes remain browser-local; a bounded derived-text index is synchronized to
 * session-local host tools. Every import of another client package is
 * type-only: behavior crosses packages through Cordis services, UI through
 * slots.
 * @module dsh-pdf-reader/client
 */

import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
// Declaration merges for the services and standard props this plugin's apply
// world reads. Every one of them is type-only and erased at build time.
import type { AgentContext, ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { InjectFace, PropsRuntime, SlotComponent } from '@deepseek-ai/dsh-client-ui-slots'
import { attachComposerSelection } from './composer-selection.ts'
import type { ComposerImageLimits, ComposerSelectionHandle } from './composer-selection.ts'
import {
  appendComposerPdfTextReference,
  sendComposerPdfDocumentsAiRequest,
  sendComposerPdfAnnotationAiRequest,
  sendComposerPdfAiRequest,
} from './composer-pdf-reference.ts'
import type {
  PdfAiRequest,
  PdfAnnotationAiRequest,
  PdfDocumentsAiRequest,
  PdfTextReference,
} from './composer-pdf-reference.ts'
import { sendComposerPdfImageAiRequest } from './composer-pdf-image.ts'
import type { PdfImageAiRequest } from './composer-pdf-image.ts'
import { sendComposerPdfMixedAiRequest } from './composer-pdf-mixed.ts'
import type { PdfMixedAiRequest } from './composer-pdf-mixed.ts'
import {
  parsePdfCitationBatchId,
  parsePdfCitationLabelAt,
  parsePdfCitationUrl,
} from './pdf-citations.ts'
import type { PdfCitationReference } from './pdf-citations.ts'
import { PdfPanel } from './PdfPanel.tsx'
import { PdfToggle } from './PdfToggle.tsx'
import {
  PdfOutlineFooter,
  PdfOutlineSidebar,
} from './PdfOutlineSidebar.tsx'
import type {
  PdfOutlineSnapshot,
  PdfOutlineSource,
  PdfSidebarMode,
} from './PdfOutlineSidebar.tsx'
import type { PdfOutlineController } from './pdf-outline.ts'
import { resolvePdfToggleResult } from './workspace-gate.ts'

export const name = 'dsh-pdf-reader-client'

/** Services required before the browser plugin loads. */
export const inject = ['slots', 'layout', 'sessions', 'conversation', 'sidebarRight', 'sidebarRightTabs']

/**
 * Tab-type implementation id (the key the body registers under) and the page
 * kind the floating button opens. One reader page per Session pane.
 */
const PDF_TAB_ID = 'dsh-pdf-reader'
const PDF_TAB_KIND = 'dsh-pdf-reader'

/** Callbacks one reader page needs, bound to the page's Session at inject time. */
interface PdfTabInjected {
  attachSelectionFor: (
    sessionId: SessionId,
    file: File,
    limits: ComposerImageLimits | undefined,
  ) => ComposerSelectionHandle
  appendTextReferenceFor: (sessionId: SessionId, reference: PdfTextReference) => void
  sendDocumentsQuestionFor: (sessionId: SessionId, request: PdfDocumentsAiRequest) => Promise<void>
  sendTextAiRequestFor: (sessionId: SessionId, request: PdfAiRequest) => Promise<void>
  sendAnnotationAiRequestFor: (sessionId: SessionId, request: PdfAnnotationAiRequest) => Promise<void>
  sendImageAiRequestFor: (sessionId: SessionId, images: readonly File[], request: PdfImageAiRequest) => Promise<void>
  sendMixedAiRequestFor: (sessionId: SessionId, images: readonly File[], request: PdfMixedAiRequest) => Promise<void>
  onOpenRequest: (listener: () => void) => () => void
  onCitationRequest: (listener: (reference: PdfCitationReference) => boolean) => () => void
  onOutlineChange: (sessionId: SessionId, controller: PdfOutlineController | undefined) => void
  onSearchToggle: () => boolean
  /** Give the reader the width this page's own column holds, when it asks. */
  reclaimHostColumn: () => void
}

/** The floating entry's injected face: the Session on screen plus the open verb. */
interface PdfToggleInjected {
  /** The Session the right Sidebar shows, or absent while none is on screen. */
  readonly hooks: { readonly mounted: ObservableSnapshot<SessionId | undefined> }
  openReader: () => void
}

export function apply(ctx: Context): void {
  // The host half of this package compiles in the same program, so the Host
  // Session store's declaration merge can win over the Client one. The outward
  // Client contract is what the browser actually holds; keep that cast here,
  // in the plugin's single boundary, rather than sprinkling `as` everywhere.
  const sessions = ctx.sessions as unknown as ISessions

  // Root PDF-navigation state has one owner: the currently rendered session
  // panel. One active mode (outline or search) temporarily shadows the
  // workspace browser; closing it reveals Harness's original content.
  let outlineOwner: SessionId | undefined
  let outlineSnapshot: PdfOutlineSnapshot = { controller: undefined, active: undefined }
  const outlineListeners = new Set<() => void>()
  const outlineSource: PdfOutlineSource = {
    getSnapshot: () => outlineSnapshot,
    subscribe: (listener) => {
      outlineListeners.add(listener)
      return () => { outlineListeners.delete(listener) }
    },
  }
  const emitOutline = (next: PdfOutlineSnapshot): void => {
    outlineSnapshot = next
    for (const listener of outlineListeners) listener()
  }

  let sidebarDeclared = false
  let sidebarWide = false
  let sidebarOpenedForPdf = false
  let disposeOutlineSeat: (() => void) | undefined
  const syncOutlineSeat = (): void => {
    const shouldRender = sidebarDeclared && outlineSnapshot.active !== undefined && outlineSnapshot.controller !== undefined
    if (shouldRender && disposeOutlineSeat === undefined) {
      disposeOutlineSeat = ctx.slots.register({
        name: 'sidebar.workspaces',
        priority: -1,
      }, (props: PropsRuntime<'sidebar.workspaces'>) => createElement(PdfOutlineSidebar, {
        ...props,
        source: outlineSource,
        onClose: closeOutline,
      }))
    } else if (!shouldRender && disposeOutlineSeat !== undefined) {
      const dispose = disposeOutlineSeat
      disposeOutlineSeat = undefined
      dispose()
    }
  }
  const clearSearchHighlight = (): void => {
    if (outlineSnapshot.active === 'search') {
      outlineSnapshot.controller?.search.clearHighlight()
    }
  }
  const closeOutline = (): void => {
    if (outlineSnapshot.active === undefined) return
    const collapse = sidebarOpenedForPdf && sidebarWide
    sidebarOpenedForPdf = false
    clearSearchHighlight()
    emitOutline({ ...outlineSnapshot, active: undefined })
    syncOutlineSeat()
    if (collapse) ctx.layout.toggleSidebar()
  }
  const activateOutline = (mode: PdfSidebarMode, wide: boolean): void => {
    sidebarWide = wide
    if (outlineSnapshot.controller === undefined) return
    if (outlineSnapshot.active === mode) return
    const opening = outlineSnapshot.active === undefined
    if (opening) sidebarOpenedForPdf = !wide
    clearSearchHighlight()
    emitOutline({ ...outlineSnapshot, active: mode })
    syncOutlineSeat()
    if (opening && !wide) {
      ctx.layout.toggleSidebar()
      // Layout state changes synchronously; the footer's wide prop catches up
      // on the next render. Keep immediate-close restoration correct too.
      sidebarWide = true
    }
  }
  const toggleOutline = (mode: PdfSidebarMode, wide: boolean): void => {
    if (outlineSnapshot.active === mode) {
      closeOutline()
      return
    }
    activateOutline(mode, wide)
  }
  const updateSidebarWide = (wide: boolean): void => {
    sidebarWide = wide
    // Harness can collapse its sidebar without activating this plugin's own
    // close button. That external transition must still release the PDF mode,
    // or the hidden search remains logically selected and cannot reopen.
    if (wide || outlineSnapshot.active === undefined) return
    sidebarOpenedForPdf = false
    clearSearchHighlight()
    emitOutline({ ...outlineSnapshot, active: undefined })
    syncOutlineSeat()
    requestAnimationFrame(() => {
      const reader = [...document.querySelectorAll<HTMLElement>('[data-pdf-scroll]')]
        .find(candidate => candidate.getClientRects().length > 0)
      reader?.focus({ preventScroll: true })
    })
  }
  const publishOutline = (sessionId: SessionId, controller: PdfOutlineController | undefined): void => {
    if (controller === undefined) {
      if (outlineOwner !== sessionId) return
      closeOutline()
      outlineOwner = undefined
      emitOutline({ controller: undefined, active: undefined })
      return
    }
    outlineOwner = sessionId
    emitOutline({ controller, active: outlineSnapshot.active })
    syncOutlineSeat()
  }

  ctx.effect(() => ctx.slots.inject('sidebar.workspaces', () => {
    sidebarDeclared = true
    syncOutlineSeat()
    return () => {
      sidebarDeclared = false
      const dispose = disposeOutlineSeat
      disposeOutlineSeat = undefined
      dispose?.()
    }
  }), 'dsh-pdf-reader.outline-seat')

  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => {
    // The host lays footer registrations out horizontally. Keep the two PDF
    // actions in one additive cell so their intended vertical order remains
    // stable: search above outline, without taking over any host-owned action.
    return ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'dsh-pdf-reader-outline',
      order: 100,
    }, (props: PropsRuntime<'sidebar.footer.action'>) => createElement(PdfOutlineFooter, {
      ...props,
      source: outlineSource,
      onToggle: toggleOutline,
      onWide: updateSidebarWide,
    }))
  }), 'dsh-pdf-reader.outline-footer')

  // The floating PDF button and the reader page talk through this tiny bus:
  // the button fires open requests, and the session-scoped page toggles its
  // loaded reader or invokes its hidden file input when empty.
  const openListeners = new Set<() => void>()
  // The first click can arrive before the page exists (the tab is created by
  // that click); the page claims this flag as it subscribes.
  let pendingOpenRequest = false
  const dispatchOpen = (): void => {
    for (const listener of openListeners) listener()
  }
  const onOpenRequest = (listener: () => void): (() => void) => {
    openListeners.add(listener)
    if (pendingOpenRequest) {
      pendingOpenRequest = false
      // Deliver the click that created this page to whichever listener is
      // live once this subscription's own render settles: the panel
      // re-subscribes as its reader state changes, so the listener that
      // claimed the flag may already be retired.
      queueMicrotask(dispatchOpen)
    }
    return () => { openListeners.delete(listener) }
  }
  const requestOpen = (): void => {
    if (openListeners.size === 0) {
      pendingOpenRequest = true
      return
    }
    dispatchOpen()
  }

  // Assistant Markdown safely renders the citation sentinel as HTTPS. Some
  // models keep only the visible `[图 N]` / `[文 N]` label, so the browser also
  // recovers its exact batch from the nearest preceding PDF user prompt.
  const citationListeners = new Set<(reference: PdfCitationReference) => boolean>()
  const onCitationRequest = (listener: (reference: PdfCitationReference) => boolean): (() => void) => {
    citationListeners.add(listener)
    return () => { citationListeners.delete(listener) }
  }
  ctx.effect(() => {
    type CaretDocument = Document & Partial<{
      caretPositionFromPoint: (x: number, y: number) => { offsetNode: Node; offset: number } | null
      caretRangeFromPoint: (x: number, y: number) => Range | null
    }>

    /** Turn index carried by a chat row; the transcript's own ordering key. */
    const chatTurnOf = (element: Element | null): number | undefined => {
      const raw = element?.getAttribute('data-chat-turn')
      if (raw === undefined || raw === null || raw === '') return undefined
      const value = Number(raw)
      return Number.isSafeInteger(value) ? value : undefined
    }

    /**
     * Recover the PDF citation batch of one assistant row.
     *
     * The transcript can fold a completed turn into a process group, so an
     * assistant row is not necessarily a sibling of its user prompt. Read the
     * row's turn instead and take the last user prompt at or before it; fall
     * back to document order for transcripts without turn markers.
     */
    const citationBatchFor = (assistant: Element): string | undefined => {
      const assistantTurn = chatTurnOf(assistant)
      const flow = assistant.closest('[data-chat-flow]')
      if (assistantTurn !== undefined && flow !== null) {
        let bestPrompt: Element | undefined
        let bestTurn = Number.NEGATIVE_INFINITY
        for (const prompt of flow.querySelectorAll('[data-chat-flow-kind="user"]')) {
          const turn = chatTurnOf(prompt)
          if (turn === undefined || turn > assistantTurn || turn < bestTurn) continue
          bestPrompt = prompt
          bestTurn = turn
        }
        if (bestPrompt !== undefined) return parsePdfCitationBatchId(bestPrompt.textContent ?? '')
      }
      let prompt = assistant.previousElementSibling
      while (prompt !== null && prompt.getAttribute('data-chat-flow-kind') !== 'user') {
        prompt = prompt.previousElementSibling
      }
      return prompt === null ? undefined : parsePdfCitationBatchId(prompt.textContent ?? '')
    }

    const plainCitationAt = (event: MouseEvent): PdfCitationReference | undefined => {
      const target = event.target
      if (!(target instanceof Element)) return undefined
      if (target.closest('a[href], button, input, textarea, code, pre, [contenteditable="true"]') !== null) {
        return undefined
      }
      const targetText = target.textContent ?? ''
      if (!targetText.includes('[图') && !targetText.includes('[文')) return undefined
      const assistant = target.closest('[data-chat-flow-kind="assistant-step"]')
      if (assistant === null) return undefined

      const batchId = citationBatchFor(assistant)
      if (batchId === undefined) return undefined

      const caretDocument = document as CaretDocument
      const position = caretDocument.caretPositionFromPoint?.(event.clientX, event.clientY)
      const fallback = position === undefined || position === null
        ? caretDocument.caretRangeFromPoint?.(event.clientX, event.clientY)
        : undefined
      const node = position?.offsetNode ?? fallback?.startContainer
      const offset = position?.offset ?? fallback?.startOffset
      if (node?.nodeType !== Node.TEXT_NODE || offset === undefined || !assistant.contains(node)) return undefined
      return parsePdfCitationLabelAt(node.textContent ?? '', offset, batchId)
    }

    const dispatchCitation = (reference: PdfCitationReference): boolean => {
      for (const listener of citationListeners) {
        if (listener(reference)) return true
      }
      return false
    }

    const handleCitationClick = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest<HTMLAnchorElement>('a[href]')
      const reference = anchor === null
        ? plainCitationAt(event)
        : parsePdfCitationUrl(anchor.href)
      if (reference === undefined) return
      if (!dispatchCitation(reference)) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }

    let hoverTarget: HTMLElement | undefined
    let hoverCursor = ''
    const clearCitationHover = (): void => {
      if (hoverTarget === undefined) return
      hoverTarget.style.cursor = hoverCursor
      hoverTarget.removeAttribute('data-pdf-citation-hover')
      hoverTarget = undefined
      hoverCursor = ''
    }
    const handleCitationHover = (event: MouseEvent): void => {
      const target = event.target
      const reference = plainCitationAt(event)
      if (reference === undefined || !(target instanceof HTMLElement) || citationListeners.size === 0) {
        clearCitationHover()
        return
      }
      if (hoverTarget === target) return
      clearCitationHover()
      hoverTarget = target
      hoverCursor = target.style.cursor
      target.style.cursor = 'pointer'
      target.setAttribute('data-pdf-citation-hover', 'true')
    }

    document.addEventListener('click', handleCitationClick, true)
    document.addEventListener('mousemove', handleCitationHover, true)
    return () => {
      clearCitationHover()
      document.removeEventListener('click', handleCitationClick, true)
      document.removeEventListener('mousemove', handleCitationHover, true)
    }
  }, 'dsh-pdf-reader.citation-links')

  /**
   * Resolve one Session's live browser scope. `scope()` borrows the already
   * retained generation, so a page rendered for that Session always has one
   * while it is on screen.
   */
  const sessionScopeOf = (sessionId: SessionId): AgentContext | undefined => sessions.scope(sessionId)

  /** The scope-addressed conversation face for one Session. */
  const conversationFor = (sessionId: SessionId): IConversation => {
    const scoped = sessionScopeOf(sessionId)
    if (scoped === undefined) throw new Error('当前会话不可用，请先在会话中打开阅读器')
    const conversation = scoped.get('conversation')
    if (conversation === undefined) throw new Error('当前会话的 AI 对话服务不可用')
    return conversation
  }

  /** Resolve the session scope, then hand the version-sensitive work to its sole boundary. */
  const attachSelectionFor = (
    sessionId: SessionId,
    file: File,
    limits: ComposerImageLimits | undefined,
  ): ComposerSelectionHandle => {
    const scoped = sessionScopeOf(sessionId)
    if (scoped === undefined) throw new Error('当前会话不可用，请先在会话中打开阅读器')
    return attachComposerSelection(conversationFor(sessionId), scoped, sessionId, file, limits)
  }

  /** Add source-labelled PDF text to the editable draft without sending it. */
  const appendTextReferenceFor = (sessionId: SessionId, reference: PdfTextReference): void => {
    const scoped = sessionScopeOf(sessionId)
    if (scoped === undefined) throw new Error('当前会话不可用，请先在会话中打开阅读器')
    appendComposerPdfTextReference(conversationFor(sessionId), scoped, reference)
  }

  /** Send one confirmed whole-document question without occupying the main draft. */
  const sendDocumentsQuestionFor = async (
    sessionId: SessionId,
    request: PdfDocumentsAiRequest,
  ): Promise<void> => {
    await sendComposerPdfDocumentsAiRequest(conversationFor(sessionId), request)
  }

  /** Queue an explicit PDF AI action through the session-scoped conversation. */
  const sendTextAiRequestFor = async (sessionId: SessionId, request: PdfAiRequest): Promise<void> => {
    await sendComposerPdfAiRequest(conversationFor(sessionId), request)
  }

  /** Queue an explicit annotation-set AI action through the same session conversation. */
  const sendAnnotationAiRequestFor = async (
    sessionId: SessionId,
    request: PdfAnnotationAiRequest,
  ): Promise<void> => {
    await sendComposerPdfAnnotationAiRequest(conversationFor(sessionId), request)
  }

  /** Queue an explicit PDF image-region AI action without consuming composer state. */
  const sendImageAiRequestFor = async (
    sessionId: SessionId,
    images: readonly File[],
    request: PdfImageAiRequest,
  ): Promise<void> => {
    const session = sessions.binding(sessionId)?.session
    if (session === undefined) throw new Error('当前会话的 AI 对话服务不可用')
    await sendComposerPdfImageAiRequest(session, images, request)
  }

  /** Queue one native-text + image-region turn without consuming the editable draft. */
  const sendMixedAiRequestFor = async (
    sessionId: SessionId,
    images: readonly File[],
    request: PdfMixedAiRequest,
  ): Promise<void> => {
    const session = sessions.binding(sessionId)?.session
    if (session === undefined) throw new Error('当前会话的 AI 对话服务不可用')
    await sendComposerPdfMixedAiRequest(session, images, request)
  }

  // The page type itself. `keepMounted` preserves the loaded documents, the
  // render cache, and unsaved annotations while the column is collapsed or
  // another Session is on screen.
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PDF_TAB_ID,
    kind: PDF_TAB_KIND,
    keepMounted: true,
    title: () => 'PDF 阅读器',
  }), 'dsh-pdf-reader.tab-type')

  // Page body: one reader per Session, served by the keyed tab seat.
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: PDF_TAB_ID,
    // Every callback below takes the Session explicitly from the page's own
    // props, so a page that outlives a session switch can never act on the
    // wrong one; the seat's session id is therefore not read here.
    inject: (_sessionId: SessionId): PdfTabInjected => ({
      attachSelectionFor,
      appendTextReferenceFor,
      sendDocumentsQuestionFor,
      sendTextAiRequestFor,
      sendAnnotationAiRequestFor,
      sendImageAiRequestFor,
      sendMixedAiRequestFor,
      onOpenRequest,
      onCitationRequest,
      onOutlineChange: publishOutline,
      onSearchToggle: () => {
        toggleOutline('search', sidebarWide)
        return outlineSnapshot.active === 'search'
      },
      reclaimHostColumn: () => {
        // The reader docks only if this column gives its track back; the
        // collapse button stays in the conversation header, so the page is one
        // click away when the reader closes.
        if (ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded()
      },
    }),
  }, PdfTabPage)), 'dsh-pdf-reader.tab-body')

  // Frame-wide floating entry: opens the reader page for the Session on screen.
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-pdf-reader-toggle',
    inject: (): PdfToggleInjected => ({
      hooks: { mounted: ctx.sidebarRight.mounted },
      openReader: () => {
        // A page type opens for the Session the column shows; without one the
        // dock has nowhere to put the page and would throw.
        if (ctx.sidebarRight.mounted.getSnapshot() === undefined) return
        ctx.sidebarRight.openTab(PDF_TAB_KIND)
        requestOpen()
      },
    }),
  }, PdfToggleSeat)), 'dsh-pdf-reader.toggle')
}

/** One reader page: derives its hooks from the tab seat and renders the panel. */
const PdfTabPage: SlotComponent<PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<PdfTabInjected>> = (props) => {
  const tabInfo = props.useTabInfo()
  const imageLimits = props.useProjection('imageLimits')
  return createElement(PdfPanel, {
    sessionId: props.sessionId,
    imageLimits,
    attachSelectionFor: props.attachSelectionFor,
    appendTextReferenceFor: props.appendTextReferenceFor,
    sendDocumentsQuestionFor: props.sendDocumentsQuestionFor,
    sendTextAiRequestFor: props.sendTextAiRequestFor,
    sendAnnotationAiRequestFor: props.sendAnnotationAiRequestFor,
    sendImageAiRequestFor: props.sendImageAiRequestFor,
    sendMixedAiRequestFor: props.sendMixedAiRequestFor,
    onClose: () => { tabInfo.tab.actions.close() },
    onOpenRequest: props.onOpenRequest,
    onCitationRequest: props.onCitationRequest,
    onOutlineChange: props.onOutlineChange,
    onSearchToggle: props.onSearchToggle,
    reclaimHostColumn: props.reclaimHostColumn,
  })
}

/** The floating entry: Session gating plus the open verb. */
const PdfToggleSeat: SlotComponent<
  PropsRuntime<'shell.overlay'> & InjectFace<PdfToggleInjected>
> = (props) => {
  const onScreenSessionId = props.useMounted(state => state)
  return createElement(PdfToggle, {
    onToggle: () => {
      const result = resolvePdfToggleResult(onScreenSessionId)
      if (result !== 'handled') return result
      props.openReader()
      return 'handled'
    },
  })
}
