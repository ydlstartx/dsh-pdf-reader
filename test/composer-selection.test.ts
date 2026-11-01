import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ComposerAttachment,
  DraftAttachmentId,
  IConversation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { attachComposerSelection, releaseConsumedComposerSelections } from '../src/client/composer-selection.ts'
import type { ComposerImageLimits } from '../src/client/composer-selection.ts'

const id = (value: string): DraftAttachmentId => value as DraftAttachmentId

interface FakeHarness {
  conversation: IConversation
  imageIds: () => readonly DraftAttachmentId[]
  draft: () => string
  remove: (attachmentId: DraftAttachmentId) => void
  released: DraftAttachmentId[]
  setAdmission: (admission: 'accept' | 'refuse' | 'throw') => void
}

function fakeHarness(initialIds: readonly DraftAttachmentId[] = []): FakeHarness {
  let imageIds = [...initialIds]
  let admission: 'accept' | 'refuse' | 'throw' = 'accept'
  const draft = '用户已经输入的问题'
  const subscribers = new Set<() => void>()
  const released: DraftAttachmentId[] = []
  const attachments = new Map<DraftAttachmentId, ComposerAttachment>()
  let attachmentSequence = 0
  for (const initialId of initialIds) {
    attachments.set(initialId, {
      kind: 'image',
      id: initialId,
      file: new File(['user'], `${String(initialId)}.png`, { type: 'image/png' }),
      previewUrl: `blob:${String(initialId)}`,
    })
  }
  const publish = (): void => { for (const subscriber of subscribers) subscriber() }
  const remove = (attachmentId: DraftAttachmentId): void => {
    imageIds = imageIds.filter(candidate => candidate !== attachmentId)
    publish()
  }
  const input = {
    addAttachments: (next: readonly DraftAttachmentId[]) => {
      if (admission === 'throw') throw new Error('input unavailable')
      if (admission === 'refuse') return false
      imageIds = [...imageIds, ...next]
      publish()
      return true
    },
    removeAttachment: remove,
    state: {
      getSnapshot: () => ({ draft, attachmentIds: imageIds }),
      subscribe: (listener: () => void) => {
        subscribers.add(listener)
        return () => { subscribers.delete(listener) }
      },
    },
  }
  const conversation = {
    input: { for: () => input },
    createDrafts: (_sessionId: SessionId, files: readonly File[]) => files.map((file) => {
      const attachmentId = id(`pdf-crop-${String(++attachmentSequence)}`)
      const attachment: ComposerAttachment = {
        kind: 'image',
        id: attachmentId,
        file,
        previewUrl: `blob:${String(attachmentId)}`,
      }
      attachments.set(attachmentId, attachment)
      return attachment
    }),
    resolveDraftAttachments: (ids: readonly DraftAttachmentId[]) => ids.flatMap(attachmentId => {
      const attachment = attachments.get(attachmentId)
      return attachment === undefined ? [] : [attachment]
    }),
    releaseDraftAttachment: (releasedId: DraftAttachmentId) => {
      released.push(releasedId)
      attachments.delete(releasedId)
    },
  } as unknown as IConversation
  return {
    conversation,
    imageIds: () => imageIds,
    draft: () => draft,
    remove,
    released,
    setAdmission: next => { admission = next },
  }
}

const scope = {} as ClientContext
const sessionId = 'session-1' as SessionId
const crop = (): File => new File(['crop'], 'crop.png', { type: 'image/png' })
const limits = (overrides: Partial<ComposerImageLimits> = {}): ComposerImageLimits => ({
  maxImageBytes: 100,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 1_000,
  maxImagePixels: 1_000,
  ...overrides,
})

test('attaching a crop preserves the text draft and existing attachments', () => {
  const foreignId = id('user-image')
  const harness = fakeHarness([foreignId])

  attachComposerSelection(harness.conversation, scope, sessionId, crop(), limits())

  assert.equal(harness.draft(), '用户已经输入的问题')
  assert.deepEqual(harness.imageIds(), [foreignId, id('pdf-crop-1')])
  assert.deepEqual(harness.released, [])
})

test('admission refusal and exception both release the created crop', () => {
  for (const admission of ['refuse', 'throw'] as const) {
    const harness = fakeHarness()
    harness.setAdmission(admission)

    assert.throws(() => attachComposerSelection(harness.conversation, scope, sessionId, crop(), limits()))
    assert.deepEqual(harness.imageIds(), [])
    assert.deepEqual(harness.released, [id('pdf-crop-1')])
  }
})

test('release is idempotent and removes only the plugin attachment', () => {
  const foreignId = id('user-image')
  const harness = fakeHarness([foreignId])
  const handle = attachComposerSelection(harness.conversation, scope, sessionId, crop(), limits())

  handle.release()
  handle.release()

  assert.deepEqual(harness.imageIds(), [foreignId])
  assert.deepEqual(harness.released, [id('pdf-crop-1')])
})

test('external removal is observed once, including removal before subscription', () => {
  const harness = fakeHarness()
  const handle = attachComposerSelection(harness.conversation, scope, sessionId, crop(), limits())
  let notifications = 0
  const unsubscribe = handle.onRemoved(() => { notifications += 1 })

  harness.remove(id('pdf-crop-1'))
  harness.remove(id('pdf-crop-1'))
  unsubscribe()
  assert.equal(notifications, 1)

  const second = fakeHarness()
  const lateHandle = attachComposerSelection(second.conversation, scope, sessionId, crop(), limits())
  second.remove(id('pdf-crop-1'))
  lateHandle.onRemoved(() => { notifications += 1 })()
  assert.equal(notifications, 2)
})

test('compatibility and PNG checks fail before mutating composer state', () => {
  const harness = fakeHarness()
  assert.throws(
    () => attachComposerSelection(
      harness.conversation,
      scope,
      sessionId,
      new File(['x'], 'x.jpg', { type: 'image/jpeg' }),
      limits(),
    ),
    /必须是 PNG/,
  )
  assert.deepEqual(harness.imageIds(), [])

  const outwardOnly = { input: harness.conversation.input } as IConversation
  assert.throws(
    () => attachComposerSelection(outwardOnly, scope, sessionId, crop(), limits()),
    /未开放主输入框图片草稿能力/,
  )
  assert.deepEqual(harness.imageIds(), [])
})

test('host image count and byte limits reject only the new crop', () => {
  const firstId = id('user-image-1')
  const secondId = id('user-image-2')
  const countHarness = fakeHarness([firstId, secondId])
  assert.throws(
    () => attachComposerSelection(
      countHarness.conversation,
      scope,
      sessionId,
      crop(),
      limits({ maxImagesPerMessage: 2 }),
    ),
    /最多可附加 2 张图片/,
  )
  assert.deepEqual(countHarness.imageIds(), [firstId, secondId])
  assert.deepEqual(countHarness.released, [])

  const bytesHarness = fakeHarness([firstId])
  assert.throws(
    () => attachComposerSelection(
      bytesHarness.conversation,
      scope,
      sessionId,
      crop(),
      limits({ maxMessageImageBytes: 7 }),
    ),
    /图片总大小不能超过 7 字节/,
  )
  assert.deepEqual(bytesHarness.imageIds(), [firstId])
  assert.deepEqual(bytesHarness.released, [])

  const singleHarness = fakeHarness()
  assert.throws(
    () => attachComposerSelection(
      singleHarness.conversation,
      scope,
      sessionId,
      crop(),
      limits({ maxImageBytes: 3 }),
    ),
    /超过单图上限/,
  )
  assert.deepEqual(singleHarness.imageIds(), [])
})

test('successive crops append in order', () => {
  const harness = fakeHarness()
  attachComposerSelection(harness.conversation, scope, sessionId, crop(), limits())
  attachComposerSelection(harness.conversation, scope, sessionId, crop(), limits())
  assert.deepEqual(harness.imageIds(), [id('pdf-crop-1'), id('pdf-crop-2')])
})

test('releasing a middle crop preserves both sibling attachments and their order', () => {
  const harness = fakeHarness()
  attachComposerSelection(harness.conversation, scope, sessionId, crop(), limits())
  const middle = attachComposerSelection(harness.conversation, scope, sessionId, crop(), limits())
  attachComposerSelection(harness.conversation, scope, sessionId, crop(), limits())

  middle.release()

  assert.deepEqual(harness.imageIds(), [id('pdf-crop-1'), id('pdf-crop-3')])
  assert.deepEqual(harness.released, [id('pdf-crop-2')])
})

test('accepted AI batch cleanup releases only records still present when sending settles', () => {
  const calls: string[] = []
  const record = (name: string) => ({
    name,
    unsubscribe: () => { calls.push(`unsubscribe:${name}`) },
    handle: {
      release: () => { calls.push(`release:${name}`) },
      onRemoved: () => () => {},
    },
  })
  const first = record('first')
  const alreadyRemoved = record('removed')
  const addedDuringSend = record('new')

  const remaining = releaseConsumedComposerSelections(
    [first, addedDuringSend],
    [first, alreadyRemoved],
  )

  assert.deepEqual(remaining, [addedDuringSend])
  assert.deepEqual(calls, ['unsubscribe:first', 'release:first'])
})
