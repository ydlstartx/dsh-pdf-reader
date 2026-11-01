/** Readiness rule for the global PDF entry button. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Result of attempting to activate the global PDF entry button. */
export type PdfToggleResult = 'handled' | 'session-required'

/**
 * Resolve whether the floating entry can act right now.
 *
 * The reader is a Session-scoped page of the right Sidebar: opening it needs
 * the Session that column is showing, so the entry acts exactly when one is on
 * screen. Nothing else gates it — a Session outside any Workspace still has a
 * reader page.
 * @param onScreenSessionId - the Session the right Sidebar shows, if any.
 * @returns handled when the request can be dispatched, otherwise the missing prerequisite.
 */
export function resolvePdfToggleResult(onScreenSessionId: SessionId | undefined): PdfToggleResult {
  return onScreenSessionId === undefined ? 'session-required' : 'handled'
}
