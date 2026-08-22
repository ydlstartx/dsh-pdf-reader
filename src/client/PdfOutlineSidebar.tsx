import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { visiblePdfOutlineItems } from './pdf-outline.ts'
import type { PdfOutlineController } from './pdf-outline.ts'
import {
  MAX_PDF_BOOKMARKS,
  MAX_PDF_BOOKMARK_TITLE_LENGTH,
  pdfBookmarkDescendantIds,
} from './pdf-bookmarks.ts'
import { isBlankPdfSearchQuery, MAX_PDF_SEARCH_QUERY_LENGTH } from './pdf-search.ts'

/** Local copies of the two ui-sidebar owner shares used by this plugin. */
export interface SidebarSectionOwnerProps {
  wide: boolean
  expandSidebar: () => void
}

export interface SidebarFooterActionOwnerProps {
  wide: boolean
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.workspaces': { kind: 'single'; scope: 'root'; owner: SidebarSectionOwnerProps }
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
  }
}

export interface PdfOutlineSnapshot {
  controller: PdfOutlineController | undefined
  active: PdfSidebarMode | undefined
}

export type PdfSidebarMode = 'outline' | 'search'

export interface PdfOutlineSource {
  getSnapshot: () => PdfOutlineSnapshot
  subscribe: (listener: () => void) => () => void
}

export type PdfOutlineFooterProps = GlobalStandardProps & SidebarFooterActionOwnerProps & {
  source: PdfOutlineSource
  onToggle: (mode: PdfSidebarMode, wide: boolean) => void
  onWide: (wide: boolean) => void
}

const styles = {
  footerStack: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    width: '100%',
  } as const,
  footerStackRail: { alignItems: 'center', width: '36px' } as const,
  footerLayer: {
    position: 'relative',
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    height: '49px',
    margin: '8px 0 0',
  } as const,
  footerRail: { width: '36px', height: '36px', margin: 0 } as const,
  footerButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    height: '49px',
    padding: '0 8px 0 6px',
    border: 'none',
    borderRadius: '12px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '14px',
    overflow: 'hidden',
  } as const,
  footerButtonRail: {
    justifyContent: 'center',
    gap: 0,
    width: '36px',
    height: '36px',
    padding: 0,
    borderRadius: '50%',
  } as const,
  footerLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const,
  panel: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
    color: 'var(--dsw-alias-label-primary)',
  } as const,
  header: {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minHeight: '42px',
    padding: '4px 12px 8px 4px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
  } as const,
  close: {
    flex: '0 0 auto',
    width: '28px',
    height: '28px',
    padding: 0,
    border: 'none',
    borderRadius: '8px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '18px',
  } as const,
  title: { flex: 1, minWidth: 0, overflow: 'hidden' } as const,
  titleMain: { fontSize: '13px', fontWeight: 600, lineHeight: '18px' } as const,
  fileName: {
    overflow: 'hidden',
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '11px',
    lineHeight: '16px',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  list: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '6px 8px 12px 0',
  } as const,
  allButton: {
    flex: 'none',
    minWidth: '58px',
    height: '28px',
    padding: '0 7px',
    border: 'none',
    borderRadius: '7px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '11px',
  } as const,
  addButton: {
    flex: '0 0 auto',
    width: '28px',
    height: '28px',
    padding: 0,
    border: 'none',
    borderRadius: '7px',
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '18px',
    lineHeight: '28px',
  } as const,
  locateButton: {
    flex: 'none',
    minWidth: '42px',
    height: '28px',
    padding: '0 7px',
    border: 'none',
    borderRadius: '7px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '11px',
  } as const,
  locateButtonDisabled: { cursor: 'default', opacity: 0.4 } as const,
  itemRow: {
    display: 'flex',
    alignItems: 'stretch',
    width: '100%',
  } as const,
  itemBlock: { width: '100%' } as const,
  itemRowCurrent: {
    borderRadius: '7px',
    background: 'var(--dsw-alias-interactive-bg-hover)',
  } as const,
  disclosure: {
    flex: '0 0 22px',
    width: '22px',
    minHeight: '32px',
    padding: 0,
    border: 'none',
    borderRadius: '7px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '12px',
  } as const,
  disclosureSpacer: { flex: '0 0 22px', width: '22px' } as const,
  item: {
    flex: 1,
    minWidth: 0,
    minHeight: '32px',
    padding: '6px 8px 6px 2px',
    border: 'none',
    borderRadius: '7px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '12px',
    lineHeight: '18px',
    textAlign: 'left',
    overflowWrap: 'anywhere',
  } as const,
  editButton: {
    flex: '0 0 28px',
    width: '28px',
    minHeight: '32px',
    padding: 0,
    border: 'none',
    borderRadius: '7px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '13px',
  } as const,
  itemActions: {
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'stretch',
  } as const,
  deleteButton: { color: '#d4380d' } as const,
  bookmarkRowDeleteConfirm: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minHeight: '32px',
    padding: '3px 4px 6px',
  } as const,
  bookmarkEditor: {
    flex: 'none',
    display: 'grid',
    gap: '8px',
    padding: '10px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-background-container)',
  } as const,
  bookmarkEditorTitle: { fontSize: '12px', fontWeight: 600 } as const,
  bookmarkInput: {
    width: '100%',
    minWidth: 0,
    height: '32px',
    boxSizing: 'border-box',
    padding: '0 8px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '7px',
    outline: 'none',
    background: 'var(--dsw-alias-background-container)',
    color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'inherit',
    fontSize: '12px',
  } as const,
  bookmarkParentPicker: {
    position: 'relative',
    minWidth: 0,
  } as const,
  bookmarkParentButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    cursor: 'pointer',
    textAlign: 'left',
  } as const,
  bookmarkParentLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  bookmarkParentChevron: {
    flex: 'none',
    fontSize: '10px',
    lineHeight: 1,
  } as const,
  bookmarkParentMenu: {
    position: 'absolute',
    zIndex: 40,
    top: 'calc(100% + 4px)',
    right: 0,
    left: 0,
    maxHeight: '216px',
    overflowY: 'auto',
    boxSizing: 'border-box',
    padding: '4px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px',
    background: 'var(--dsw-alias-background-container)',
    color: 'var(--dsw-alias-label-primary)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
  } as const,
  bookmarkParentOption: {
    display: 'block',
    width: '100%',
    minHeight: '30px',
    padding: '5px 8px',
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '12px',
    lineHeight: '18px',
    textAlign: 'left',
    overflowWrap: 'anywhere',
  } as const,
  bookmarkParentOptionSelected: {
    background: 'var(--dsw-alias-interactive-bg-hover)',
    fontWeight: 600,
  } as const,
  bookmarkFields: {
    display: 'grid',
    gridTemplateColumns: '84px minmax(0, 1fr)',
    gap: '8px',
  } as const,
  bookmarkActions: { display: 'flex', alignItems: 'center', gap: '6px' } as const,
  bookmarkAction: {
    height: '28px',
    padding: '0 9px',
    border: 'none',
    borderRadius: '7px',
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '11px',
  } as const,
  bookmarkDeletePrompt: {
    flex: 1,
    minWidth: 0,
    color: '#d4380d',
    fontSize: '11px',
    lineHeight: '16px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  bookmarkDeleteConfirm: {
    color: '#fff',
    background: '#cf1322',
  } as const,
  bookmarkError: { color: '#d4380d', fontSize: '11px', lineHeight: '16px' } as const,
  disabledItem: { color: 'var(--dsw-alias-label-tertiary)', cursor: 'default' } as const,
  currentItem: { fontWeight: 600 } as const,
  searchPanel: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  } as const,
  searchForm: {
    flex: 'none',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: '6px',
    padding: '8px',
  } as const,
  searchInput: {
    minWidth: 0,
    height: '32px',
    padding: '0 9px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px',
    outline: 'none',
    background: 'var(--dsw-alias-background-container)',
    color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'inherit',
    fontSize: '12px',
  } as const,
  searchAction: {
    height: '32px',
    minWidth: '48px',
    padding: '0 9px',
    border: 'none',
    borderRadius: '8px',
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '12px',
  } as const,
  searchStatus: {
    flex: 'none',
    padding: '0 10px 7px',
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '11px',
    lineHeight: '16px',
  } as const,
  searchError: { color: '#d4380d' } as const,
  searchResults: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '0 8px 12px',
  } as const,
  searchResult: {
    display: 'block',
    width: '100%',
    padding: '8px',
    border: 'none',
    borderRadius: '8px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
  } as const,
  searchResultPage: {
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: '11px',
    fontWeight: 600,
    lineHeight: '16px',
  } as const,
  searchResultSnippet: {
    marginTop: '2px',
    fontSize: '12px',
    lineHeight: '18px',
    overflowWrap: 'anywhere',
  } as const,
  searchEmpty: {
    padding: '18px 10px',
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '12px',
    lineHeight: '18px',
  } as const,
} satisfies Record<string, CSSProperties>

function OutlineIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M4 3.25h10v11.5H4zM6.5 6h5M6.5 9h5M6.5 12h3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="7.75" cy="7.75" r="4.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="m11.3 11.3 3.2 3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function DeleteBookmarkIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M3.5 4.5h9M6 2.75h4M5 4.5l.45 8h5.1l.45-8M6.75 6.5v4M9.25 6.5v4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Additive action rendered above Harness Settings in both sidebar widths. */
export function PdfOutlineFooter(props: PdfOutlineFooterProps) {
  const snapshot = useSyncExternalStore(props.source.subscribe, props.source.getSnapshot)
  useEffect(() => { props.onWide(props.wide) }, [props.onWide, props.wide])
  if (snapshot.controller === undefined) return null
  return (
    <div style={{ ...styles.footerStack, ...(!props.wide ? styles.footerStackRail : {}) }}>
      {(['search', 'outline'] as const).map((mode) => {
        const label = mode === 'search' ? 'PDF 搜索' : 'PDF 目录'
        return (
          <div key={mode} style={{ ...styles.footerLayer, ...(!props.wide ? styles.footerRail : {}) }}>
            <button
              type="button"
              aria-label={label}
              aria-pressed={snapshot.active === mode}
              style={{
                ...styles.footerButton,
                ...(!props.wide ? styles.footerButtonRail : {}),
                ...(snapshot.active === mode ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : {}),
              }}
              onClick={() => { props.onToggle(mode, props.wide) }}
            >
              {mode === 'search' ? <SearchIcon /> : <OutlineIcon />}
              {props.wide && <span style={styles.footerLabel}>{label}</span>}
            </button>
          </div>
        )
      })}
    </div>
  )
}

function PdfSearchStatus(props: { controller: PdfOutlineController }) {
  const state = props.controller.search.state
  let message = '仅搜索 PDF 自带文字；扫描图片不包含在内'
  if (state.status === 'running') {
    message = `搜索中：${String(state.scannedPages)} / ${String(state.totalPages)} 页 · ${String(state.results.length)} 条`
  } else if (state.status === 'paused') {
    message = `已加载 ${String(state.results.length)} 条，继续向下滚动可搜索更多（到第 ${String(state.scannedPages)} 页）`
  } else if (state.status === 'cancelled') {
    message = `已取消：搜索到第 ${String(state.scannedPages)} 页 · ${String(state.results.length)} 条`
  } else if (state.status === 'error') {
    message = state.error ?? '搜索失败'
  } else if (state.status === 'done' && !state.hasSearchableText) {
    message = '未检测到可搜索文字；这可能是扫描型 PDF'
  } else if (state.status === 'done' && state.results.length === 0) {
    message = `未找到“${state.query}”`
  } else if (state.status === 'done' && state.truncated) {
    message = `已达到 ${String(state.results.length)} 条结果上限（搜索到第 ${String(state.scannedPages)} 页）`
  } else if (state.status === 'done') {
    message = `找到 ${String(state.results.length)} 条结果`
  }
  if (state.failedPages > 0) message += ` · ${String(state.failedPages)} 页读取失败`
  return (
    <div
      role={state.status === 'error' ? 'alert' : 'status'}
      style={{ ...styles.searchStatus, ...(state.status === 'error' ? styles.searchError : {}) }}
    >
      {message}
    </div>
  )
}

type BookmarkEditorState = {
  kind: 'add' | 'edit'
  id: string | undefined
  title: string
  page: string
  parentId: string | null
  external: boolean
}

type BookmarkParentOption = {
  id: string
  title: string
  depth: number
}

function BookmarkParentPicker(props: {
  value: string | null
  options: readonly BookmarkParentOption[]
  onChange: (value: string | null) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const selected = props.value === null
    ? undefined
    : props.options.find(option => option.id === props.value)

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) !== true) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [open])

  const choose = (value: string | null): void => {
    props.onChange(value)
    setOpen(false)
    buttonRef.current?.focus()
  }

  return (
    <div ref={rootRef} style={styles.bookmarkParentPicker}>
      <button
        ref={buttonRef}
        type="button"
        aria-label="父书签"
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{ ...styles.bookmarkInput, ...styles.bookmarkParentButton }}
        onClick={() => { setOpen(current => !current) }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault()
            setOpen(false)
          } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span style={styles.bookmarkParentLabel}>
          {selected === undefined ? '顶层书签' : selected.title}
        </span>
        <span aria-hidden="true" style={styles.bookmarkParentChevron}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="选择父书签"
          style={styles.bookmarkParentMenu}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            setOpen(false)
            buttonRef.current?.focus()
          }}
        >
          <button
            type="button"
            role="option"
            aria-selected={props.value === null}
            style={{
              ...styles.bookmarkParentOption,
              ...(props.value === null ? styles.bookmarkParentOptionSelected : {}),
            }}
            onClick={() => { choose(null) }}
          >
            顶层书签
          </button>
          {props.options.map(option => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={option.id === props.value}
              style={{
                ...styles.bookmarkParentOption,
                ...(option.id === props.value ? styles.bookmarkParentOptionSelected : {}),
                paddingLeft: `${String(8 + Math.min(8, option.depth) * 12)}px`,
              }}
              onClick={() => { choose(option.id) }}
            >
              {option.title}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function PdfOutlinePanel(props: {
  controller: PdfOutlineController
  mode: PdfSidebarMode
  onClose: () => void
  closeAfterNavigate?: boolean
  closeLabel?: string
  closeGlyph?: string
  style?: CSSProperties
}) {
  const visibleItems = useMemo(
    () => visiblePdfOutlineItems(props.controller.items, props.controller.expandedIds),
    [props.controller.expandedIds, props.controller.items],
  )
  const expandableItems = useMemo(
    () => props.controller.items.filter(item => item.hasChildren),
    [props.controller.items],
  )
  const allExpanded = expandableItems.length > 0
    && expandableItems.every(item => props.controller.expandedIds.has(item.id))
  const listRef = useRef<HTMLDivElement>(null)
  const searchResultsRef = useRef<HTMLDivElement>(null)
  const searchLoadMoreRef = useRef<HTMLDivElement>(null)
  const locatePendingRef = useRef(false)
  const [locateRequest, setLocateRequest] = useState(0)
  const [searchDraft, setSearchDraft] = useState(() => props.controller.search.state.query)
  const [bookmarkEditor, setBookmarkEditor] = useState<BookmarkEditorState | undefined>(undefined)
  const [bookmarkError, setBookmarkError] = useState<string | undefined>(undefined)
  const [bookmarkDeleteTargetId, setBookmarkDeleteTargetId] = useState<string | undefined>(undefined)

  const bookmarkParentCandidates = useMemo(() => {
    if (bookmarkEditor?.id === undefined) return props.controller.items
    const excluded = new Set([bookmarkEditor.id])
    let changed = true
    while (changed) {
      changed = false
      for (const item of props.controller.items) {
        if (excluded.has(item.id)) continue
        if (item.parentId !== null && excluded.has(item.parentId)) {
          excluded.add(item.id)
          changed = true
        }
      }
    }
    return props.controller.items.filter(item => !excluded.has(item.id))
  }, [bookmarkEditor?.id, props.controller.items])
  const bookmarkDeleteDescendantCount = useMemo(
    () => bookmarkDeleteTargetId === undefined
      ? 0
      : pdfBookmarkDescendantIds(props.controller.items, bookmarkDeleteTargetId).size,
    [bookmarkDeleteTargetId, props.controller.items],
  )

  useEffect(() => {
    setBookmarkEditor(undefined)
    setBookmarkError(undefined)
    setBookmarkDeleteTargetId(undefined)
  }, [props.controller.documentName])

  const beginAddBookmark = (): void => {
    if (props.controller.items.length >= MAX_PDF_BOOKMARKS) {
      setBookmarkError(`PDF 书签已达到 ${String(MAX_PDF_BOOKMARKS)} 条上限`)
      return
    }
    setBookmarkError(undefined)
    setBookmarkDeleteTargetId(undefined)
    setBookmarkEditor({
      kind: 'add',
      id: undefined,
      title: `第 ${String(props.controller.currentPage)} 页`,
      page: String(props.controller.currentPage),
      parentId: null,
      external: false,
    })
  }

  const beginEditBookmark = (id: string): void => {
    const item = props.controller.items.find(candidate => candidate.id === id)
    if (item === undefined) return
    setBookmarkError(undefined)
    setBookmarkDeleteTargetId(undefined)
    setBookmarkEditor({
      kind: 'edit',
      id,
      title: item.title,
      page: item.pageNumber === undefined ? '' : String(item.pageNumber),
      parentId: item.parentId,
      external: item.external === true,
    })
  }

  const commitBookmark = (): void => {
    if (bookmarkEditor === undefined) return
    const title = bookmarkEditor.title.trim()
    if (title.length === 0) {
      setBookmarkError('请输入书签名称')
      return
    }
    const pageText = bookmarkEditor.page.trim()
    const pageNumber = pageText === '' ? undefined : Number(pageText)
    if (pageNumber === undefined && bookmarkEditor.kind === 'add') {
      setBookmarkError('请输入书签页码')
      return
    }
    if (pageNumber !== undefined && (!Number.isSafeInteger(pageNumber)
      || pageNumber < 1 || pageNumber > props.controller.totalPages)) {
      setBookmarkError(`页码应为 1–${String(props.controller.totalPages)} 的整数`)
      return
    }
    const draft = {
      parentId: bookmarkEditor.parentId,
      title,
      ...(pageNumber === undefined ? {} : { pageNumber }),
    }
    if (bookmarkEditor.kind === 'add') props.controller.addBookmark(draft)
    else if (bookmarkEditor.id !== undefined) props.controller.updateBookmark(bookmarkEditor.id, draft)
    setBookmarkEditor(undefined)
    setBookmarkError(undefined)
    setBookmarkDeleteTargetId(undefined)
  }

  useEffect(() => {
    if (props.controller.search.state.status === 'idle' && props.controller.search.state.query === '') {
      setSearchDraft('')
    }
  }, [
    props.controller.documentName,
    props.controller.search.state.query,
    props.controller.search.state.status,
  ])

  // Scroll only after an explicit locate request. Ordinary PDF scrolling may
  // change the highlight, but never steals the user's place in the outline or
  // expands branches they deliberately collapsed.
  useLayoutEffect(() => {
    if (!locatePendingRef.current || props.controller.currentItemId === undefined) return
    const list = listRef.current
    const row = Array.from(list?.querySelectorAll<HTMLElement>('[data-outline-id]') ?? [])
      .find(candidate => candidate.dataset['outlineId'] === props.controller.currentItemId)
    if (list === null || row === undefined) return
    const listBox = list.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    list.scrollTop += rowBox.top - listBox.top - (list.clientHeight - rowBox.height) / 2
    locatePendingRef.current = false
  }, [locateRequest, props.controller.currentItemId, props.controller.expandedIds])

  const loadMoreSearchResultsIfNeeded = (): void => {
    const list = searchResultsRef.current
    if (list === null || props.controller.search.state.status !== 'paused') return
    const remaining = list.scrollHeight - list.scrollTop - list.clientHeight
    if (remaining <= Math.max(160, list.clientHeight / 2)) props.controller.search.loadMore()
  }

  useEffect(() => {
    if (props.mode !== 'search' || props.controller.search.state.status !== 'paused') return
    const root = searchResultsRef.current
    const target = searchLoadMoreRef.current
    if (root === null || target === null) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) props.controller.search.loadMore()
    }, { root, rootMargin: '0px 0px 50% 0px' })
    observer.observe(target)
    return () => { observer.disconnect() }
  }, [
    props.controller.search.loadMore,
    props.controller.search.state.results.length,
    props.controller.search.state.status,
    props.mode,
  ])

  return (
    <div style={{ ...styles.panel, ...props.style }}>
      <div style={styles.header}>
        <button type="button" aria-label={props.closeLabel ?? '返回会话列表'} style={styles.close} onClick={props.onClose}>
          {props.closeGlyph ?? '←'}
        </button>
        <div style={styles.title}>
          <div style={styles.titleMain}>{props.mode === 'search' ? 'PDF 搜索' : 'PDF 目录'}</div>
          <div style={styles.fileName}>{props.controller.documentName}</div>
        </div>
        {props.mode === 'outline' && props.controller.editable && (
          <button
            type="button"
            aria-label="在当前页添加书签"
            title="在当前页添加书签"
            disabled={props.controller.totalPages < 1 || props.controller.items.length >= MAX_PDF_BOOKMARKS}
            style={{
              ...styles.addButton,
              ...(props.controller.totalPages < 1 || props.controller.items.length >= MAX_PDF_BOOKMARKS
                ? styles.locateButtonDisabled
                : {}),
            }}
            onClick={beginAddBookmark}
          >
            +
          </button>
        )}
        {props.mode === 'outline' && visibleItems.length > 0 && (
          <button
            type="button"
            aria-label="定位当前章节"
            disabled={props.controller.currentItemId === undefined}
            style={{
              ...styles.locateButton,
              ...(props.controller.currentItemId === undefined ? styles.locateButtonDisabled : {}),
            }}
            onClick={() => {
              locatePendingRef.current = true
              setLocateRequest(request => request + 1)
              props.controller.revealCurrent()
            }}
          >
            定位
          </button>
        )}
        {props.mode === 'outline' && expandableItems.length > 0 && (
          <button
            type="button"
            aria-label={allExpanded ? '收起全部目录层级' : '展开全部目录层级'}
            style={styles.allButton}
            onClick={() => { props.controller.setAllExpanded(!allExpanded) }}
          >
            {allExpanded ? '全部收起' : '全部展开'}
          </button>
        )}
      </div>
      {props.mode === 'outline' && bookmarkEditor !== undefined && (
        <form
          aria-label={bookmarkEditor.kind === 'add' ? '添加 PDF 书签' : '编辑 PDF 书签'}
          style={styles.bookmarkEditor}
          onSubmit={(event) => {
            event.preventDefault()
            commitBookmark()
          }}
        >
          <div style={styles.bookmarkEditorTitle}>
            {bookmarkEditor.kind === 'add' ? '添加书签' : '编辑书签'}
          </div>
          <input
            aria-label="书签名称"
            autoFocus
            maxLength={MAX_PDF_BOOKMARK_TITLE_LENGTH}
            value={bookmarkEditor.title}
            placeholder="书签名称"
            style={styles.bookmarkInput}
            onChange={(event) => {
              const title = event.currentTarget.value
              setBookmarkEditor(current => current === undefined ? current : { ...current, title })
            }}
          />
          <div style={styles.bookmarkFields}>
            <input
              aria-label="书签页码"
              type="number"
              min={1}
              max={props.controller.totalPages}
              value={bookmarkEditor.page}
              placeholder={bookmarkEditor.external ? '外部链接' : '页码'}
              style={styles.bookmarkInput}
              onChange={(event) => {
                const page = event.currentTarget.value
                setBookmarkEditor(current => current === undefined ? current : { ...current, page })
              }}
            />
            <BookmarkParentPicker
              value={bookmarkEditor.parentId}
              options={bookmarkParentCandidates}
              onChange={(parentId) => {
                setBookmarkEditor(current => current === undefined ? current : { ...current, parentId })
              }}
            />
          </div>
          {bookmarkEditor.external && bookmarkEditor.page === '' && (
            <div style={styles.fileName}>保留原外部链接；填写页码会改为 PDF 内部书签</div>
          )}
          {bookmarkError !== undefined && <div role="alert" style={styles.bookmarkError}>{bookmarkError}</div>}
          <div style={styles.bookmarkActions}>
            <button
              type="button"
              style={{ ...styles.bookmarkAction, marginLeft: 'auto' }}
              onClick={() => {
                setBookmarkEditor(undefined)
                setBookmarkError(undefined)
              }}
            >
              取消
            </button>
            <button type="submit" style={styles.bookmarkAction}>保存</button>
          </div>
        </form>
      )}
      {props.mode === 'outline' && <div ref={listRef} role="navigation" aria-label="PDF 目录" style={styles.list}>
        {visibleItems.length === 0 && (
          <div role="status" style={styles.searchEmpty}>
            此 PDF 还没有书签，可在当前页添加
          </div>
        )}
        {visibleItems.map(item => {
          const current = item.id === props.controller.visibleCurrentItemId
          const deleting = bookmarkDeleteTargetId === item.id
          return (
          <div key={item.id} style={styles.itemBlock}>
            <div
              data-outline-id={item.id}
              style={{
                ...styles.itemRow,
                ...(current ? styles.itemRowCurrent : {}),
                paddingLeft: `${String(item.depth * 14)}px`,
              }}
            >
              {item.hasChildren ? (
                <button
                  type="button"
                  aria-label={`${props.controller.expandedIds.has(item.id) ? '收起' : '展开'} ${item.title}`}
                  aria-expanded={props.controller.expandedIds.has(item.id)}
                  style={styles.disclosure}
                  onClick={() => { props.controller.toggleExpanded(item.id) }}
                >
                  {props.controller.expandedIds.has(item.id) ? '▾' : '▸'}
                </button>
              ) : <span aria-hidden="true" style={styles.disclosureSpacer} />}
              <button
                type="button"
                aria-current={current ? 'location' : undefined}
                disabled={!item.navigable && !item.hasChildren}
                style={{
                  ...styles.item,
                  ...(!item.navigable && !item.hasChildren ? styles.disabledItem : {}),
                  ...(current ? styles.currentItem : {}),
                }}
                onClick={() => {
                  if (item.navigable) {
                    props.controller.navigate(item.id)
                    if (props.closeAfterNavigate) props.onClose()
                  } else if (item.hasChildren) {
                    props.controller.toggleExpanded(item.id)
                  }
                }}
              >
                {item.title}
              </button>
              {props.controller.editable && (
                <div style={styles.itemActions}>
                  <button
                    type="button"
                    aria-label={`编辑书签 ${item.title}`}
                    title="编辑书签"
                    style={styles.editButton}
                    onClick={() => { beginEditBookmark(item.id) }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    aria-label={`删除书签 ${item.title}`}
                    aria-expanded={deleting}
                    title="删除书签"
                    style={{ ...styles.editButton, ...styles.deleteButton }}
                    onClick={() => {
                      setBookmarkEditor(undefined)
                      setBookmarkError(undefined)
                      setBookmarkDeleteTargetId(currentId => currentId === item.id ? undefined : item.id)
                    }}
                  >
                    <DeleteBookmarkIcon />
                  </button>
                </div>
              )}
            </div>
            {deleting && (
              <div
                role="group"
                aria-label={`确认删除书签 ${item.title}`}
                style={{
                  ...styles.bookmarkRowDeleteConfirm,
                  paddingLeft: `${String(22 + item.depth * 14)}px`,
                }}
              >
                <span title={item.title} style={styles.bookmarkDeletePrompt}>
                  {bookmarkDeleteDescendantCount === 0
                    ? `删除“${item.title}”？`
                    : `删除“${item.title}”及 ${String(bookmarkDeleteDescendantCount)} 个子书签？`}
                </span>
                <button
                  type="button"
                  style={styles.bookmarkAction}
                  onClick={() => { setBookmarkDeleteTargetId(undefined) }}
                >
                  取消
                </button>
                <button
                  type="button"
                  style={{ ...styles.bookmarkAction, ...styles.bookmarkDeleteConfirm }}
                  onClick={() => {
                    props.controller.removeBookmark(item.id)
                    setBookmarkDeleteTargetId(undefined)
                  }}
                >
                  删除
                </button>
              </div>
            )}
          </div>
          )
        })}
      </div>}
      {props.mode === 'search' && (
        <div style={styles.searchPanel}>
          <form
            role="search"
            aria-label="搜索 PDF 文字"
            style={styles.searchForm}
            onSubmit={(event) => {
              event.preventDefault()
              props.controller.search.run(searchDraft)
            }}
          >
            <input
              type="search"
              data-pdf-search-input="true"
              aria-label="PDF 搜索文字"
              maxLength={MAX_PDF_SEARCH_QUERY_LENGTH}
              value={searchDraft}
              placeholder="搜索 PDF 文字…"
              style={styles.searchInput}
              onChange={(event) => {
                const nextDraft = event.currentTarget.value
                setSearchDraft(nextDraft)
                if (isBlankPdfSearchQuery(nextDraft)) props.controller.search.clear()
              }}
              autoFocus
            />
            {props.controller.search.state.status === 'running' ? (
              <button
                type="button"
                style={styles.searchAction}
                onClick={(event) => {
                  event.preventDefault()
                  props.controller.search.cancel()
                }}
              >
                取消
              </button>
            ) : (
              <button type="submit" style={styles.searchAction}>搜索</button>
            )}
          </form>
          <PdfSearchStatus controller={props.controller} />
          <div
            ref={searchResultsRef}
            role="list"
            aria-label="PDF 搜索结果"
            style={styles.searchResults}
            onScroll={loadMoreSearchResultsIfNeeded}
          >
            {props.controller.search.state.results.map(result => (
              <div key={`${String(result.pageNumber)}:${String(result.offset)}`} role="listitem">
                <button
                  type="button"
                  style={styles.searchResult}
                  onClick={() => {
                    props.controller.search.navigate(result)
                    if (props.closeAfterNavigate) props.onClose()
                  }}
                >
                  <div style={styles.searchResultPage}>第 {result.pageNumber} 页</div>
                  <div style={styles.searchResultSnippet}>{result.snippet}</div>
                </button>
              </div>
            ))}
            <div ref={searchLoadMoreRef} aria-hidden="true" style={{ height: '1px' }} />
          </div>
        </div>
      )}
    </div>
  )
}

export function PdfOutlineSidebar(props: GlobalStandardProps & SidebarSectionOwnerProps & {
  source: PdfOutlineSource
  onClose: () => void
}) {
  const snapshot = useSyncExternalStore(props.source.subscribe, props.source.getSnapshot)
  if (!props.wide || snapshot.controller === undefined || snapshot.active === undefined) return null
  return <PdfOutlinePanel controller={snapshot.controller} mode={snapshot.active} onClose={props.onClose} />
}
