/** Pure wide-reader geometry with one narrow-viewport fallback policy. */

export const MIN_READER_WIDTH = 360
export const MIN_CONVERSATION_WIDTH = 360

export interface WideGeometry {
  overlay: boolean
  left: number
  panelWidth: number
}
/**
 * Keep both reader and conversation usable when possible; otherwise cover the
 * viewport with the reader instead of pretending both 360px minima can fit.
 */
export function computeWideGeometry(
  viewportWidth: number,
  sidebarWidth: number,
  preferredWidth: number,
): WideGeometry {
  const viewport = Math.max(0, viewportWidth)
  const sidebar = Math.max(0, Math.min(sidebarWidth, viewport))
  const available = viewport - sidebar
  if (available < MIN_READER_WIDTH + MIN_CONVERSATION_WIDTH) {
    return { overlay: true, left: 0, panelWidth: viewport }
  }
  const maxPanel = available - MIN_CONVERSATION_WIDTH
  const desired = preferredWidth > 0 ? preferredWidth : Math.round(available * 0.55)
  const panelWidth = Math.min(maxPanel, Math.max(MIN_READER_WIDTH, desired))
  return { overlay: false, left: sidebar, panelWidth }
}
