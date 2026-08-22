/**
 * Narrow compatibility boundary between the PDF crop and Harness rc.8's
 * composer attachment registry. The public conversation face exposes the
 * per-session input, while image registration still lives on the concrete
 * controller; keep that version-sensitive fact in this file only.
 * @module dsh-pdf-reader/client/composer-selection
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ComposerAttachment,
  DraftAttachmentId,
  IConversation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

export interface ComposerSelectionHandle {
  /** Remove and release only this plugin-owned image. Safe to call repeatedly. */
  release: () => void
  /** Observe the first time this id leaves the main composer. */
  onRemoved: (listener: () => void) => () => void
}

export interface ConsumedComposerSelection {
  handle: ComposerSelectionHandle
  unsubscribe: () => void
}

/** Release only records present in both the accepted batch and current composer state. */
export function releaseConsumedComposerSelections<T extends ConsumedComposerSelection>(
  current: readonly T[],
  acceptedBatch: readonly T[],
): readonly T[] {
  const accepted = new Set(acceptedBatch)
  const remaining: T[] = []
  for (const record of current) {
    if (!accepted.has(record)) {
      remaining.push(record)
      continue
    }
    record.unsubscribe()
    record.handle.release()
  }
  return remaining
}

/** Host-projected limits needed by PDF crop generation and composer intake. */
export interface ComposerImageLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
}

type ConcreteAttachmentBridge = IConversation & Partial<{
  createDraftImages: (files: readonly File[]) => readonly ComposerAttachment[]
  draftImages: (ids: readonly DraftAttachmentId[]) => readonly ComposerAttachment[]
  releaseDraftImage: (id: DraftAttachmentId) => void
}>

/**
 * Attach exactly one bounded PNG to one session composer.
 *
 * Invariants:
 * - this function never reads or writes the text draft;
 * - admission failure releases the just-created browser attachment;
 * - the returned release operation affects this id only and is idempotent.
 */
export function attachComposerSelection(
  conversationFace: IConversation,
  scope: ClientContext,
  file: File,
  limits: ComposerImageLimits | undefined,
): ComposerSelectionHandle {
  if (file.type !== 'image/png') throw new Error('PDF 选区附件必须是 PNG 图片')

  const conversation = conversationFace as ConcreteAttachmentBridge
  if (typeof conversation.createDraftImages !== 'function'
    || typeof conversation.draftImages !== 'function'
    || typeof conversation.releaseDraftImage !== 'function') {
    throw new Error('当前 Harness 未开放主输入框图片草稿能力')
  }

  const input = conversation.input.for(scope)
  const currentIds = input.state.getSnapshot().imageIds
  if (limits !== undefined) {
    if (file.size > limits.maxImageBytes) {
      throw new Error(`选区截图超过单图上限（${String(limits.maxImageBytes)} 字节）`)
    }
    if (currentIds.length + 1 > limits.maxImagesPerMessage) {
      throw new Error(`当前消息最多可附加 ${String(limits.maxImagesPerMessage)} 张图片`)
    }
    const currentBytes = conversation.draftImages(currentIds)
      .reduce((total, current) => total + current.file.size, 0)
    if (currentBytes + file.size > limits.maxMessageImageBytes) {
      throw new Error(`当前消息的图片总大小不能超过 ${String(limits.maxMessageImageBytes)} 字节`)
    }
  }

  const attachment = conversation.createDraftImages([file])[0]
  if (attachment === undefined) throw new Error('无法创建选区图片草稿')

  let admitted: boolean
  try {
    admitted = input.addImages([attachment.id])
  } catch (cause) {
    conversation.releaseDraftImage(attachment.id)
    throw cause
  }
  if (!admitted) {
    conversation.releaseDraftImage(attachment.id)
    throw new Error('主输入框当前无法接收图片，请稍后重新框选')
  }

  const attachmentId = attachment.id
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      // Match the host InputBar's ownership order: revoke browser bytes/URL,
      // then remove the id from this session's visible composer state.
      conversation.releaseDraftImage?.(attachmentId)
      input.removeImage(attachmentId)
    },
    onRemoved: (listener) => {
      let notified = false
      const notifyIfRemoved = (): void => {
        if (notified || input.state.getSnapshot().imageIds.includes(attachmentId)) return
        notified = true
        listener()
      }
      const unsubscribe = input.state.subscribe(notifyIfRemoved)
      // Close the subscribe-after-removal race. PdfPanel also handles this
      // synchronous notification without leaking the new subscription.
      notifyIfRemoved()
      return unsubscribe
    },
  }
}
