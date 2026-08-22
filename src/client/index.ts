/**
 * dsh-pdf-reader browser half: register the PDF reader into the Web GUI's
 * right-hand `details` slot (declared by ui-layout) via priority shadowing —
 * the column is only the invisible session-scope host — plus a frame-wide
 * draggable floating button (the additive `shell.overlay` seat) that opens
 * the reader window. Documents arrive exclusively through the user's own
 * file picker. Raw PDF bytes remain browser-local; a bounded derived-text
 * index is synchronized to session-local host tools. Type-only runtime/layout/conversation
 * imports load the declare merges that type the slot key and host services;
 * nothing here is a value import beyond the platform module table, so the
 * bundle stays pure.
 * @module dsh-pdf-reader/client
 */

import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { GlobalStandardProps, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
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
  SidebarFooterActionOwnerProps,
  SidebarSectionOwnerProps,
} from './PdfOutlineSidebar.tsx'
import type { PdfOutlineController } from './pdf-outline.ts'
import { resolvePdfToggleResult } from './workspace-gate.ts'

export const name = 'dsh-pdf-reader-client'

/** Services required before the browser plugin loads. */
export const inject = ['slots', 'layout', 'sessions', 'conversation']

export function apply(ctx: Context): void {
  // Keep this plugin compatible with the runtime's outward session contract
  // even when another client package exposes the same service under its
  // concrete `SessionStore` name in declaration output.
  const runtimeSessions = ctx.sessions as unknown as Pick<ISessions, 'scope' | 'binding'>
  const sessionScope = (sessionId: SessionId): ClientContext | undefined => runtimeSessions.scope(sessionId)
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
      }, (props: GlobalStandardProps & SidebarSectionOwnerProps) => createElement(PdfOutlineSidebar, {
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

  ctx.slots.inject('sidebar.workspaces', () => {
    sidebarDeclared = true
    syncOutlineSeat()
    return () => {
      sidebarDeclared = false
      const dispose = disposeOutlineSeat
      disposeOutlineSeat = undefined
      dispose?.()
    }
  })
  ctx.slots.inject('sidebar.footer.action', () => {
    // The host lays footer registrations out horizontally. Keep the two PDF
    // actions in one additive cell so their intended vertical order remains
    // stable: search above outline, without taking over any host-owned action.
    return ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'dsh-pdf-reader-outline',
      order: 100,
    }, (props: GlobalStandardProps & SidebarFooterActionOwnerProps) => createElement(PdfOutlineFooter, {
      ...props,
      source: outlineSource,
      onToggle: toggleOutline,
      onWide: updateSidebarWide,
    }))
  })

  // The floating PDF button and the details-column panel talk through this
  // tiny bus: the button fires open requests, and the session-scoped panel
  // toggles its loaded reader or invokes its hidden file input when empty.
  const openListeners = new Set<() => void>()
  const onOpenRequest = (listener: () => void): (() => void) => {
    openListeners.add(listener)
    return () => { openListeners.delete(listener) }
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

      let prompt = assistant.previousElementSibling
      while (prompt !== null && prompt.getAttribute('data-chat-flow-kind') !== 'user') {
        prompt = prompt.previousElementSibling
      }
      const batchId = prompt === null ? undefined : parsePdfCitationBatchId(prompt.textContent ?? '')
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
  })

  /** Resolve the session scope, then hand the version-sensitive work to its sole boundary. */
  const attachSelectionFor = (
    sessionId: SessionId,
    file: File,
    limits: ComposerImageLimits | undefined,
  ): ComposerSelectionHandle => {
    const scoped = sessionScope(sessionId)
    if (scoped === undefined) throw new Error('当前会话不可用，请先在会话中打开阅读器')
    return attachComposerSelection(ctx.conversation, scoped, file, limits)
  }

  /** Add source-labelled PDF text to the editable draft without sending it. */
  const appendTextReferenceFor = (sessionId: SessionId, reference: PdfTextReference): void => {
    const scoped = sessionScope(sessionId)
    if (scoped === undefined) throw new Error('当前会话不可用，请先在会话中打开阅读器')
    appendComposerPdfTextReference(ctx.conversation, scoped, reference)
  }

  /** Send one confirmed whole-document question without occupying the main draft. */
  const sendDocumentsQuestionFor = async (
    sessionId: SessionId,
    request: PdfDocumentsAiRequest,
  ): Promise<void> => {
    const scoped = sessionScope(sessionId)
    if (scoped === undefined) throw new Error('当前会话不可用，请先在会话中打开阅读器')
    const conversation = scoped.get('conversation')
    if (conversation === undefined) throw new Error('当前会话的 AI 对话服务不可用')
    await sendComposerPdfDocumentsAiRequest(conversation, request)
  }

  /** Queue an explicit PDF AI action through the session-scoped conversation. */
  const sendTextAiRequestFor = async (sessionId: SessionId, request: PdfAiRequest): Promise<void> => {
    const scoped = sessionScope(sessionId)
    if (scoped === undefined) throw new Error('当前会话不可用，请先在会话中打开阅读器')
    const conversation = scoped.get('conversation')
    if (conversation === undefined) throw new Error('当前会话的 AI 对话服务不可用')
    await sendComposerPdfAiRequest(conversation, request)
  }

  /** Queue an explicit annotation-set AI action through the same session conversation. */
  const sendAnnotationAiRequestFor = async (
    sessionId: SessionId,
    request: PdfAnnotationAiRequest,
  ): Promise<void> => {
    const scoped = sessionScope(sessionId)
    if (scoped === undefined) throw new Error('当前会话不可用，请先在会话中打开阅读器')
    const conversation = scoped.get('conversation')
    if (conversation === undefined) throw new Error('当前会话的 AI 对话服务不可用')
    await sendComposerPdfAnnotationAiRequest(conversation, request)
  }

  /** Queue an explicit PDF image-region AI action without consuming composer state. */
  const sendImageAiRequestFor = async (
    sessionId: SessionId,
    images: readonly File[],
    request: PdfImageAiRequest,
  ): Promise<void> => {
    const scoped = sessionScope(sessionId)
    if (scoped === undefined) throw new Error('当前会话不可用，请先在会话中打开阅读器')
    const session = runtimeSessions.binding(sessionId)?.session
    if (session === undefined) throw new Error('当前会话的 AI 对话服务不可用')
    await sendComposerPdfImageAiRequest(session, images, request)
  }

  /** Queue one native-text + image-region turn without consuming the editable draft. */
  const sendMixedAiRequestFor = async (
    sessionId: SessionId,
    images: readonly File[],
    request: PdfMixedAiRequest,
  ): Promise<void> => {
    const scoped = sessionScope(sessionId)
    if (scoped === undefined) throw new Error('当前会话不可用，请先在会话中打开阅读器')
    const session = runtimeSessions.binding(sessionId)?.session
    if (session === undefined) throw new Error('当前会话的 AI 对话服务不可用')
    await sendComposerPdfMixedAiRequest(session, images, request)
  }

  // Single seat: shadow the shipped DetailsPanel via priority — a single
  // slot renders its LOWEST-priority registration, and the shipped panel
  // sits at the default 0. Unloading hands the seat back.
  ctx.slots.register({
    name: 'details',
    priority: -1,
  }, (props: SessionStandardProps) => createElement(PdfPanel, {
    sessionId: props.sessionId,
    imageLimits: props.useProjection('imageLimits'),
    attachSelectionFor,
    appendTextReferenceFor,
    sendDocumentsQuestionFor,
    sendTextAiRequestFor,
    sendAnnotationAiRequestFor,
    sendImageAiRequestFor,
    sendMixedAiRequestFor,
    onClose: () => { ctx.layout.closeDetails() },
    // The reader window owns the screen while open; make sure the details
    // column (the invisible host) is tucked away. Closing the window does
    // NOT reopen the column — the floating button is the reader's entry.
    onWideChange: (open: boolean) => { if (open) ctx.layout.closeDetails() },
    onOpenRequest: onOpenRequest,
    onCitationRequest,
    onOutlineChange: publishOutline,
    onSearchToggle: () => {
      toggleOutline('search', sidebarWide)
      return outlineSnapshot.active === 'search'
    },
  }))

  // List seat: the additive floating entry. In a selected Workspace, one click
  // invokes the picker when empty or toggles the reader without discarding its view.
  ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-pdf-reader-toggle',
  }, (props: GlobalStandardProps) => {
    const currentSessionId = props.useSessions(state => state.current)
    const workspaces = props.useWorkspaces(state => state.items)
    return createElement(PdfToggle, {
      onToggle: () => {
        const result = resolvePdfToggleResult(currentSessionId, workspaces, openListeners.size > 0)
        if (result !== 'handled') return result
        for (const listener of openListeners) listener()
        return 'handled'
      },
    })
  })
}
