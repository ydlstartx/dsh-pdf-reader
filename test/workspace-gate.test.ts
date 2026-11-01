import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { resolvePdfToggleResult } from '../src/client/workspace-gate.ts'

const session = (value: string): SessionId => value as SessionId

test('PDF activation needs the Session the right Sidebar shows', () => {
  assert.equal(resolvePdfToggleResult(undefined), 'session-required')
  assert.equal(resolvePdfToggleResult(session('on-screen')), 'handled')
})
