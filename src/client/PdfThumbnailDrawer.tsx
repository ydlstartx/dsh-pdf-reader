import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, UIEvent } from 'react'
import type { PDFDocumentProxy, RenderTask } from './pdfjs.ts'
import { normalizePdfRotation } from './pdf-rotation.ts'
import type { PdfPageRotation } from './pdf-rotation.ts'

const ROW_HEIGHT = 180
const OVERSCAN_ROWS = 2
const THUMBNAIL_MAX_WIDTH = 132
const THUMBNAIL_MAX_HEIGHT = 142

const styles = {
  drawer: {
    position: 'absolute',
    zIndex: 14,
    top: '12px',
    bottom: '12px',
    left: '12px',
    display: 'flex',
    flexDirection: 'column',
    width: '174px',
    overflow: 'hidden',
    border: '1px solid rgba(0,0,0,0.14)',
    borderRadius: '10px',
    background: 'rgba(255,255,255,0.97)',
    color: '#262626',
    boxShadow: '0 6px 24px rgba(0,0,0,0.2)',
    backdropFilter: 'blur(8px)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '40px',
    padding: '0 8px 0 12px',
    borderBottom: '1px solid #eee',
    fontSize: '13px',
    fontWeight: 600,
  },
  close: {
    width: '28px',
    height: '28px',
    padding: 0,
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: '#595959',
    cursor: 'pointer',
    fontSize: '19px',
    lineHeight: 1,
  },
  list: {
    position: 'relative',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
  },
  item: {
    position: 'absolute',
    left: '8px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '5px',
    width: '158px',
    height: `${String(ROW_HEIGHT - 8)}px`,
    padding: '6px',
    boxSizing: 'border-box',
    border: '1px solid transparent',
    borderRadius: '8px',
    background: 'transparent',
    color: '#595959',
    cursor: 'pointer',
  },
  canvasFrame: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: `${String(THUMBNAIL_MAX_WIDTH)}px`,
    height: `${String(THUMBNAIL_MAX_HEIGHT)}px`,
  },
  canvas: {
    display: 'block',
    maxWidth: '100%',
    maxHeight: '100%',
    background: '#fff',
    boxShadow: '0 1px 5px rgba(0,0,0,0.22)',
  },
  label: {
    fontSize: '11px',
    lineHeight: 1,
  },
} satisfies Record<string, CSSProperties>

function PdfThumbnail(props: {
  doc: PDFDocumentProxy
  pageNumber: number
  rotation: PdfPageRotation
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let disposed = false
    let renderTask: RenderTask | undefined
    void (async () => {
      let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | undefined
      try {
        page = await props.doc.getPage(props.pageNumber)
        if (disposed) return
        const rotation = normalizePdfRotation(page.rotate + props.rotation)
        const natural = page.getViewport({ scale: 1, rotation })
        const cssScale = Math.min(
          THUMBNAIL_MAX_WIDTH / natural.width,
          THUMBNAIL_MAX_HEIGHT / natural.height,
        )
        const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
        const viewport = page.getViewport({ scale: cssScale * pixelRatio, rotation })
        const canvas = canvasRef.current
        if (canvas === null) return
        canvas.width = Math.max(1, Math.floor(viewport.width))
        canvas.height = Math.max(1, Math.floor(viewport.height))
        canvas.style.width = `${String(viewport.width / pixelRatio)}px`
        canvas.style.height = `${String(viewport.height / pixelRatio)}px`
        const context = canvas.getContext('2d')
        if (context === null) return
        renderTask = page.render({ canvasContext: context, viewport, canvas })
        await renderTask.promise
      } catch {
        // Cancellation and a single malformed page leave an empty thumbnail;
        // navigation remains available for every other page.
      } finally {
        // Thumbnail rows are virtualized, so scrolling a long document can
        // visit hundreds of page proxies. Release decoded operator/image data
        // after every completed or cancelled thumbnail render.
        page?.cleanup()
      }
    })()
    return () => {
      disposed = true
      renderTask?.cancel()
      const canvas = canvasRef.current
      if (canvas !== null) {
        canvas.width = 1
        canvas.height = 1
      }
    }
  }, [props.doc, props.pageNumber, props.rotation])

  return <canvas ref={canvasRef} data-pdf-thumbnail-canvas="true" style={styles.canvas} />
}

export function PdfThumbnailDrawer(props: {
  doc: PDFDocumentProxy
  currentPage: number
  documentRotation: PdfPageRotation
  pageRotations: Readonly<Record<number, PdfPageRotation>>
  onNavigate: (pageNumber: number) => void
  onClose: () => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(480)
  const visiblePages = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS)
    const end = Math.min(
      props.doc.numPages,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN_ROWS,
    )
    return Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset + 1)
  }, [props.doc.numPages, scrollTop, viewportHeight])

  useLayoutEffect(() => {
    const list = listRef.current
    if (list === null) return
    const update = (): void => { setViewportHeight(list.clientHeight) }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(list)
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    const list = listRef.current
    if (list === null) return
    const top = (props.currentPage - 1) * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - (list.clientHeight - ROW_HEIGHT) / 2)
      setScrollTop(list.scrollTop)
    }
  }, [props.currentPage])

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    setScrollTop(event.currentTarget.scrollTop)
  }

  return (
    <aside data-pdf-thumbnail-drawer="true" aria-label="PDF 页面缩略图" style={styles.drawer}>
      <div style={styles.header}>
        <span>页面 · {props.doc.numPages}</span>
        <button type="button" aria-label="关闭缩略图" style={styles.close} onClick={props.onClose}>×</button>
      </div>
      <div ref={listRef} data-pdf-thumbnail-list="true" style={styles.list} onScroll={onScroll}>
        <div style={{ position: 'relative', height: `${String(props.doc.numPages * ROW_HEIGHT)}px` }}>
          {visiblePages.map(pageNumber => {
            const rotation = normalizePdfRotation(
              props.documentRotation + (props.pageRotations[pageNumber] ?? 0),
            )
            const current = pageNumber === props.currentPage
            return (
              <button
                key={pageNumber}
                type="button"
                data-pdf-thumbnail-page={String(pageNumber)}
                aria-label={`跳转到第 ${String(pageNumber)} 页`}
                aria-current={current ? 'page' : undefined}
                style={{
                  ...styles.item,
                  top: `${String((pageNumber - 1) * ROW_HEIGHT + 4)}px`,
                  borderColor: current ? '#4d6bfe' : 'transparent',
                  background: current ? 'rgba(77,107,254,0.08)' : 'transparent',
                  color: current ? '#3154d8' : '#595959',
                }}
                onClick={() => { props.onNavigate(pageNumber) }}
              >
                <span style={styles.canvasFrame}>
                  <PdfThumbnail doc={props.doc} pageNumber={pageNumber} rotation={rotation} />
                </span>
                <span style={styles.label}>{pageNumber}</span>
              </button>
            )
          })}
        </div>
      </div>
    </aside>
  )
}
