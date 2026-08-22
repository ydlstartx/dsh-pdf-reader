import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { resolvePdfToggleResult } from '../src/client/workspace-gate.ts'

const session = (value: string): SessionId => value as SessionId
const workspace = (...sessionIds: SessionId[]): Pick<WorkspaceView, 'sessionIds'> => ({ sessionIds })

test('PDF activation requires a current Workspace-owned session', () => {
  const owned = session('owned')

  assert.equal(resolvePdfToggleResult(undefined, [workspace(owned)], true), 'workspace-required')
  assert.equal(resolvePdfToggleResult(session('orphan'), [workspace(owned)], true), 'workspace-required')
  assert.equal(resolvePdfToggleResult(owned, [workspace(owned)], false), 'session-required')
  assert.equal(resolvePdfToggleResult(owned, [workspace(owned)], true), 'handled')
})
