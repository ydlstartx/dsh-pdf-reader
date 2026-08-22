/** Workspace readiness rule for the global PDF entry button. */

import type { SessionId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'

/** Result of attempting to activate the global PDF entry button. */
export type PdfToggleResult = 'handled' | 'workspace-required' | 'session-required'

/**
 * Resolve the earliest missing prerequisite for a PDF-button click.
 * @param currentSessionId - Currently selected frontend session, if any.
 * @param workspaces - Materialized Workspace projections.
 * @param controllerReady - Whether the current session mounted its PDF controller.
 * @returns handled when the request can be dispatched, otherwise the missing prerequisite.
 */
export function resolvePdfToggleResult(
  currentSessionId: SessionId | undefined,
  workspaces: readonly Pick<WorkspaceView, 'sessionIds'>[],
  controllerReady: boolean,
): PdfToggleResult {
  const workspaceSelected = currentSessionId !== undefined
    && workspaces.some(workspace => workspace.sessionIds.includes(currentSessionId))
  if (!workspaceSelected) return 'workspace-required'
  return controllerReady ? 'handled' : 'session-required'
}
