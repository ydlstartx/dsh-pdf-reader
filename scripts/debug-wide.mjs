/**
 * Debug driver for the dsh-pdf-reader wide-mode layout. Launches Chromium
 * against the running Web GUI, opens the reader with the test fixture, enters
 * wide mode, and dumps the geometry that decides the
 * [sidebar][pdf panel][conversation] order. Screenshots land next to this
 * script for visual inspection.
 *
 * Usage: node scripts/debug-wide.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'

const defaultHarnessRoot = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), 'deepseek-harness')
const harnessRoot = process.env['DSH_ROOT'] ?? defaultHarnessRoot
const require = createRequire(join(harnessRoot, 'apps', 'web', 'package.json'))
const { chromium } = require('playwright')

const HERE = dirname(fileURLToPath(import.meta.url))
const PDF_PATH = process.env['PDF_PATH'] ?? join(HERE, '..', 'test-fixtures', 'test.pdf')
const PDF_NAME = basename(PDF_PATH)
const BASE = 'http://127.0.0.1:3080'

const geometry = `(() => {
  const f = document.querySelector('div[style*="grid-template-columns"]')
  if (!f) return { error: 'frame not found' }
  const rect = (el) => el ? { x: Math.round(el.getBoundingClientRect().left), w: Math.round(el.getBoundingClientRect().width) } : null
  const panels = [...document.querySelectorAll('body > div')].filter((el) => getComputedStyle(el).position === 'fixed')
  return {
    innerWidth: window.innerWidth,
    frame: { marginLeft: f.style.marginLeft, ...rect(f) },
    sidebarCol: {
      position: f.firstElementChild.style.position || '',
      left: f.firstElementChild.style.left || '',
      transform: f.firstElementChild.style.transform || '',
      ...rect(f.firstElementChild),
    },
    sidebarContent: f.firstElementChild.firstElementChild ? { class: f.firstElementChild.firstElementChild.className.slice(0, 40), ...rect(f.firstElementChild.firstElementChild) } : null,
    portalPanels: panels.map((el) => ({ left: el.style.left, width: el.style.width, ...rect(el) })),
  }
})()`

const run = async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
  page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 300)))
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.startsWith('PROBE') || text.startsWith('DEEP')) console.log(text)
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // Pick the first persisted session in the sidebar so a Session is on
  // screen. The first tree item is the workspace group itself.
  await page.waitForTimeout(2000)
  const sessionRows = page.getByRole('treeitem')
  if (await sessionRows.count() > 1) {
    let persistedIndex = 1
    for (let index = 1; index < await sessionRows.count(); index += 1) {
      const text = (await sessionRows.nth(index).textContent())?.trim() ?? ''
      if (!/^(New Session|新会话)$/.test(text)) {
        persistedIndex = index
        break
      }
    }
    await sessionRows.nth(persistedIndex).click()
  }
  await page.waitForTimeout(1500)

  // The reader page is created by the floating entry, so the hidden picker
  // exists only after opening it.
  const pdfEntry = page.locator('button[aria-label*="PDF"], button[title*="PDF"]')
  if (await page.locator('input[type="file"][accept*=".pdf"]').count() === 0) {
    await pdfEntry.first().click()
    await page.waitForTimeout(1500)
  }

  // Feed the hidden native picker input directly; chooser dialogs are not
  // consistently emitted by every headless Chrome build.
  await page.locator('input[type="file"]').setInputFiles(PDF_PATH)
  await page.waitForSelector('div[data-page="1"]', { timeout: 15000 })
  await page.waitForTimeout(1500)

  // The same chooser remains reachable from the reader toolbar; choosing
  // appends a tab without first discarding the old PDF.
  await page.locator('input[type="file"]').setInputFiles(PDF_PATH)
  await page.waitForSelector('div[data-page="1"]', { timeout: 15000 })
  const tabsAfterSecondOpen = page.locator('[data-pdf-document-tab]')
  if (await tabsAfterSecondOpen.count() !== 2) {
    throw new Error(`Opening another PDF did not append a tab: ${String(await tabsAfterSecondOpen.count())}`)
  }
  await tabsAfterSecondOpen.first().click()
  await page.waitForSelector('div[data-page="1"]', { timeout: 15000 })
  await tabsAfterSecondOpen.last().click()
  await page.waitForSelector('div[data-page="1"]', { timeout: 15000 })
  await page.waitForFunction(() => {
    const first = document.querySelector('div[data-page="1"] canvas')
    return first instanceof HTMLCanvasElement && first.width > 0 && first.height > 0
  }, { timeout: 15000 })
  await page.waitForTimeout(500)

  // DOM page views and pdf.js canvases are both constrained to current ±2;
  // the complete document exists only as one numeric geometry array and one
  // scroll-overflow box.
  const pageResources = await page.evaluate(() => ({
    slots: document.querySelectorAll('div[data-page]').length,
    canvases: document.querySelectorAll('div[data-page] canvas').length,
  }))
  if (pageResources.slots > 5 || pageResources.canvases > 5) {
    throw new Error(`PDF page window exceeded its bound: ${JSON.stringify(pageResources)}`)
  }
  console.log('=== page resources ===')
  console.log(JSON.stringify(pageResources))

  // Rotation is view-only but cross-cuts geometry, canvas paint and bounded
  // page-window reuse. Exercise current-page and all-page paths, then reset
  // so the remaining coordinate-sensitive regression continues unchanged.
  const openRotationMenu = async () => {
    await page.locator('[data-pdf-rotation-menu-button="true"]').click()
    await page.locator('[data-pdf-rotation-menu="true"]').waitFor({ state: 'visible' })
  }
  const originalPageOneAspect = await page.locator('div[data-page="1"] canvas').evaluate((canvas) => (
    canvas.width / canvas.height
  ))
  await openRotationMenu()
  await page.locator('[data-pdf-rotate-current-right="true"]').click()
  await page.waitForFunction(() => {
    const pageOne = document.querySelector('div[data-page="1"]')
    const canvas = pageOne?.querySelector('canvas')
    return pageOne?.dataset['pdfRotation'] === '90'
      && canvas instanceof HTMLCanvasElement
      && canvas.dataset['pdfRotation'] === '90'
      && canvas.width > 1
  }, { timeout: 15000 })
  const rotatedPageOneAspect = await page.locator('div[data-page="1"] canvas').evaluate((canvas) => (
    canvas.width / canvas.height
  ))
  if ((originalPageOneAspect - 1) * (rotatedPageOneAspect - 1) >= 0) {
    throw new Error(`PDF canvas axes did not rotate: ${JSON.stringify({ originalPageOneAspect, rotatedPageOneAspect })}`)
  }
  await openRotationMenu()
  await page.locator('[data-pdf-reset-current-rotation="true"]').click()
  await page.waitForFunction(() => document.querySelector('div[data-page="1"]')?.dataset['pdfRotation'] === '0')

  await openRotationMenu()
  await page.locator('[data-pdf-rotate-all-right="true"]').click()
  await page.waitForFunction(() => [1, 2].every((pageNumber) => {
    const pageElement = document.querySelector(`div[data-page="${String(pageNumber)}"]`)
    const canvas = pageElement?.querySelector('canvas')
    return pageElement?.dataset['pdfRotation'] === '90'
      && canvas instanceof HTMLCanvasElement
      && canvas.dataset['pdfRotation'] === '90'
      && canvas.width > 1
  }), { timeout: 15000 })
  await openRotationMenu()
  await page.locator('[data-pdf-reset-all-rotation="true"]').click()
  await page.waitForFunction(() => [1, 2].every((pageNumber) =>
    document.querySelector(`div[data-page="${String(pageNumber)}"]`)?.dataset['pdfRotation'] === '0'))
  console.log('=== PDF view rotation ===')
  console.log(JSON.stringify({
    currentPage: true,
    allPages: true,
    reset: true,
    sourceModified: false,
    originalPageOneAspect,
    rotatedPageOneAspect,
  }))

  // Fit-page keeps every page inside one viewport; fit-width restores the
  // original edge-to-edge reading scale. Both choices reset relative zoom.
  const openFitMenu = async () => {
    const viewport = await page.locator('[data-pdf-viewport]').boundingBox()
    if (viewport === null) throw new Error('Missing PDF viewport before fit-menu test')
    await page.mouse.move(viewport.x + viewport.width - 20, viewport.y + viewport.height - 20)
    await page.waitForFunction(() => document.querySelector('[data-pdf-zoom-controls]')?.getAttribute('data-visible') === 'true')
    await page.locator('[data-pdf-fit-menu-button="true"]').click()
    await page.locator('[data-pdf-fit-menu="true"]').waitFor({ state: 'visible' })
  }
  await openFitMenu()
  await page.locator('[data-pdf-fit-page="true"]').click()
  await page.waitForFunction(() => document.querySelector('[data-pdf-scroll]')?.getAttribute('data-pdf-fit-mode') === 'page')
  const fitPageGeometry = await page.evaluate(() => {
    const scroller = document.querySelector('[data-pdf-scroll]')
    const firstPage = document.querySelector('div[data-page="1"]')
    if (!(scroller instanceof HTMLElement) || !(firstPage instanceof HTMLElement)) return null
    const rect = firstPage.getBoundingClientRect()
    return { pageWidth: rect.width, pageHeight: rect.height, viewportWidth: scroller.clientWidth, viewportHeight: scroller.clientHeight }
  })
  if (fitPageGeometry === null
    || fitPageGeometry.pageWidth > fitPageGeometry.viewportWidth + 1
    || fitPageGeometry.pageHeight > fitPageGeometry.viewportHeight + 1) {
    throw new Error(`Fit-page overflowed its viewport: ${JSON.stringify(fitPageGeometry)}`)
  }
  await openFitMenu()
  await page.locator('[data-pdf-fit-width="true"]').click()
  await page.waitForFunction(() => document.querySelector('[data-pdf-scroll]')?.getAttribute('data-pdf-fit-mode') === 'width')
  const fitWidthGeometry = await page.evaluate(() => {
    const scroller = document.querySelector('[data-pdf-scroll]')
    const firstPage = document.querySelector('div[data-page="1"]')
    if (!(scroller instanceof HTMLElement) || !(firstPage instanceof HTMLElement)) return null
    return { pageWidth: firstPage.getBoundingClientRect().width, viewportWidth: scroller.clientWidth }
  })
  if (fitWidthGeometry === null || Math.abs(fitWidthGeometry.pageWidth - fitWidthGeometry.viewportWidth) > 2) {
    throw new Error(`Fit-width did not fill its viewport: ${JSON.stringify(fitWidthGeometry)}`)
  }
  console.log('=== PDF fit modes ===')
  console.log(JSON.stringify({ fitPageGeometry, fitWidthGeometry }))

  // The page rail virtualizes a fixed-height row list: opening and scrolling
  // to the end must never mount a document-sized canvas tree.
  await page.locator('[data-pdf-thumbnails-button="true"]').click()
  const thumbnailDrawer = page.locator('[data-pdf-thumbnail-drawer="true"]')
  await thumbnailDrawer.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const canvas = document.querySelector('[data-pdf-thumbnail-canvas="true"]')
    return canvas instanceof HTMLCanvasElement && canvas.width > 1 && canvas.height > 1
  }, { timeout: 15000 })
  const thumbnailList = page.locator('[data-pdf-thumbnail-list="true"]')
  const initialThumbnailRows = await thumbnailDrawer.locator('[data-pdf-thumbnail-page]').count()
  await thumbnailList.evaluate(element => { element.scrollTop = element.scrollHeight })
  await page.waitForTimeout(300)
  const finalThumbnail = thumbnailDrawer.locator('[data-pdf-thumbnail-page]').last()
  const finalThumbnailPage = Number(await finalThumbnail.getAttribute('data-pdf-thumbnail-page'))
  const finalThumbnailRows = await thumbnailDrawer.locator('[data-pdf-thumbnail-page]').count()
  if (initialThumbnailRows > 10 || finalThumbnailRows > 10 || !Number.isInteger(finalThumbnailPage)) {
    throw new Error(`PDF thumbnail window exceeded its bound: ${JSON.stringify({ initialThumbnailRows, finalThumbnailRows, finalThumbnailPage })}`)
  }
  await finalThumbnail.click()
  await page.waitForFunction((target) =>
    document.querySelector('[title="点击输入页码跳转"]')?.textContent?.startsWith(`${String(target)} /`) === true,
  finalThumbnailPage)
  await page.screenshot({ path: join(HERE, 'shot-thumbnails.png') })
  await thumbnailList.evaluate(element => { element.scrollTop = 0 })
  await page.locator('[data-pdf-thumbnail-page="1"]').click()
  await page.waitForFunction(() => document.querySelector('[title="点击输入页码跳转"]')?.textContent?.startsWith('1 /') === true)
  await thumbnailDrawer.getByRole('button', { name: '关闭缩略图', exact: true }).click()
  await thumbnailDrawer.waitFor({ state: 'detached' })
  console.log('=== PDF thumbnails ===')
  console.log(JSON.stringify({ initialThumbnailRows, finalThumbnailRows, finalThumbnailPage, bounded: true }))

  const big = process.env['BIG'] === '1'
  const nestedOutline = process.env['NESTED_OUTLINE'] === '1'
  // Search and directory are stable footer actions for every parsed PDF.
  // A document without embedded bookmarks gets an explicit empty state.
  const searchAction = page.getByRole('button', { name: 'PDF 搜索', exact: true })
  const outlineAction = page.getByRole('button', { name: 'PDF 目录', exact: true })
  await searchAction.waitFor({ state: 'visible', timeout: 15000 })
  await outlineAction.waitFor({ state: 'visible', timeout: 15000 })
  const searchActionBox = await searchAction.boundingBox()
  const outlineActionBox = await outlineAction.boundingBox()
  if (searchActionBox === null || outlineActionBox === null || searchActionBox.y >= outlineActionBox.y) {
    throw new Error(`PDF search action was not above outline: ${JSON.stringify({ searchActionBox, outlineActionBox })}`)
  }
  if (!big) {
    await searchAction.click()
    await page.getByRole('search', { name: '搜索 PDF 文字', exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '返回会话列表', exact: true }).click()
    await searchAction.waitFor({ state: 'visible', timeout: 5000 })
    await page.waitForTimeout(400)
    await outlineAction.click()
    const emptyOutline = page.getByRole('navigation', { name: 'PDF 目录', exact: true })
    await emptyOutline.waitFor({ state: 'visible', timeout: 5000 })
    await emptyOutline.getByRole('status').filter({ hasText: '此 PDF 没有内置目录书签' })
      .waitFor({ state: 'visible', timeout: 5000 })
    await page.screenshot({ path: join(HERE, 'shot-outline-empty.png') })
    await page.getByRole('button', { name: '返回会话列表', exact: true }).click()
    await emptyOutline.waitFor({ state: 'detached', timeout: 5000 })
    await outlineAction.waitFor({ state: 'visible', timeout: 5000 })
    await page.waitForTimeout(400)
  }
  if (big) {
    // A real bookmarked document exposes a populated directory action. Opening
    // it temporarily swaps only the workspace seat; leaving it must restore
    // Harness's original sidebar and the reader must land directly on the
    // bookmark destination rather than stepping through intermediate pages.
    const readerViewportWidth = () => page.evaluate(() =>
      document.querySelector('[data-pdf-scroll]')?.clientWidth ?? -1)
    const readOutlineMotion = () => page.evaluate(() => {
      const frame = document.querySelector('div[style*="grid-template-columns"]')
      const sidebar = frame?.firstElementChild?.getBoundingClientRect()
      let panel = document.querySelector('div[data-page]')?.parentElement
      while (panel instanceof HTMLElement && getComputedStyle(panel).position !== 'fixed') panel = panel.parentElement
      const panelBox = panel?.getBoundingClientRect()
      const viewportWidth = document.querySelector('[data-pdf-scroll]')?.clientWidth ?? -1
      return {
        gap: sidebar === undefined || panelBox === undefined ? 999 : Math.round(panelBox.left - sidebar.right),
        viewportWidth,
        panelLeft: panel instanceof HTMLElement ? panel.style.left : '',
        panelTransform: panel instanceof HTMLElement ? panel.style.transform : '',
      }
    })
    const widthBeforeOutline = await readerViewportWidth()
    const openedAt = Date.now()
    await outlineAction.click()
    const outline = page.getByRole('navigation', { name: 'PDF 目录', exact: true })
    await outline.waitFor({ state: 'visible', timeout: 5000 })
    const openMs = Date.now() - openedAt
    const outlineMotion = []
    for (let i = 0; i < 6; i += 1) {
      outlineMotion.push(await readOutlineMotion())
      await page.waitForTimeout(50)
    }
    const finalOutlineMotion = outlineMotion.at(-1)
    if (outlineMotion.some(sample => sample.viewportWidth !== widthBeforeOutline)
      || !outlineMotion.some(sample => sample.panelTransform.startsWith('translate3d('))
      || finalOutlineMotion === undefined || Math.abs(finalOutlineMotion.gap) > 4) {
      throw new Error(`PDF reader did not follow the sidebar smoothly: ${JSON.stringify(outlineMotion)}`)
    }
    await page.waitForTimeout(500)
    const widthWithOutline = await readerViewportWidth()
    if (Math.abs(widthWithOutline - widthBeforeOutline) > 1) {
      throw new Error(`Opening PDF outline resized the reader: ${JSON.stringify({ widthBeforeOutline, widthWithOutline })}`)
    }
    if (nestedOutline) {
      const chapter = /^第1章.*Python数据模型$/
      const firstChild = /^1\.1.*一摞Python风格的纸牌$/
      const grandchild = /^1\.2\.1.*模拟数值类型$/
      if (await page.getByRole('button', { name: firstChild }).count() !== 0) {
        throw new Error('Nested PDF outline did not start collapsed')
      }
      await page.getByRole('button', { name: /展开 第1章.*Python数据模型/ }).click()
      await page.getByRole('button', { name: firstChild }).waitFor({ state: 'visible' })

      // Closing only the directory must not discard this document's view
      // state. Reopening should show the same branch expanded.
      await page.getByRole('button', { name: '返回会话列表', exact: true }).click()
      await outline.waitFor({ state: 'detached', timeout: 5000 })
      await page.waitForTimeout(400)
      await outlineAction.click()
      await outline.waitFor({ state: 'visible', timeout: 5000 })
      await page.getByRole('button', { name: firstChild }).waitFor({ state: 'visible' })

      await page.getByRole('button', { name: '展开全部目录层级', exact: true }).click()
      await page.getByRole('button', { name: grandchild }).waitFor({ state: 'visible' })
      await page.locator('button', { hasText: '全部收起' }).waitFor({ state: 'visible' })

      // A bookmark jump updates the current-section highlight. Collapsing the
      // tree leaves only its nearest visible ancestor highlighted; explicit
      // locate reveals the path and centers the real current row again.
      await page.getByRole('button', { name: grandchild }).click()
      await page.waitForFunction(() =>
        document.querySelector('button[aria-current="location"]')?.textContent?.includes('1.2.1') === true)
      await page.getByRole('button', { name: '收起全部目录层级', exact: true }).click()
      if (await page.getByRole('button', { name: grandchild }).count() !== 0) {
        throw new Error('Collapsing the outline did not hide the current nested entry')
      }
      const collapsedCurrent = await page.locator('button[aria-current="location"]').textContent()
      if (!collapsedCurrent?.includes('第1章')) {
        throw new Error(`Collapsed current outline did not fall back to its visible ancestor: ${String(collapsedCurrent)}`)
      }
      await page.getByRole('button', { name: '定位当前章节', exact: true }).click()
      const revealedCurrent = page.getByRole('button', { name: grandchild })
      await revealedCurrent.waitFor({ state: 'visible', timeout: 5000 })
      if (await revealedCurrent.getAttribute('aria-current') !== 'location') {
        throw new Error('Locate current section did not reveal the highlighted outline entry')
      }
      const currentBox = await revealedCurrent.boundingBox()
      const outlineBox = await outline.boundingBox()
      if (currentBox === null || outlineBox === null
        || currentBox.top < outlineBox.top || currentBox.bottom > outlineBox.bottom) {
        throw new Error(`Located outline row was not scrolled into view: ${JSON.stringify({ currentBox, outlineBox })}`)
      }
      await page.screenshot({ path: join(HERE, 'shot-outline.png') })

      // The explicitly located branch survives another close/open roundtrip;
      // unrelated branches remain collapsed rather than being auto-expanded.
      await page.getByRole('button', { name: '返回会话列表', exact: true }).click()
      await outline.waitFor({ state: 'detached', timeout: 5000 })
      await page.waitForTimeout(400)
      await outlineAction.click()
      await outline.waitFor({ state: 'visible', timeout: 5000 })
      await page.getByRole('button', { name: grandchild }).waitFor({ state: 'visible' })
      await page.locator('button', { hasText: '全部展开' }).waitFor({ state: 'visible' })
      await page.getByRole('button', { name: chapter }).waitFor({ state: 'visible' })

      // Hiding the reader retains its PdfViewer instance; reopening the same
      // PDF must therefore publish the same expanded branch set again.
      await page.getByRole('button', { name: '返回会话列表', exact: true }).click()
      await outline.waitFor({ state: 'detached', timeout: 5000 })
      await page.waitForTimeout(400)
      const nestedPdfToggle = page.getByRole('button', { name: '显示或收起 PDF 阅读器', exact: true })
      await nestedPdfToggle.click()
      await page.waitForTimeout(100)
      await nestedPdfToggle.click()
      await outlineAction.waitFor({ state: 'visible', timeout: 5000 })
      await page.waitForTimeout(400)
      await outlineAction.click()
      await outline.waitFor({ state: 'visible', timeout: 5000 })
      await page.getByRole('button', { name: grandchild }).waitFor({ state: 'visible' })
      await page.waitForTimeout(400)

      // Search shares the same bounded navigation surface. Cancellation must
      // interrupt an in-flight document scan; a completed native-text query
      // returns snippets and one result click jumps directly to that page.
      await searchAction.click()
      const searchForm = page.getByRole('search', { name: '搜索 PDF 文字', exact: true })
      const searchInput = searchForm.getByRole('searchbox', { name: 'PDF 搜索文字', exact: true })
      await searchInput.fill('这段文字绝不会存在于本书中')
      await searchInput.press('Enter')
      const cancelSearch = searchForm.getByRole('button', { name: '取消', exact: true })
      await cancelSearch.waitFor({ state: 'visible', timeout: 5000 })
      await cancelSearch.click()
      await page.locator('[role="status"]', { hasText: '已取消' }).waitFor({ state: 'visible', timeout: 5000 })

      await searchInput.fill('Python')
      await searchInput.press('Enter')
      const completedSearchStatus = searchForm.locator('..').locator('[role="status"]')
        .filter({ hasText: /^(已加载|找到)/ })
      await completedSearchStatus.waitFor({ state: 'visible', timeout: 30000 })
      const searchResults = page.getByRole('list', { name: 'PDF 搜索结果', exact: true })
      const firstBatchCount = await searchResults.getByRole('button').count()
      if ((await completedSearchStatus.textContent())?.startsWith('已加载') === true) {
        await searchResults.evaluate(element => { element.scrollTop = element.scrollHeight })
        await page.waitForFunction((count) =>
          document.querySelectorAll('[aria-label="PDF 搜索结果"] [role="listitem"] button').length > count,
        firstBatchCount, { timeout: 30000 })
      }
      const firstSearchResult = searchResults.getByRole('button').first()
      await firstSearchResult.waitFor({ state: 'visible', timeout: 30000 })
      const resultLabel = await firstSearchResult.textContent()
      const resultPage = Number(resultLabel?.match(/第\s*(\d+)\s*页/)?.[1])
      if (!Number.isInteger(resultPage)) throw new Error(`PDF search result had no page: ${String(resultLabel)}`)
      await firstSearchResult.click()
      await page.waitForFunction((target) =>
        document.querySelector('[title="点击输入页码跳转"]')?.textContent?.startsWith(`${String(target)} /`) === true,
      resultPage)
      await page.waitForFunction((target) => {
        const canvas = document.querySelector(`div[data-page="${String(target)}"] canvas`)
        return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0
      }, resultPage)
      await page.waitForSelector('[data-pdf-search-highlight="true"]', { timeout: 10000 })
      await page.screenshot({ path: join(HERE, 'shot-search.png') })
      await searchInput.fill('')
      await page.waitForFunction(() =>
        document.querySelectorAll('[aria-label="PDF 搜索结果"] [role="listitem"] button').length === 0
        && document.querySelector('[data-pdf-search-highlight="true"]') === null,
      )
      await searchForm.locator('..').locator('[role="status"]')
        .filter({ hasText: '仅搜索 PDF 自带文字；扫描图片不包含在内' })
        .waitFor({ state: 'visible', timeout: 5000 })
    } else {
      await page.getByRole('button', { name: '第1章 信号与系统', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('[title="点击输入页码跳转"]')?.textContent?.startsWith('25 /'))
      await page.screenshot({ path: join(HERE, 'shot-outline.png') })
    }
    await page.getByRole('button', { name: '返回会话列表', exact: true }).click()
    await outline.waitFor({ state: 'detached', timeout: 5000 })
    const closeMotion = []
    for (let i = 0; i < 6; i += 1) {
      closeMotion.push(await readOutlineMotion())
      await page.waitForTimeout(50)
    }
    const finalCloseMotion = closeMotion.at(-1)
    if (closeMotion.some(sample => sample.viewportWidth !== widthBeforeOutline)
      || !closeMotion.some(sample => sample.panelTransform.startsWith('translate3d('))
      || finalCloseMotion === undefined || Math.abs(finalCloseMotion.gap) > 4) {
      throw new Error(`PDF reader did not close with compositor motion: ${JSON.stringify(closeMotion)}`)
    }
    await outlineAction.waitFor({ state: 'visible', timeout: 5000 })
    await page.waitForTimeout(500)
    const widthAfterOutline = await readerViewportWidth()
    if (Math.abs(widthAfterOutline - widthBeforeOutline) > 1) {
      throw new Error(`Closing PDF outline resized the reader: ${JSON.stringify({ widthBeforeOutline, widthAfterOutline })}`)
    }
    console.log('=== PDF outline ===')
    console.log(JSON.stringify({
      destination: nestedOutline ? undefined : 25,
      nestedOutline,
      restored: true,
      currentTracking: nestedOutline,
      textSearch: nestedOutline,
      openMs,
      readerWidths: [widthBeforeOutline, widthWithOutline, widthAfterOutline],
      openMotion: outlineMotion,
      closeMotion,
    }))

    // Settings is a fixed full-viewport descendant of the sidebar. The
    // reader's docking offset must not turn that sidebar into its containing
    // block or the 800px dialog collapses into a vertical strip.
    // The collapsed Settings trigger currently has icon-only content and no
    // accessible name; it is the first dialog trigger in shell DOM order.
    const settingsTrigger = page.locator('button[aria-haspopup="dialog"]').first()
    await settingsTrigger.click()
    const settingsDialog = page.getByRole('dialog')
    await settingsDialog.waitFor({ state: 'visible', timeout: 5000 })
    const settingsBox = await settingsDialog.boundingBox()
    if (settingsBox === null || settingsBox.width < 700) {
      throw new Error(`Settings dialog was constrained by the PDF sidebar offset: ${JSON.stringify(settingsBox)}`)
    }
    await page.screenshot({ path: join(HERE, 'shot-settings.png') })
    await settingsDialog.getByRole('button', { name: /关闭|Close/ }).click()
    await settingsDialog.waitFor({ state: 'detached', timeout: 5000 })
    console.log('=== Settings with PDF ===')
    console.log(JSON.stringify(settingsBox))
  }

  // The reader window opened on load: sample the geometry through the settle.
  console.log('=== pre-wide geometry ===')
  console.log(JSON.stringify(await page.evaluate(geometry), null, 2))
  for (let i = 0; i < 6; i += 1) {
    await page.waitForTimeout(400)
    console.log(`=== wide geometry t=${String((i + 1) * 400)}ms ===`)
    console.log(JSON.stringify(await page.evaluate(geometry), null, 2))
  }
  await page.screenshot({ path: join(HERE, 'shot-wide.png') })

  // Reading controls live inside the PDF viewport: navigation is stacked in
  // the lower-left corner and zoom plus fit mode share one lower-right group.
  // The percentage itself is the reset action, avoiding a duplicate icon.
  const cornerControls = await page.evaluate(() => {
    const viewport = document.querySelector('[data-pdf-viewport]')?.getBoundingClientRect()
    const navigation = document.querySelector('[data-pdf-navigation-controls]')?.getBoundingClientRect()
    const history = document.querySelector('[data-pdf-history-controls]')?.getBoundingClientRect()
    const pageControl = document.querySelector('[data-pdf-page-control]')?.getBoundingClientRect()
    const zoomControl = document.querySelector('[data-pdf-zoom-controls]')
    const zoom = zoomControl?.getBoundingClientRect()
    const resetZoom = document.querySelector('[data-pdf-zoom-controls] button[data-pdf-reset-zoom="true"]')
    const documentToolbar = document.querySelector('[data-pdf-document-toolbar]')
    const documentName = documentToolbar?.querySelector('[data-pdf-document-name="true"]')
    const replacePdf = documentToolbar?.querySelector('button[aria-label="打开另一份 PDF"]')
    const collapsePdf = documentToolbar?.querySelector('button[aria-label="收起 PDF 阅读器"]')
    const fitMode = document.querySelector('[data-pdf-fit-menu-button="true"]')
    if (viewport === undefined || navigation === undefined || history === undefined || pageControl === undefined || zoom === undefined) return null
    return {
      navigationLeft: Math.round(navigation.left - viewport.left),
      navigationBottom: Math.round(viewport.bottom - navigation.bottom),
      historyAbovePage: history.bottom < pageControl.top,
      zoomRight: Math.round(viewport.right - zoom.right),
      zoomBottom: Math.round(viewport.bottom - zoom.bottom),
      percentageResetsZoom: resetZoom?.textContent?.trim().endsWith('%') === true,
      documentNamed: (documentName?.textContent?.trim().length ?? 0) > 0,
      replacePdfIconOnly: replacePdf?.textContent?.trim() === '',
      collapsePdfIconOnly: collapsePdf?.textContent?.trim() === '',
      fitModeBesideZoom: zoomControl !== null && fitMode !== null && zoomControl.contains(fitMode),
      fitModeOutsideToolbar: documentToolbar?.contains(fitMode) === false,
      readingControlsInToolbar: documentToolbar?.querySelector('[aria-label="缩小"], [aria-label="放大"], [title="点击输入页码跳转"]') !== null,
    }
  })
  if (cornerControls === null
    || Math.abs(cornerControls.navigationLeft - 12) > 1
    || Math.abs(cornerControls.navigationBottom - 12) > 1
    || !cornerControls.historyAbovePage
    || Math.abs(cornerControls.zoomRight - 12) > 1
    || Math.abs(cornerControls.zoomBottom - 12) > 1
    || !cornerControls.percentageResetsZoom
    || !cornerControls.documentNamed
    || !cornerControls.replacePdfIconOnly
    || !cornerControls.collapsePdfIconOnly
    || !cornerControls.fitModeBesideZoom
    || !cornerControls.fitModeOutsideToolbar
    || cornerControls.readingControlsInToolbar) {
    throw new Error(`PDF corner controls are misplaced: ${JSON.stringify(cornerControls)}`)
  }
  console.log('=== PDF corner controls ===')
  console.log(JSON.stringify(cornerControls))

  const readCornerVisibility = () => page.evaluate(() => {
    const read = (selector) => {
      const element = document.querySelector(selector)
      return element instanceof HTMLElement
        ? { visible: element.dataset.visible, opacity: getComputedStyle(element).opacity, pointerEvents: getComputedStyle(element).pointerEvents }
        : null
    }
    return {
      navigation: read('[data-pdf-navigation-controls]'),
      zoom: read('[data-pdf-zoom-controls]'),
    }
  })
  const hoverCornerControl = async (selector) => {
    const box = await page.locator(selector).boundingBox()
    if (box === null) throw new Error(`Missing corner control: ${selector}`)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(220)
  }
  const hoverNavigationControls = () => hoverCornerControl('[data-pdf-navigation-controls]')
  const hoverZoomControls = () => hoverCornerControl('[data-pdf-zoom-controls]')
  const viewportBox = await page.locator('[data-pdf-viewport]').boundingBox()
  if (viewportBox === null) throw new Error('Missing PDF viewport')
  const initiallyHidden = await readCornerVisibility()
  if (initiallyHidden.navigation?.visible !== 'false' || initiallyHidden.zoom?.visible !== 'false'
    || initiallyHidden.navigation.pointerEvents !== 'none' || initiallyHidden.zoom.pointerEvents !== 'none') {
    throw new Error(`PDF corner controls did not start hidden: ${JSON.stringify(initiallyHidden)}`)
  }
  await hoverNavigationControls()
  const navigationHovered = await readCornerVisibility()
  if (navigationHovered.navigation?.visible !== 'true' || navigationHovered.zoom?.visible !== 'false') {
    throw new Error(`PDF navigation hover reveal failed: ${JSON.stringify(navigationHovered)}`)
  }
  await page.mouse.move(viewportBox.x + viewportBox.width / 2, viewportBox.y + viewportBox.height / 2)
  await page.waitForTimeout(300)
  const navigationGrace = await readCornerVisibility()
  if (navigationGrace.navigation?.visible !== 'true') {
    throw new Error(`PDF navigation control skipped its hide delay: ${JSON.stringify(navigationGrace)}`)
  }
  await page.waitForTimeout(450)
  const navigationHidden = await readCornerVisibility()
  if (navigationHidden.navigation?.visible !== 'false' || navigationHidden.navigation.pointerEvents !== 'none') {
    throw new Error(`PDF navigation control did not hide: ${JSON.stringify(navigationHidden)}`)
  }
  await hoverZoomControls()
  const zoomHovered = await readCornerVisibility()
  if (zoomHovered.zoom?.visible !== 'true' || zoomHovered.navigation?.visible !== 'false') {
    throw new Error(`PDF zoom hover reveal failed: ${JSON.stringify(zoomHovered)}`)
  }
  await page.mouse.move(viewportBox.x + viewportBox.width / 2, viewportBox.y + viewportBox.height / 2)
  await page.waitForTimeout(750)
  const hiddenAgain = await readCornerVisibility()
  if (hiddenAgain.zoom?.visible !== 'false' || hiddenAgain.zoom.pointerEvents !== 'none') {
    throw new Error(`PDF zoom control did not hide: ${JSON.stringify(hiddenAgain)}`)
  }
  console.log('=== PDF corner control reveal ===')
  console.log(JSON.stringify({ initiallyHidden, navigationHovered, navigationGrace, navigationHidden, zoomHovered, hiddenAgain }))

  const deepPageNumber = big ? 200 : 5
  await hoverNavigationControls()
  await page.getByTitle('点击输入页码跳转').click()
  await page.locator('input[type="number"]').fill(String(deepPageNumber))
  await page.keyboard.press('Enter')
  await page.waitForSelector(`div[data-page="${String(deepPageNumber)}"]`, { timeout: 15000 })
  await page.waitForTimeout(big ? 1500 : 600)
  // Realistic pinch: scroll to page 5 first (content above), pointer at
  // 60% of the page, 10 small ticks (trackpad cadence), measure drift.
  await page.evaluate(`document.querySelector('div[data-page="${String(deepPageNumber)}"]').scrollIntoView()`)
  await page.waitForTimeout(600)
  await page.waitForFunction((pageNumber) => {
    const canvas = document.querySelector(`div[data-page="${String(pageNumber)}"] canvas`)
    return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0
  }, deepPageNumber, { timeout: 15000 })
  // Start the repaint trace only after the initial page window is sharp. A
  // zoom settle must then replace those canvases one per paint boundary,
  // rather than reallocating and rasterizing the whole ±2 window at once.
  await page.waitForFunction(() => {
    const canvases = [...document.querySelectorAll('div[data-page] canvas')]
    return canvases.length > 0 && canvases.every(canvas =>
      canvas instanceof HTMLCanvasElement && canvas.dataset['pdfRenderScale'] !== undefined)
  }, { timeout: 15000 })
  await page.evaluate(() => {
    const trace = { frame: 0, commits: [], slotStyleMutations: 0, raf: 0, observer: undefined }
    const countFrame = () => {
      trace.frame += 1
      trace.raf = window.requestAnimationFrame(countFrame)
    }
    trace.raf = window.requestAnimationFrame(countFrame)
    trace.observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName === 'style' && record.target instanceof HTMLElement && record.target.matches('div[data-page]')) {
          trace.slotStyleMutations += 1
          continue
        }
        if (record.attributeName !== 'data-pdf-render-scale' || !(record.target instanceof HTMLCanvasElement)) continue
        trace.commits.push({
          frame: trace.frame,
          page: record.target.closest('div[data-page]')?.dataset['page'] ?? '',
          scale: record.target.dataset['pdfRenderScale'] ?? '',
        })
      }
    })
    trace.observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-pdf-render-scale', 'style'],
    })
    window.__pdfRepaintTrace = trace
  })
  const wheelResult = await page.evaluate(`(() => {
    const wrapper = document.querySelector('div[data-page="${String(deepPageNumber)}"]')
    const before = wrapper.getBoundingClientRect()
    const px = Math.round(before.left + before.width * 0.35)
    const py = Math.round(before.top + before.height * 0.6)
    return { px, py, ratioY: 0.6, ratioX: 0.35, beforeTop: Math.round(before.top), beforeLeft: Math.round(before.left), beforeHeight: Math.round(before.height), beforeWidth: Math.round(before.width) }
  })()`)
  const probe = `(label) => {
    const sc = document.querySelector('[data-pdf-scroll]')
    const content = document.querySelector('[data-pdf-content]')
    const w = document.querySelector('div[data-page="${String(deepPageNumber)}"]')
    console.log('PROBE', label, JSON.stringify({
      scrollTop: Math.round(sc.scrollTop), maxScroll: Math.round(sc.scrollHeight - sc.clientHeight),
      minH: content.style.minHeight, tf: content.style.transform || '(none)', scrollH: Math.round(sc.scrollHeight),
      p200top: Math.round(w.getBoundingClientRect().top), p200h: Math.round(w.getBoundingClientRect().height),
      scrollLeft: Math.round(sc.scrollLeft), maxLeft: Math.round(sc.scrollWidth - sc.clientWidth), p200left: Math.round(w.getBoundingClientRect().left), p200w: Math.round(w.getBoundingClientRect().width),
    }))
  }`
  const deep = `(label) => {
    const content = document.querySelector('[data-pdf-content]')
    const sizer = document.querySelector('[data-pdf-zoom-sizer]')
    const scroller = document.querySelector('[data-pdf-scroll]')
    const pages = [...document.querySelectorAll('div[data-page]')]
    const hs = pages.map(page => ({ page: page.dataset.page, height: Math.round(page.getBoundingClientRect().height) }))
    console.log('DEEP', label, JSON.stringify({ hs, contentH: Math.round(content.getBoundingClientRect().height),
      sizerH: Math.round(sizer.getBoundingClientRect().height),
      scrollerClientH: Math.round(scroller.clientHeight), scrollerClientW: Math.round(scroller.clientWidth),
      hScrollVisible: scroller.scrollWidth > scroller.clientWidth }))
  }`
  await page.evaluate(`(${deep})('before')`)
  await page.evaluate(`(${probe})('before')`)
  for (let i = 0; i < 10; i += 1) {
    await page.evaluate(`(() => {
      const el = document.elementFromPoint(${String(wheelResult.px)}, ${String(wheelResult.py)})
      ;(el ?? document.body).dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -12, bubbles: true, cancelable: true, clientX: ${String(wheelResult.px)}, clientY: ${String(wheelResult.py)} }))
    })()`)
    await page.waitForTimeout(70)
    if (i === 4 || i === 9) await page.evaluate(`(${probe})('tick${String(i + 1)}')`)
  }
  await page.waitForTimeout(400)
  await page.evaluate(`(${probe})('settled')`)
  await page.evaluate(`(${deep})('settled')`)
  await page.waitForTimeout(800)
  const repaintTrace = await page.evaluate(() => {
    const trace = window.__pdfRepaintTrace
    trace?.observer?.disconnect()
    if (trace?.raf !== undefined) window.cancelAnimationFrame(trace.raf)
    delete window.__pdfRepaintTrace
    return {
      commits: trace?.commits ?? [],
      slotStyleMutations: trace?.slotStyleMutations ?? -1,
    }
  })
  const repaintCommits = repaintTrace.commits
  const repaintFrames = repaintCommits.map(commit => commit.frame)
  if (repaintCommits.length < 2 || new Set(repaintFrames).size !== repaintFrames.length) {
    throw new Error(`PDF zoom repaints were not serialized across paint boundaries: ${JSON.stringify(repaintCommits)}`)
  }
  if (repaintTrace.slotStyleMutations !== 0) {
    throw new Error(`PDF zoom settle rewrote page-slot styles: ${String(repaintTrace.slotStyleMutations)}`)
  }
  const after = await page.evaluate(`(() => {
    const wrapper = document.querySelector('div[data-page="${String(deepPageNumber)}"]')
    const box = wrapper.getBoundingClientRect()
    const resetZoom = document.querySelector('[data-pdf-reset-zoom="true"]')
    return { zoomLabel: resetZoom?.textContent?.trim() ?? '(none)', afterTop: Math.round(box.top), afterLeft: Math.round(box.left), afterHeight: Math.round(box.height), afterWidth: Math.round(box.width) }
  })()`)
  if (!/^\d+%$/.test(after.zoomLabel)) throw new Error(`PDF zoom label was not updated: ${String(after.zoomLabel)}`)
  const contentY = after.afterTop + wheelResult.ratioY * after.afterHeight
  const contentX = after.afterLeft + wheelResult.ratioX * after.afterWidth
  console.log('=== realistic pinch ===')
  console.log(JSON.stringify({
    driftY: Math.round(contentY - wheelResult.py),
    driftX: Math.round(contentX - wheelResult.px),
    zoom: after.zoomLabel,
    repaintCommits,
    slotStyleMutations: repaintTrace.slotStyleMutations,
  }))
  await page.screenshot({ path: join(HERE, 'shot-pinch.png') })

  // Horizontal reachability after zoom: both left and right edges scrollable.
  const hscroll = await page.evaluate(`(() => {
    const sc = document.querySelector('[data-pdf-scroll]')
    sc.scrollLeft = 0
    const leftOk = sc.scrollLeft === 0
    const maxLeft = sc.scrollWidth - sc.clientWidth
    sc.scrollLeft = maxLeft
    const rightOk = Math.abs(sc.scrollLeft - maxLeft) < 2
    const page = document.querySelector('div[data-page="${String(deepPageNumber)}"]').getBoundingClientRect()
    const scBox = sc.getBoundingClientRect()
    return { leftOk, rightOk, maxLeft: Math.round(maxLeft), pageLeft: Math.round(page.left - scBox.left), pageRight: Math.round(page.right - scBox.left), clientW: Math.round(scBox.width) }
  })()`)
  console.log('=== horizontal scroll ===')
  console.log(JSON.stringify(hscroll))

  // The reported regression happened when a zoom-out gesture settled near
  // the 25% floor. Compare the exact same page-local point immediately before
  // and after React receives the final zoom; the settle itself must be a
  // visual no-op and the bounded DOM window must remain intact.
  const beforeSmallZoomView = await page.evaluate(() => {
    const scroller = document.querySelector('[data-pdf-scroll]')
    const content = document.querySelector('[data-pdf-content]')
    const rect = content.getBoundingClientRect()
    return {
      zoom: rect.width / content.clientWidth,
      top: scroller.scrollTop,
      left: scroller.scrollLeft,
    }
  })
  await hoverZoomControls()
  await page.getByRole('button', { name: '重置缩放', exact: true }).click()
  await page.waitForTimeout(500)
  const zoomOutPointer = await page.evaluate(() => {
    const scroller = document.querySelector('[data-pdf-scroll]')
    const viewport = scroller.getBoundingClientRect()
    const centerY = viewport.top + viewport.height / 2
    const pages = [...document.querySelectorAll('div[data-page]')]
    const wrapper = pages.reduce((nearest, candidate) => {
      const rect = candidate.getBoundingClientRect()
      const distance = Math.abs(rect.top + rect.height / 2 - centerY)
      return nearest === undefined || distance < nearest.distance ? { candidate, distance } : nearest
    }, undefined)?.candidate
    if (!(wrapper instanceof HTMLElement)) throw new Error('No mounted PDF page near the viewport center')
    const rect = wrapper.getBoundingClientRect()
    const inset = 20
    const x = Math.max(viewport.left + inset, Math.min(viewport.right - inset, rect.left + rect.width / 2))
    const y = Math.max(
      Math.max(viewport.top + inset, rect.top + inset),
      Math.min(Math.min(viewport.bottom - inset, rect.bottom - inset), centerY),
    )
    return { x: Math.round(x), y: Math.round(y) }
  })
  for (let index = 0; index < 15; index += 1) {
    await page.evaluate(`(() => {
      const target = document.querySelector('[data-pdf-scroll]')
      target.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 12, bubbles: true, cancelable: true, clientX: ${String(zoomOutPointer.x)}, clientY: ${String(zoomOutPointer.y)} }))
    })()`)
    await page.waitForTimeout(55)
  }
  await page.waitForTimeout(80)
  const beforeZoomOutSettle = await page.evaluate(`(() => {
    const content = document.querySelector('[data-pdf-content]')
    const rect = content.getBoundingClientRect()
    const scale = rect.width / content.clientWidth
    return {
      baseX: (${String(zoomOutPointer.x)} - rect.left) / scale,
      baseY: (${String(zoomOutPointer.y)} - rect.top) / scale,
      x: ${String(zoomOutPointer.x)},
      y: ${String(zoomOutPointer.y)},
    }
  })()`)
  await page.waitForTimeout(500)
  const afterZoomOutSettle = await page.evaluate(({ baseX, baseY }) => {
    const content = document.querySelector('[data-pdf-content]')
    const rect = content.getBoundingClientRect()
    const scale = rect.width / content.clientWidth
    return {
      x: rect.left + baseX * scale,
      y: rect.top + baseY * scale,
      scale,
      slots: document.querySelectorAll('div[data-page]').length,
      canvases: document.querySelectorAll('div[data-page] canvas').length,
    }
  }, beforeZoomOutSettle)
  const zoomOutSettleDrift = {
    x: Math.round(afterZoomOutSettle.x - beforeZoomOutSettle.x),
    y: Math.round(afterZoomOutSettle.y - beforeZoomOutSettle.y),
  }
  if (Math.abs(zoomOutSettleDrift.x) > 2 || Math.abs(zoomOutSettleDrift.y) > 2
    || afterZoomOutSettle.slots > 5 || afterZoomOutSettle.canvases > 5) {
    throw new Error(`PDF zoom-out settle regressed: ${JSON.stringify({ zoomOutSettleDrift, afterZoomOutSettle })}`)
  }
  console.log('=== small zoom settle ===')
  console.log(JSON.stringify({ zoomOutSettleDrift, afterZoomOutSettle }))
  let restoringZoom = afterZoomOutSettle.scale
  while (restoringZoom < beforeSmallZoomView.zoom - 0.000001) {
    const factor = Math.min(1.6, beforeSmallZoomView.zoom / restoringZoom)
    const deltaY = -Math.log(factor) / 0.008
    await page.evaluate(({ deltaY, x, y }) => {
      const target = document.querySelector('[data-pdf-scroll]')
      target.dispatchEvent(new WheelEvent('wheel', {
        ctrlKey: true,
        deltaY,
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      }))
    }, { deltaY, x: zoomOutPointer.x, y: zoomOutPointer.y })
    restoringZoom *= factor
    await page.waitForTimeout(40)
  }
  await page.waitForTimeout(500)
  await page.evaluate(({ top, left }) => {
    const scroller = document.querySelector('[data-pdf-scroll]')
    scroller.scrollTop = top
    scroller.scrollLeft = left
  }, beforeSmallZoomView)
  await page.waitForTimeout(300)

  const readNavigationAnchor = () => page.evaluate(() => {
    const scroller = document.querySelector('[data-pdf-scroll]')
    const scrollerRect = scroller.getBoundingClientRect()
    const centerX = scrollerRect.left + scroller.clientWidth / 2
    const centerY = scrollerRect.top + scroller.clientHeight / 2
    let nearest = null
    for (const wrapper of document.querySelectorAll('div[data-page]')) {
      const rect = wrapper.getBoundingClientRect()
      const distance = centerY < rect.top ? rect.top - centerY : centerY > rect.bottom ? centerY - rect.bottom : 0
      if (nearest === null || distance < nearest.distance) nearest = { wrapper, rect, distance }
      if (distance === 0) break
    }
    return {
      page: nearest?.wrapper.dataset.page ?? '',
      xRatio: nearest === null ? -1 : (centerX - nearest.rect.left) / nearest.rect.width,
      yRatio: nearest === null ? -1 : (centerY - nearest.rect.top) / nearest.rect.height,
    }
  })

  // Goto-page enters bounded history. Back restores the exact page-local
  // point; forward returns to the target instead of recording another jump.
  const beforeGotoHistory = await readNavigationAnchor()
  const gotoTarget = big ? 52 : 7
  await hoverNavigationControls()
  await page.getByTitle('点击输入页码跳转').click()
  await page.waitForTimeout(300)
  await page.locator('input[type="number"]').fill(String(gotoTarget))
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1000)
  const goto = await page.evaluate(`(() => {
    const target = document.querySelector('div[data-page="${String(gotoTarget)}"]')
    const label = document.querySelector('[title="点击输入页码跳转"]')
    return { label: label ? label.textContent : '(missing)', targetY: target ? Math.round(target.getBoundingClientRect().top) : -1 }
  })()`)
  console.log(`=== goto page ${String(gotoTarget)} ===`)
  console.log(JSON.stringify(goto))
  await page.screenshot({ path: join(HERE, 'shot-goto.png') })
  const historyBack = page.getByRole('button', { name: '返回上一个 PDF 跳转位置', exact: true })
  const historyForward = page.getByRole('button', { name: '前进到下一个 PDF 跳转位置', exact: true })
  await hoverNavigationControls()
  await historyBack.click()
  await page.waitForTimeout(600)
  const afterHistoryBack = await readNavigationAnchor()
  if (afterHistoryBack.page !== beforeGotoHistory.page
    || Math.abs(afterHistoryBack.xRatio - beforeGotoHistory.xRatio) > 0.01
    || Math.abs(afterHistoryBack.yRatio - beforeGotoHistory.yRatio) > 0.01) {
    throw new Error(`PDF history did not restore its page-local anchor: ${JSON.stringify({ beforeGotoHistory, afterHistoryBack })}`)
  }
  await historyForward.click()
  await page.waitForTimeout(600)
  const afterHistoryForward = await page.getByTitle('点击输入页码跳转').textContent()
  if (!afterHistoryForward?.startsWith(`${String(gotoTarget)} /`)) {
    throw new Error(`PDF history forward did not restore page ${String(gotoTarget)}: ${String(afterHistoryForward)}`)
  }
  console.log('=== PDF navigation history ===')
  console.log(JSON.stringify({ beforeGotoHistory, afterHistoryBack, afterHistoryForward }))

  // Resizing the dock changes every fitted page's dimensions. The page point
  // under the viewport center must remain anchored in both directions.
  const readResizeAnchor = () => page.evaluate(() => {
    const scroller = document.querySelector('[data-pdf-scroll]')
    const scrollerRect = scroller.getBoundingClientRect()
    const centerY = scrollerRect.top + scroller.clientHeight / 2
    let nearest = null
    for (const wrapper of document.querySelectorAll('div[data-page]')) {
      const rect = wrapper.getBoundingClientRect()
      const distance = centerY < rect.top ? rect.top - centerY : centerY > rect.bottom ? centerY - rect.bottom : 0
      if (nearest === null || distance < nearest.distance) nearest = { wrapper, rect, distance }
      if (distance === 0) break
    }
    const label = document.querySelector('[title="点击输入页码跳转"]')
    return {
      label: label?.textContent ?? '',
      page: nearest?.wrapper.dataset.page ?? '',
      yRatio: nearest === null ? -1 : (centerY - nearest.rect.top) / nearest.rect.height,
    }
  })
  const beforeResize = await readResizeAnchor()
  const resizeHandle = page.getByTitle('拖动调整宽度')
  const resizeBox = await resizeHandle.boundingBox()
  if (resizeBox === null) throw new Error('PDF resize handle missing')
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 140, resizeBox.y + resizeBox.height / 2, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(500)
  const afterResize = await readResizeAnchor()
  if (afterResize.label !== beforeResize.label
    || afterResize.page !== beforeResize.page
    || Math.abs(afterResize.yRatio - beforeResize.yRatio) > 0.02) {
    throw new Error(`PDF resize lost its page anchor: ${JSON.stringify({ beforeResize, afterResize })}`)
  }
  console.log('=== PDF resize anchor ===')
  console.log(JSON.stringify({ beforeResize, afterResize }))

  // The floating PDF control toggles visibility without replacing the loaded
  // document or rebuilding its scroller; both axes must survive the roundtrip.
  const pdfToggle = page.getByRole('button', { name: '显示或收起 PDF 阅读器', exact: true })
  const beforeToggle = await page.evaluate(`(() => {
    const sc = document.querySelector('[data-pdf-scroll]')
    const label = document.querySelector('[title="点击输入页码跳转"]')
    return { top: sc.scrollTop, left: sc.scrollLeft, page: label?.textContent ?? '' }
  })()`)
  await pdfToggle.click()
  await page.getByTitle('点击输入页码跳转').waitFor({ state: 'hidden' })
  const reopenStarted = Date.now()
  const reopenLayoutTrace = page.evaluate(() => new Promise((resolve) => {
    const samples = []
    let remaining = 30
    const sample = () => {
      const first = document.querySelector('div[data-page="1"]')
      const scroller = document.querySelector('[data-pdf-scroll]')
      samples.push({
        scrollTop: scroller?.scrollTop ?? 0,
        scrollHeight: scroller?.scrollHeight ?? 0,
        clientWidth: scroller?.clientWidth ?? 0,
      })
      remaining -= 1
      if (remaining === 0) resolve(samples)
      else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }))
  await pdfToggle.click()
  await page.getByTitle('点击输入页码跳转').waitFor({ state: 'visible' })
  const reopenSamples = await reopenLayoutTrace
  const reopenMs = Date.now() - reopenStarted
  const afterToggle = await page.evaluate(`(() => {
    const sc = document.querySelector('[data-pdf-scroll]')
    const label = document.querySelector('[title="点击输入页码跳转"]')
    return { top: sc.scrollTop, left: sc.scrollLeft, page: label?.textContent ?? '' }
  })()`)
  if (Math.abs(afterToggle.top - beforeToggle.top) > 2
    || Math.abs(afterToggle.left - beforeToggle.left) > 4
    || afterToggle.page !== beforeToggle.page) {
    throw new Error(`PDF toggle lost reading position: ${JSON.stringify({ beforeToggle, afterToggle })}`)
  }
  const reopenHeights = reopenSamples.map(sample => sample.scrollHeight)
  const reopenWidths = reopenSamples.map(sample => sample.clientWidth)
  if (Math.max(...reopenHeights) - Math.min(...reopenHeights) > 2
    || Math.max(...reopenWidths) - Math.min(...reopenWidths) > 2) {
    throw new Error(`PDF toggle relaid out its pages: ${JSON.stringify(reopenSamples)}`)
  }
  console.log('=== PDF toggle position ===')
  console.log(JSON.stringify({ beforeToggle, afterToggle, reopenMs, reopenSamples }))

  // Composer regression: keep an existing draft while adding/removing one PDF crop.
  const composer = page.locator('textarea').last()
  await composer.click()
  await composer.fill('hello123')
  const draftBeforeSelection = await composer.inputValue()
  await page.evaluate(() => {
    const scroller = document.querySelector('[data-pdf-scroll]')
    if (scroller instanceof HTMLElement) scroller.scrollLeft = 0
  })
  await page.waitForTimeout(100)

  // Make a selection on a VISIBLE page. It must use the main composer rather
  // than creating a second input beneath the PDF.
  const visiblePage = await page.evaluate(`(() => {
    const scroller = document.querySelector('[data-pdf-scroll]')
    const sb = scroller.getBoundingClientRect()
    for (const w of document.querySelectorAll('div[data-page]')) {
      const r = w.getBoundingClientRect()
      const visible = r.bottom > sb.top + 80 && r.top < sb.bottom - 80 && r.right > sb.left + 160 && r.left < sb.right - 60
      if (visible) {
        return {
          n: w.dataset.page,
          x: Math.max(r.left, sb.left) + 60,
          y: Math.max(r.top, sb.top + 40) + 60,
        }
      }
    }
    return null
  })()`)
  if (visiblePage === null) throw new Error('no visible page')

  // Left drag defaults to the real pdf.js text layer. It must select native
  // text without creating a composer crop; the explicit toolbar mode is the
  // only path that activates rectangular screenshot capture.
  const interactionModeButton = page.locator('[data-pdf-interaction-mode-button="true"]')
  if (await interactionModeButton.getAttribute('data-pdf-interaction-mode') !== 'text'
    || await interactionModeButton.getAttribute('aria-pressed') !== 'false') {
    throw new Error('PDF interaction tool did not default to text selection')
  }
  await page.waitForFunction((pageNumber) =>
    document.querySelector(`div[data-page="${String(pageNumber)}"] [data-pdf-text-layer="true"]`)?.getAttribute('data-pdf-has-text') === 'true',
  visiblePage.n, { timeout: 10000 })
  const selectableBox = await page.evaluate((pageNumber) => {
    const scroller = document.querySelector('[data-pdf-scroll]')?.getBoundingClientRect()
    if (scroller === undefined) return null
    const spans = document.querySelectorAll(`div[data-page="${String(pageNumber)}"] [data-pdf-text-layer="true"] span`)
    for (const span of spans) {
      if ((span.textContent?.trim().length ?? 0) === 0) continue
      const rect = span.getBoundingClientRect()
      const left = Math.max(rect.left, scroller.left)
      const right = Math.min(rect.right, scroller.right)
      const top = Math.max(rect.top, scroller.top)
      const bottom = Math.min(rect.bottom, scroller.bottom)
      if (right - left >= 4 && bottom - top >= 4) return { x: left, y: top, width: right - left, height: bottom - top }
    }
    return null
  }, visiblePage.n)
  if (selectableBox === null) {
    const textLayerGeometry = await page.evaluate((pageNumber) => {
      const wrapper = document.querySelector(`div[data-page="${String(pageNumber)}"]`)
      const layer = wrapper?.querySelector('[data-pdf-text-layer="true"]')
      const readRect = (element) => {
        const rect = element?.getBoundingClientRect()
        return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
      return {
        wrapper: readRect(wrapper),
        layer: readRect(layer),
        layerStyle: layer instanceof HTMLElement ? { width: layer.style.width, height: layer.style.height, scale: layer.style.getPropertyValue('--total-scale-factor') } : null,
        spans: [...(layer?.querySelectorAll('span') ?? [])].slice(0, 5).map(span => ({ text: span.textContent, rect: readRect(span), style: span.getAttribute('style') })),
      }
    }, visiblePage.n)
    throw new Error(`PDF text layer had no visible selectable span: ${JSON.stringify(textLayerGeometry)}`)
  }
  await page.mouse.move(selectableBox.x + 2, selectableBox.y + selectableBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(selectableBox.x + selectableBox.width - 2, selectableBox.y + selectableBox.height / 2, { steps: 5 })
  await page.mouse.up()
  const selectedPdfText = await page.evaluate(() => window.getSelection()?.toString().trim() ?? '')
  if (selectedPdfText.length === 0 || await page.getByRole('button', { name: /^选区 \(/ }).count() !== 0) {
    throw new Error(`PDF default drag did not select text cleanly: ${JSON.stringify({ selectedPdfText })}`)
  }
  const textSelectionHighlights = page.locator('[data-pdf-text-selection-highlight="true"]')
  await textSelectionHighlights.first().waitFor({ state: 'visible', timeout: 5000 })
  const textSelectionHighlightCount = await textSelectionHighlights.count()
  await page.screenshot({ path: join(HERE, 'shot-text-selection.png') })

  // The native selection owns a compact annotation menu. A color creates a
  // document-local highlight, clicking that highlight reopens the same menu
  // for recoloring and group deletion, and none of this creates an attachment.
  const annotationMenu = page.locator('[data-pdf-annotation-menu="true"]')
  await annotationMenu.waitFor({ state: 'visible', timeout: 5000 })
  if (await annotationMenu.getAttribute('data-pdf-annotation-menu-kind') !== 'selection') {
    throw new Error('native text selection did not open the create-highlight menu')
  }
  await page.getByRole('button', { name: '复制文字', exact: true }).click()
  await page.getByRole('button', { name: '已复制', exact: true }).waitFor({ state: 'visible' })
  const copiedPdfText = await page.evaluate(() => navigator.clipboard.readText())
  const selectionAfterCopy = await page.evaluate(() => window.getSelection()?.toString().trim() ?? '')
  if (copiedPdfText !== selectedPdfText || selectionAfterCopy !== selectedPdfText
    || await textSelectionHighlights.count() !== textSelectionHighlightCount) {
    throw new Error(`floating copy changed the native PDF selection: ${JSON.stringify({ copiedPdfText, selectionAfterCopy })}`)
  }
  await page.screenshot({ path: join(HERE, 'shot-text-copy.png') })

  // The primary AI control opens a compact reading menu. Direct explain and
  // translate sends are unit-tested at the scoped conversation boundary; the
  // browser regression exercises the question editor without spending a model
  // turn, then uses the non-sending context action end to end.
  const pdfDocumentName = await page.locator('[data-pdf-document-name="true"]').innerText()
  const aiMenuToggle = page.getByRole('button', { name: 'AI 阅读工具', exact: true })
  await aiMenuToggle.click()
  const aiMenu = page.locator('[data-pdf-ai-menu="true"]')
  await aiMenu.waitFor({ state: 'visible' })
  for (const action of ['explain', 'translate', 'question', 'context']) {
    if (await aiMenu.locator(`[data-pdf-ai-action="${action}"]`).count() !== 1) {
      throw new Error(`AI reading menu is missing action: ${action}`)
    }
  }
  if (await aiMenuToggle.getAttribute('aria-expanded') !== 'true') {
    throw new Error('AI reading menu did not expose its expanded state')
  }
  await page.screenshot({ path: join(HERE, 'shot-text-ai-menu.png') })

  await aiMenu.locator('[data-pdf-ai-action="question"]').click()
  const aiQuestion = page.getByRole('textbox', { name: '深入提问内容', exact: true })
  await aiQuestion.fill('这段结论如何对应当前项目？')
  if (await annotationMenu.getAttribute('data-pdf-annotation-menu-kind') !== 'selection'
    || await aiQuestion.inputValue() !== '这段结论如何对应当前项目？') {
    throw new Error('AI question editor lost its source selection or draft')
  }
  await page.screenshot({ path: join(HERE, 'shot-text-ai-question.png') })
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await aiMenu.waitFor({ state: 'visible' })
  await aiMenu.locator('[data-pdf-ai-action="context"]').click()
  await annotationMenu.waitFor({ state: 'hidden' })
  const aiReferenceDraft = await composer.inputValue()
  const expectedPageLabel = `第 ${String(visiblePage.n)} 页`
  if (!aiReferenceDraft.startsWith(`${draftBeforeSelection}\n\n`)
    || !aiReferenceDraft.includes(`PDF 引用｜${pdfDocumentName}｜${expectedPageLabel}`)
    || !aiReferenceDraft.includes(`> ${selectedPdfText}`)) {
    throw new Error(`AI reference did not preserve draft provenance: ${JSON.stringify({ aiReferenceDraft, pdfDocumentName, expectedPageLabel, selectedPdfText })}`)
  }
  if ((await page.evaluate(() => window.getSelection()?.toString() ?? '')).length !== 0) {
    throw new Error('AI reference did not clear the consumed native text selection')
  }
  await page.screenshot({ path: join(HERE, 'shot-text-ai-context.png') })
  await composer.fill(draftBeforeSelection)

  // The AI action consumes the native range. Select the same source again
  // before continuing through the independent annotation path.
  await page.mouse.move(selectableBox.x + 2, selectableBox.y + selectableBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(selectableBox.x + selectableBox.width - 2, selectableBox.y + selectableBox.height / 2, { steps: 5 })
  await page.mouse.up()
  await annotationMenu.waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '使用黄色高亮', exact: true }).click()
  const persistedHighlight = page.locator('[data-pdf-text-markup-annotation="true"]')
  await persistedHighlight.first().waitFor({ state: 'visible', timeout: 5000 })
  await page.locator('[data-pdf-unsaved-annotations="true"]').waitFor({ state: 'visible' })
  await page.screenshot({ path: join(HERE, 'shot-text-highlight.png') })
  await persistedHighlight.first().click()
  await annotationMenu.waitFor({ state: 'visible' })
  if (await annotationMenu.getAttribute('data-pdf-annotation-menu-kind') !== 'annotation') {
    throw new Error('committed highlight did not reopen the edit menu')
  }
  await page.getByRole('button', { name: '选择标记颜色', exact: true }).click()
  await page.getByRole('button', { name: '将标记改为蓝色', exact: true }).click()
  await page.getByRole('button', { name: '选择标记颜色', exact: true }).click()
  if (await page.locator('[data-pdf-highlight-color="blue"]').getAttribute('aria-pressed') !== 'true') {
    throw new Error('highlight color edit did not update the full annotation group')
  }
  await page.getByRole('button', { name: '选择标记颜色', exact: true }).click()
  await page.getByRole('button', { name: '添加批注', exact: true }).click()
  const annotationNoteInput = page.getByRole('textbox', { name: '批注内容', exact: true })
  await annotationNoteInput.fill('重点说明')
  await page.screenshot({ path: join(HERE, 'shot-text-note.png') })
  await page.getByRole('button', { name: '保存', exact: true }).click()
  if (await persistedHighlight.first().getAttribute('data-pdf-annotation-has-note') !== 'true'
    || await persistedHighlight.first().getAttribute('title') !== '重点说明') {
    throw new Error('highlight note was not committed to the annotation group')
  }
  await page.getByRole('button', { name: '编辑批注', exact: true }).click()
  if (await annotationNoteInput.inputValue() !== '重点说明') throw new Error('saved highlight note did not reopen')
  await annotationNoteInput.fill('')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  if (await persistedHighlight.first().getAttribute('data-pdf-annotation-has-note') !== 'false') {
    throw new Error('empty highlight note did not clear the group comment')
  }
  await page.getByRole('button', { name: '删除标记', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-pdf-text-markup-annotation="true"]') === null
    && document.querySelector('[data-pdf-unsaved-annotations="true"]') === null)

  for (const markup of [
    { kind: 'underline', createLabel: '使用蓝色下划线', expectedWidth: '2' },
    { kind: 'strikeout', createLabel: '使用蓝色删除线', expectedWidth: '2' },
  ]) {
    await page.mouse.move(selectableBox.x + 2, selectableBox.y + selectableBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(selectableBox.x + selectableBox.width - 2, selectableBox.y + selectableBox.height / 2, { steps: 5 })
    await page.mouse.up()
    await annotationMenu.waitFor({ state: 'visible' })
    await page.getByRole('button', { name: markup.createLabel, exact: true }).click()
    const textMarkup = page.locator(`[data-pdf-text-markup-annotation="true"][data-pdf-markup-kind="${markup.kind}"]`)
    await textMarkup.first().waitFor({ state: 'visible' })
    if (await textMarkup.first().getAttribute('data-pdf-markup-stroke-width') !== markup.expectedWidth) {
      throw new Error(`${markup.kind} did not use the remembered markup stroke width`)
    }
    await page.waitForFunction(() => document.querySelector('[data-pdf-text-selection-highlight="true"]') === null)
    await textMarkup.first().click()
    if (markup.kind === 'underline') {
      await page.getByRole('button', { name: '调整线宽', exact: true }).click()
      await page.getByRole('button', { name: '粗线', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('[data-pdf-text-markup-annotation="true"]')?.getAttribute('data-pdf-markup-stroke-width') === '3')
      await page.getByRole('button', { name: '调整线宽', exact: true }).click()
      if (await page.getByRole('button', { name: '粗线', exact: true }).getAttribute('aria-pressed') !== 'true') {
        throw new Error('underline width edit did not update the complete annotation group')
      }
      await page.screenshot({ path: join(HERE, 'shot-text-line-width.png') })
      await page.getByRole('button', { name: '调整线宽', exact: true }).click()

      // The document-level annotation center groups page-local markups,
      // filters by kind, navigates back to source, and edits the same note
      // model used by the floating menu.
      await page.locator('[data-pdf-annotation-drawer-button="true"]').click()
      const annotationDrawer = page.locator('[data-pdf-annotation-drawer="true"]')
      await annotationDrawer.waitFor({ state: 'visible' })
      if (await annotationDrawer.locator('[data-pdf-annotation-list-item="true"]').count() !== 1) {
        throw new Error('annotation center did not group the active markup')
      }
      await annotationDrawer.locator('[data-pdf-annotation-filter="highlight"]').click()
      if (await annotationDrawer.locator('[data-pdf-annotation-list-item="true"]').count() !== 0) {
        throw new Error('annotation center kind filter retained an unrelated markup')
      }
      await annotationDrawer.locator('[data-pdf-annotation-filter="underline"]').click()
      const annotationListItem = annotationDrawer.locator('[data-pdf-annotation-list-item="true"]')
      const annotationScroller = page.locator('[data-pdf-scroll="true"]')
      const scrollBeforeAnnotationNavigate = await annotationScroller.evaluate(element => ({
        top: element.scrollTop,
        left: element.scrollLeft,
      }))
      await annotationListItem.locator('button').first().click()
      await page.waitForTimeout(120)
      await annotationScroller.evaluate((element, position) => {
        element.scrollTop = position.top
        element.scrollLeft = position.left
      }, scrollBeforeAnnotationNavigate)
      await annotationListItem.locator('button', { hasText: '添加备注' }).click()
      const centerNote = annotationListItem.getByRole('textbox', { name: '批注中心备注', exact: true })
      await centerNote.fill('批注中心备注')
      await annotationListItem.getByRole('button', { name: '保存', exact: true }).click()
      if (await textMarkup.first().getAttribute('data-pdf-annotation-has-note') !== 'true') {
        throw new Error('annotation center note edit did not update the PDF markup')
      }
      await annotationDrawer.locator('[data-pdf-annotation-ai-button="true"]').click()
      const annotationAiMenu = annotationDrawer.locator('[data-pdf-annotation-ai-menu="true"]')
      await annotationAiMenu.waitFor({ state: 'visible' })
      for (const action of ['summarize', 'organize', 'review', 'question']) {
        if (await annotationAiMenu.locator(`[data-pdf-annotation-ai-action="${action}"]`).count() !== 1) {
          throw new Error(`annotation center AI menu is missing action: ${action}`)
        }
      }
      await annotationAiMenu.locator('[data-pdf-annotation-ai-action="question"]').click()
      const annotationAiQuestion = annotationAiMenu.getByRole('textbox', { name: '批注集合问题', exact: true })
      await annotationAiQuestion.fill('这些批注之间有什么共同前提？')
      if (await annotationAiQuestion.inputValue() !== '这些批注之间有什么共同前提？') {
        throw new Error('annotation center AI question did not retain its draft')
      }
      await page.screenshot({ path: join(HERE, 'shot-annotation-center.png') })
      await annotationAiMenu.getByRole('button', { name: '返回', exact: true }).click()
      await annotationDrawer.getByRole('button', { name: '关闭批注中心', exact: true }).click()
      console.log('=== PDF annotation center ===')
      console.log(JSON.stringify({ grouped: true, filtered: true, navigated: true, noteEdited: true, aiScope: 'current-filter' }))

      // Save As must produce a separate annotated PDF and clear the dirty
      // badge. The resulting native handle then enables an explicit,
      // confirmed overwrite after a later annotation edit.
      await page.evaluate(() => {
        const probe = { writes: [], writeCount: 0, current: undefined }
        Object.defineProperty(window, '__pdfSaveProbe', { configurable: true, value: probe })
        Object.defineProperty(window, 'showSaveFilePicker', {
          configurable: true,
          value: async ({ suggestedName }) => {
            const name = suggestedName ?? 'annotated.pdf'
            probe.current = new File([], name, { type: 'application/pdf', lastModified: 1000 })
            return {
              kind: 'file',
              name,
              getFile: async () => probe.current,
              createWritable: async () => {
                let pending = new Uint8Array()
                return {
                  write: async (bytes) => { pending = new Uint8Array(bytes).slice() },
                  close: async () => {
                    probe.writeCount += 1
                    probe.writes.push([...pending])
                    probe.current = new File([pending], name, {
                      type: 'application/pdf',
                      lastModified: 1000 + probe.writeCount,
                    })
                  },
                  abort: async () => {},
                }
              },
            }
          },
        })
      })
      const saveMenuButton = page.locator('[data-pdf-save-menu-button="true"]')
      await saveMenuButton.click()
      await page.locator('[data-pdf-save-as="true"]').click()
      await page.locator('[data-pdf-unsaved-annotations="true"]').waitFor({ state: 'hidden' })
      await page.waitForFunction(() => window.__pdfSaveProbe?.writes.length === 1)
      const saveAsProbe = await page.evaluate(() => ({
        filename: document.querySelector('[data-pdf-document-name="true"]')?.textContent ?? '',
        writes: window.__pdfSaveProbe?.writes.length ?? 0,
        header: String.fromCharCode(...(window.__pdfSaveProbe?.writes[0]?.slice(0, 5) ?? [])),
      }))
      if (!saveAsProbe.filename.endsWith('-annotated.pdf') || saveAsProbe.writes !== 1 || saveAsProbe.header !== '%PDF-') {
        throw new Error(`PDF Save As did not produce a separate valid file: ${JSON.stringify(saveAsProbe)}`)
      }

      await textMarkup.first().click()
      await annotationMenu.waitFor({ state: 'visible' })
      await page.getByRole('button', { name: '调整线宽', exact: true }).click()
      await page.getByRole('button', { name: '中线', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('[data-pdf-text-markup-annotation="true"]')?.getAttribute('data-pdf-markup-stroke-width') === '2')
      await page.locator('[data-pdf-unsaved-annotations="true"]').waitFor({ state: 'visible' })
      await saveMenuButton.click()
      const overwriteButton = page.locator('[data-pdf-overwrite="true"]')
      if (await overwriteButton.isDisabled()) throw new Error('Save As handle did not enable explicit overwrite')
      page.once('dialog', dialog => { void dialog.accept() })
      await overwriteButton.click()
      await page.locator('[data-pdf-unsaved-annotations="true"]').waitFor({ state: 'hidden' })
      await page.waitForFunction(() => window.__pdfSaveProbe?.writes.length === 2)
      console.log('=== PDF annotation persistence ===')
      console.log(JSON.stringify({ saveAs: true, overwriteConfirmed: true, sourceImplicitlyOverwritten: false }))
      await textMarkup.first().click()
      await annotationMenu.waitFor({ state: 'visible' })
    }
    await page.screenshot({ path: join(HERE, `shot-text-${markup.kind}.png`) })
    await page.getByRole('button', { name: '删除标记', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-pdf-text-markup-annotation="true"]') === null)
  }
  await page.waitForFunction(() => document.querySelector('[data-pdf-text-selection-highlight="true"]') === null)
  await page.evaluate(() => {
    const scroller = document.querySelector('[data-pdf-scroll]')
    if (scroller instanceof HTMLElement) scroller.scrollLeft = Math.min(300, scroller.scrollWidth - scroller.clientWidth)
  })
  await page.waitForTimeout(100)
  await interactionModeButton.click()
  if (await interactionModeButton.getAttribute('data-pdf-interaction-mode') !== 'crop'
    || await interactionModeButton.getAttribute('aria-pressed') !== 'true') {
    throw new Error('PDF interaction tool did not enter crop mode')
  }

  await page.mouse.move(visiblePage.x, visiblePage.y)
  const hitInfo = await page.evaluate(`(() => {
    const el = document.elementFromPoint(${String(visiblePage.x)}, ${String(visiblePage.y)})
    const chain = []
    let cur = el
    while (cur && chain.length < 6) { chain.push(cur.tagName + '.' + String(cur.className).slice(0, 30) + (cur.dataset?.page ? '[page ' + cur.dataset.page + ']' : '')); cur = cur.parentElement }
    return chain
  })()`)
  console.log('HIT', JSON.stringify(hitInfo))
  await page.mouse.down()
  await page.mouse.move(visiblePage.x + 180, visiblePage.y + 140, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(600)
  const evidenceButton = page.locator('[data-pdf-evidence-button="true"]')
  if (await evidenceButton.count() !== 0) {
    throw new Error('a fresh conversation crop entered PDF evidence before explicit user action')
  }
  const initialComposerAttachmentCount = await composer.evaluate((textarea) => {
    const root = textarea.closest('[data-composer-card]')
    return root === null ? 0 : [...root.querySelectorAll('img')].filter(image => image.src.startsWith('blob:')).length
  })
  if (initialComposerAttachmentCount !== 1) {
    throw new Error(`fresh crop did not remain available for a direct composer question: ${String(initialComposerAttachmentCount)}`)
  }

  // A committed raster region opens a dedicated visual-AI menu. Exercise the
  // local UI without submitting a model turn; the scoped send boundary is
  // covered by unit tests so this browser run remains deterministic.
  const imageAiMenu = page.locator('[data-pdf-image-ai-menu="true"]')
  await imageAiMenu.waitFor({ state: 'visible', timeout: 5000 })
  if (!(await imageAiMenu.textContent())?.includes('图片 AI · 1 个对话选区')) {
    throw new Error('image AI menu did not identify its initial one-selection scope')
  }
  for (const action of ['explain', 'ocr', 'translate', 'question']) {
    if (await imageAiMenu.locator(`[data-pdf-image-ai-action="${action}"]`).count() !== 1) {
      throw new Error(`image AI menu is missing action: ${action}`)
    }
  }
  await page.screenshot({ path: join(HERE, 'shot-image-ai-menu.png') })
  await imageAiMenu.locator('[data-pdf-image-ai-action="question"]').click()
  const imageAiQuestion = page.getByRole('textbox', { name: '图片选区问题', exact: true })
  await imageAiQuestion.fill('这张图说明了什么？')
  if (await imageAiQuestion.inputValue() !== '这张图说明了什么？') {
    throw new Error('image AI question editor lost its draft')
  }
  await page.screenshot({ path: join(HERE, 'shot-image-ai-question.png') })
  await imageAiMenu.getByRole('button', { name: '返回', exact: true }).click()
  await imageAiMenu.locator('[data-pdf-image-ai-action="ocr"]').waitFor({ state: 'visible' })
  if (await imageAiMenu.locator('[data-pdf-image-ai-action="pair-text"]').count() !== 0) {
    throw new Error('image AI menu still exposes the removed duplicate pair-text action')
  }
  if (await imageAiMenu.locator('[data-pdf-image-ai-action="add-evidence"]').count() !== 1) {
    throw new Error('image AI menu is missing the explicit move-to-evidence action')
  }
  await imageAiMenu.locator('[data-pdf-image-ai-action="add-evidence"]').click()
  await imageAiMenu.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '图文资料：共 1 张图片、0 段文字；已选 1 张图片、0 段文字', exact: true }).waitFor({ state: 'visible' })
  const attachmentCountAfterEvidenceMove = await composer.evaluate((textarea) => {
    const root = textarea.closest('[data-composer-card]')
    return root === null ? 0 : [...root.querySelectorAll('img')].filter(image => image.src.startsWith('blob:')).length
  })
  if (attachmentCountAfterEvidenceMove !== 0) {
    throw new Error('moving a crop into PDF evidence left a duplicate composer attachment')
  }
  if (await interactionModeButton.getAttribute('data-pdf-interaction-mode') !== 'crop') {
    throw new Error('moving an image into evidence unexpectedly changed the interaction mode')
  }
  await interactionModeButton.click()
  if (await interactionModeButton.getAttribute('data-pdf-interaction-mode') !== 'text') {
    throw new Error('manual return to native text-selection mode failed')
  }

  await page.mouse.move(selectableBox.x + 2, selectableBox.y + selectableBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(selectableBox.x + selectableBox.width - 2, selectableBox.y + selectableBox.height / 2, { steps: 5 })
  await page.mouse.up()
  await annotationMenu.waitFor({ state: 'visible' })
  await aiMenuToggle.click()
  await aiMenu.waitFor({ state: 'visible' })
  await aiMenu.locator('[data-pdf-ai-action="mixed"]').click()
  if (!(await aiMenu.locator('[data-pdf-mixed-ai-summary="true"]').textContent())?.includes('1 张图片 + 1 段文字')) {
    throw new Error('mixed AI menu did not summarize its image + text scope')
  }
  for (const action of ['explain', 'relate', 'verify', 'question']) {
    if (await aiMenu.locator(`[data-pdf-mixed-ai-action="${action}"]`).count() !== 1) {
      throw new Error(`mixed AI menu is missing action: ${action}`)
    }
  }
  await aiMenu.locator('[data-pdf-mixed-ai-action="question"]').click()
  const mixedAiQuestion = page.getByRole('textbox', { name: '图文提问内容', exact: true })
  await mixedAiQuestion.fill('正文中的描述分别对应图中哪些部分？')
  if (await mixedAiQuestion.inputValue() !== '正文中的描述分别对应图中哪些部分？') {
    throw new Error('mixed AI question editor lost its draft')
  }
  await page.screenshot({ path: join(HERE, 'shot-mixed-ai-question.png') })
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await aiMenu.locator('[data-pdf-mixed-ai-add-evidence="true"]').click()
  await annotationMenu.waitFor({ state: 'hidden' })
  if (await evidenceButton.getAttribute('aria-label') !== '图文资料：共 1 张图片、1 段文字；已选 1 张图片、1 段文字') {
    throw new Error('first native-text source did not enter the evidence basket')
  }

  await page.evaluate((pageNumber) => {
    const span = [...document.querySelectorAll(`div[data-page="${String(pageNumber)}"] [data-pdf-text-layer="true"] span`)]
      .find(candidate => (candidate.textContent?.length ?? 0) >= 2)
    const node = span?.firstChild
    if (!(node instanceof Text)) throw new Error('no partial native-text source')
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, Math.min(2, node.length))
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, visiblePage.n)
  await annotationMenu.waitFor({ state: 'visible' })
  await aiMenuToggle.click()
  await aiMenu.locator('[data-pdf-mixed-ai-add-evidence="true"]').click()
  await annotationMenu.waitFor({ state: 'hidden' })
  if (await evidenceButton.getAttribute('aria-label') !== '图文资料：共 1 张图片、2 段文字；已选 1 张图片、2 段文字') {
    throw new Error('second native-text source did not append to the evidence basket')
  }

  await evidenceButton.click()
  const evidenceDrawer = page.locator('[data-pdf-evidence-drawer="true"]')
  await evidenceDrawer.waitFor({ state: 'visible' })
  if (await evidenceDrawer.locator('[data-pdf-evidence-image="true"]').count() !== 1
    || await evidenceDrawer.locator('[data-pdf-evidence-text="true"]').count() !== 2) {
    throw new Error('evidence drawer did not retain one image and two ordered text sources')
  }
  const evidenceAiButton = evidenceDrawer.locator('[data-pdf-evidence-ai-button="true"]')
  await evidenceDrawer.getByRole('checkbox', { name: '本次提问使用图片资料 1', exact: true }).uncheck()
  if (await evidenceButton.getAttribute('aria-label') !== '图文资料：共 1 张图片、2 段文字；已选 0 张图片、2 段文字'
    || await evidenceAiButton.isEnabled()) {
    throw new Error('excluding the only evidence image did not narrow and disable the mixed-AI scope')
  }
  await evidenceDrawer.getByRole('checkbox', { name: '本次提问使用图片资料 1', exact: true }).check()
  await evidenceDrawer.locator('[data-pdf-evidence-select-none="true"]').click()
  if (!(await evidenceDrawer.locator('[data-pdf-evidence-scope="true"]').textContent())?.includes('图 0 / 1 · 文 0 / 2')
    || await evidenceAiButton.isEnabled()) {
    throw new Error('cancel-select-all did not clear the current evidence request scope')
  }
  await evidenceDrawer.locator('[data-pdf-evidence-select-all="true"]').click()
  if (await evidenceButton.getAttribute('aria-label') !== '图文资料：共 1 张图片、2 段文字；已选 1 张图片、2 段文字'
    || !(await evidenceAiButton.isEnabled())) {
    throw new Error('select-all did not restore the complete evidence request scope')
  }
  await evidenceDrawer.locator('[data-pdf-evidence-text="true"] button').first().click()
  const evidenceHighlights = page.locator('[data-pdf-evidence-highlight="true"]')
  await evidenceHighlights.first().waitFor({ state: 'visible', timeout: 5000 })
  if (await evidenceHighlights.count() === 0) {
    throw new Error('navigating a text source did not highlight its original PDF fragments')
  }
  await page.screenshot({ path: join(HERE, 'shot-evidence-highlight.png') })
  await evidenceAiButton.click()
  const evidenceAiMenu = evidenceDrawer.locator('[data-pdf-evidence-ai-menu="true"]')
  for (const action of ['explain', 'relate', 'verify', 'question']) {
    if (await evidenceAiMenu.locator(`[data-pdf-evidence-ai-action="${action}"]`).count() !== 1) {
      throw new Error(`evidence AI menu is missing action: ${action}`)
    }
  }
  await evidenceAiMenu.locator('[data-pdf-evidence-ai-action="question"]').click()
  const evidenceQuestion = evidenceDrawer.getByRole('textbox', { name: '图文资料问题', exact: true })
  await evidenceQuestion.fill('两段文字分别补充了图片中的哪些信息？')
  if (await evidenceQuestion.inputValue() !== '两段文字分别补充了图片中的哪些信息？') {
    throw new Error('evidence AI question lost its draft')
  }
  await page.screenshot({ path: join(HERE, 'shot-evidence-drawer.png') })
  await evidenceDrawer.getByRole('button', { name: '返回', exact: true }).click()
  await evidenceAiButton.click()
  await evidenceDrawer.getByRole('button', { name: '删除文字资料 1', exact: true }).click()
  await evidenceDrawer.getByRole('button', { name: '删除文字资料 1', exact: true }).click()
  if (await evidenceButton.getAttribute('aria-label') !== '图文资料：共 1 张图片、0 段文字；已选 1 张图片、0 段文字') {
    throw new Error('evidence drawer did not remove text sources independently')
  }
  await evidenceDrawer.getByRole('button', { name: '关闭图文资料', exact: true }).click()
  if (await composer.inputValue() !== draftBeforeSelection) {
    throw new Error('opening image or mixed AI tools changed the composer draft')
  }

  // A later crop appends instead of replacing the first one.
  await interactionModeButton.click()
  await page.mouse.move(visiblePage.x + 220, visiblePage.y + 180)
  await page.mouse.down()
  await page.mouse.move(visiblePage.x + 360, visiblePage.y + 300, { steps: 5 })
  await page.mouse.up()
  if (await evidenceButton.getAttribute('aria-label') !== '图文资料：共 1 张图片、0 段文字；已选 1 张图片、0 段文字') {
    throw new Error('a direct composer crop unexpectedly entered the evidence basket')
  }
  await imageAiMenu.waitFor({ state: 'visible' })
  if (!(await imageAiMenu.textContent())?.includes('图片 AI · 1 个对话选区')) {
    throw new Error('image AI menu did not scope itself to direct composer crops only')
  }
  await imageAiMenu.locator('[data-pdf-image-ai-close="true"]').click()
  const duplicateAskCount = await page.locator('input[placeholder*="提问"], input[placeholder*="选框"]').count()
  const composerAttachmentCount = await composer.evaluate((textarea) => {
    const root = textarea.closest('[data-composer-card]')
    if (root === null) return 0
    return [...root.querySelectorAll('img')].filter(image => image.src.startsWith('blob:')).length
  })
  const selectionMarkerCount = await page.evaluate(`(() => {
    const wrapper = document.querySelector('div[data-page="${String(visiblePage.n)}"]')
    return wrapper?.querySelectorAll('[data-pdf-selection-destination] button[aria-label^="删除"]').length ?? 0
  })()`)
  const selectionRemoveLabels = await page.evaluate(`(() => {
    const wrapper = document.querySelector('div[data-page="${String(visiblePage.n)}"]')
    return [...(wrapper?.querySelectorAll('[data-pdf-selection-destination] button[aria-label^="删除"]') ?? [])].map(button => button.getAttribute('aria-label'))
  })()`)
  const typed = await composer.inputValue()
  if (duplicateAskCount !== 0) throw new Error(`duplicate PDF ask input remains: ${String(duplicateAskCount)}`)
  if (composerAttachmentCount !== 1) throw new Error(`expected one direct PDF crop in main composer, got ${String(composerAttachmentCount)}`)
  if (selectionMarkerCount !== 2) throw new Error(`expected two PDF selection markers, got ${String(selectionMarkerCount)}`)
  if (JSON.stringify(selectionRemoveLabels) !== JSON.stringify(['删除对话图片 1', '删除资料图片 1'])) {
    throw new Error(`PDF selection order is not visible: ${JSON.stringify(selectionRemoveLabels)}`)
  }
  if (typed !== draftBeforeSelection) throw new Error(`selection changed composer draft: ${JSON.stringify({ draftBeforeSelection, typed })}`)
  await page.keyboard.press('Escape')
  if (await interactionModeButton.getAttribute('data-pdf-interaction-mode') !== 'text'
    || await page.locator('[data-pdf-selection-layer="true"]').first().evaluate(element => getComputedStyle(element).pointerEvents) !== 'none') {
    throw new Error('Escape did not restore PDF text-selection mode')
  }
  console.log('=== typing ===')
  console.log(JSON.stringify({ page: visiblePage.n, selectedPdfText, textSelectionHighlightCount, aiReferenceDraft, duplicateAskCount, composerAttachmentCount, selectionMarkerCount, selectionRemoveLabels, typed }))

  // The evidence drawer is a direct view over source order. Move away, then
  // use its first image item to center that exact page-local crop again.
  await page.evaluate(`(() => {
    const scroller = document.querySelector('[data-pdf-scroll]')
    if (scroller) scroller.scrollTop = 0
  })()`)
  await page.waitForTimeout(300)
  await evidenceButton.click()
  await page.screenshot({ path: join(HERE, 'shot-selections.png') })
  await evidenceDrawer.locator('[data-pdf-evidence-image="true"] button').first().click()
  await page.waitForFunction((pageNumber) => {
    const wrapper = document.querySelector(`div[data-page="${String(pageNumber)}"]`)
    return wrapper?.querySelector('button[aria-label="删除资料图片 1"]') !== null
  }, visiblePage.n)
  await page.waitForTimeout(200)
  const locatedSelection = await page.evaluate(`(() => {
    const markerButton = document.querySelector('button[aria-label="删除资料图片 1"]')
    const marker = markerButton?.parentElement
    const scroller = document.querySelector('[data-pdf-scroll]')
    const markerRect = marker?.getBoundingClientRect()
    const scrollerRect = scroller.getBoundingClientRect()
    return {
      pageLabel: document.querySelector('[title="点击输入页码跳转"]')?.textContent ?? '',
      dx: markerRect ? Math.round((markerRect.left + markerRect.width / 2) - (scrollerRect.left + scroller.clientWidth / 2)) : 9999,
      dy: markerRect ? Math.round((markerRect.top + markerRect.height / 2) - (scrollerRect.top + scroller.clientHeight / 2)) : 9999,
    }
  })()`)
  if (!locatedSelection.pageLabel.startsWith(`${String(visiblePage.n)} /`)
    || Math.abs(locatedSelection.dx) > 8
    || Math.abs(locatedSelection.dy) > 8) {
    throw new Error(`evidence drawer failed to center its crop: ${JSON.stringify(locatedSelection)}`)
  }
  console.log('=== evidence drawer locate ===')
  console.log(JSON.stringify(locatedSelection))

  // IME composition: simulate a Chinese input sequence mid-composition while
  // a zoom settle lands (the repaint commits during composition).
  await composer.click()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: '测试', selectionStart: 2, selectionEnd: 2 })
  // Force a zoom gesture so its settle commit lands mid-composition.
  await page.evaluate(`(() => {
    const scroller = document.querySelector('[data-pdf-scroll]')
    scroller.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -30, bubbles: true, cancelable: true, clientX: 400, clientY: 400 }))
  })()`)
  await page.waitForTimeout(500)
  await cdp.send('Input.imeSetComposition', { text: '测试输入', selectionStart: 4, selectionEnd: 4 })
  await cdp.send('Input.insertText', { text: '测试输入' })
  await page.waitForTimeout(300)
  const imeTyped = await composer.inputValue()
  const active = await page.evaluate('document.activeElement ? document.activeElement.tagName + "/" + (document.activeElement.placeholder || "") : "none"')
  console.log('IME', JSON.stringify({ imeTyped, active }))
  await page.screenshot({ path: join(HERE, 'shot-typing.png') })

  // Removing PDF evidence leaves the independent direct composer crop alone.
  await evidenceDrawer.getByRole('button', { name: '删除图片资料 1', exact: true }).click()
  await evidenceButton.waitFor({ state: 'hidden' })
  const afterPdfRemove = await composer.evaluate((textarea) => {
    const root = textarea.closest('[data-composer-card]')
    if (root === null) return { count: 0, removeLabels: [] }
    return {
      count: [...root.querySelectorAll('img')].filter(image => image.src.startsWith('blob:')).length,
      removeLabels: [...root.querySelectorAll('button[aria-label$="selection-2.png"]')].map(button => button.getAttribute('aria-label')),
    }
  })
  const afterPdfRemoveMarkers = await page.evaluate(`(() => {
    const wrapper = document.querySelector('div[data-page="${String(visiblePage.n)}"]')
    return {
      count: wrapper?.querySelectorAll('[data-pdf-selection-destination] button[aria-label^="删除"]').length ?? 0,
      removeLabels: [...(wrapper?.querySelectorAll('[data-pdf-selection-destination] button[aria-label^="删除"]') ?? [])].map(button => button.getAttribute('aria-label')),
    }
  })()`)
  if (afterPdfRemove.count !== 1
    || !afterPdfRemove.removeLabels.some(label => /selection-2\.png$/.test(label ?? ''))
    || afterPdfRemoveMarkers.count !== 1
    || JSON.stringify(afterPdfRemoveMarkers.removeLabels) !== JSON.stringify(['删除对话图片 1'])) {
    throw new Error(`evidence removal changed the direct composer crop: ${JSON.stringify({ afterPdfRemove, afterPdfRemoveMarkers })}`)
  }
  console.log('=== evidence drawer remove ===')
  console.log(JSON.stringify({ afterPdfRemove, afterPdfRemoveMarkers }))

  // Add another direct crop, then remove the previous one from the composer.
  // Evidence remains empty and the surviving direct marker reindexes alone.
  await interactionModeButton.click()
  const freshSelectionPoint = await page.evaluate(() => {
    const scroller = document.querySelector('[data-pdf-scroll]')
    if (!(scroller instanceof HTMLElement)) return null
    const scrollerRect = scroller.getBoundingClientRect()
    for (const wrapper of scroller.querySelectorAll('div[data-page]')) {
      const layer = wrapper.querySelector('[data-pdf-selection-layer="true"]')
      if (!(layer instanceof HTMLElement)) continue
      const rect = layer.getBoundingClientRect()
      const left = Math.max(rect.left, scrollerRect.left)
      const top = Math.max(rect.top, scrollerRect.top)
      const right = Math.min(rect.right, scrollerRect.right)
      const bottom = Math.min(rect.bottom, scrollerRect.bottom)
      if (right - left >= 240 && bottom - top >= 200) {
        return { x: left + 20, y: top + 20 }
      }
    }
    return null
  })
  if (freshSelectionPoint === null) throw new Error('no fresh visible selection point')
  await page.mouse.move(freshSelectionPoint.x, freshSelectionPoint.y)
  await page.mouse.down()
  await page.mouse.move(freshSelectionPoint.x + 180, freshSelectionPoint.y + 140, { steps: 5 })
  await page.mouse.up()
  await imageAiMenu.waitFor({ state: 'visible' })
  if (await evidenceButton.count() !== 0) throw new Error('direct crop recreated evidence implicitly')
  await page.locator('button[aria-label$="selection-2.png"]').click()
  const afterComposerRemove = await page.evaluate(`(() => {
    const wrapper = document.querySelector('div[data-page="${String(visiblePage.n)}"]')
    return {
      count: wrapper?.querySelectorAll('[data-pdf-selection-destination] button[aria-label^="删除"]').length ?? 0,
      removeLabels: [...(wrapper?.querySelectorAll('[data-pdf-selection-destination] button[aria-label^="删除"]') ?? [])].map(button => button.getAttribute('aria-label')),
    }
  })()`)
  if (afterComposerRemove.count !== 1
    || JSON.stringify(afterComposerRemove.removeLabels) !== JSON.stringify(['删除对话图片 1'])) {
    throw new Error(`composer-side crop removal did not reindex the PDF marker: ${JSON.stringify(afterComposerRemove)}`)
  }
  console.log('=== composer selection remove ===')
  console.log(JSON.stringify(afterComposerRemove))

  // Move the remaining direct crop into evidence, then clear evidence. Both
  // transitions must keep the composer empty and preserve its text draft.
  await page.getByRole('button', { name: '打开对话图片 1 操作', exact: true }).click()
  await imageAiMenu.waitFor({ state: 'visible' })
  await imageAiMenu.locator('[data-pdf-image-ai-action="add-evidence"]').click()
  await page.getByRole('button', { name: '图文资料：共 1 张图片、0 段文字；已选 1 张图片、0 段文字', exact: true }).waitFor({ state: 'visible' })
  const attachmentCountAfterSecondMove = await composer.evaluate((textarea) => {
    const root = textarea.closest('[data-composer-card]')
    return root === null ? 0 : [...root.querySelectorAll('img')].filter(image => image.src.startsWith('blob:')).length
  })
  if (attachmentCountAfterSecondMove !== 0) throw new Error('explicit evidence move kept its composer duplicate')
  await evidenceButton.click()
  await evidenceDrawer.locator('[data-pdf-evidence-clear="true"]').click()
  await page.waitForTimeout(200)
  const clearedAttachmentCount = await composer.evaluate((textarea) => {
    const root = textarea.closest('[data-composer-card]')
    if (root === null) return 0
    return [...root.querySelectorAll('img')].filter(image => image.src.startsWith('blob:')).length
  })
  if (clearedAttachmentCount !== 0) throw new Error('clearing PDF selections left composer attachments behind')
  if (await composer.inputValue() !== imeTyped) throw new Error('cancelling PDF selection changed composer text')
  console.log('=== evidence drawer clear ===')
  console.log(JSON.stringify({ clearedAttachmentCount }))

  // Reattach once, then close the document. A cancelled unsaved-change
  // confirmation keeps both document and crop; accepting it releases the
  // exact PDF state and allows the same source file to be selected again.
  await page.mouse.move(freshSelectionPoint.x, freshSelectionPoint.y)
  await page.mouse.down()
  await page.mouse.move(freshSelectionPoint.x + 180, freshSelectionPoint.y + 140, { steps: 5 })
  await page.mouse.up()
  await imageAiMenu.waitFor({ state: 'visible' })
  if (await evidenceButton.count() !== 0) throw new Error('final direct crop entered evidence implicitly')

  const closeCurrentPdf = page.getByRole('button', { name: '关闭当前 PDF', exact: true })
  await page.locator('[data-pdf-unsaved-annotations="true"]').waitFor({ state: 'visible' })
  page.once('dialog', dialog => { void dialog.dismiss() })
  await closeCurrentPdf.click()
  await closeCurrentPdf.waitFor({ state: 'visible' })
  const attachmentAfterCancelledClose = await composer.evaluate((textarea) => {
    const root = textarea.closest('[data-composer-card]')
    return root === null ? 0 : [...root.querySelectorAll('img')].filter(image => image.src.startsWith('blob:')).length
  })
  if (attachmentAfterCancelledClose !== 1) throw new Error('cancelled PDF close released the current crop')

  page.once('dialog', dialog => { void dialog.accept() })
  await closeCurrentPdf.click()
  await page.waitForFunction(() => document.querySelectorAll('[data-pdf-document-tab]').length === 1)
  const attachmentAfterConfirmedClose = await composer.evaluate((textarea) => {
    const root = textarea.closest('[data-composer-card]')
    return root === null ? 0 : [...root.querySelectorAll('img')].filter(image => image.src.startsWith('blob:')).length
  })
  if (attachmentAfterConfirmedClose !== 0 || await composer.inputValue() !== imeTyped) {
    throw new Error(`confirmed PDF close did not release only PDF state: ${JSON.stringify({ attachmentAfterConfirmedClose, draft: await composer.inputValue() })}`)
  }

  // The remaining tab stays open. Closing it exercises the last-document
  // transition back to the file-picker state.
  await closeCurrentPdf.click()
  await closeCurrentPdf.waitFor({ state: 'hidden' })

  await page.locator('input[type="file"]').setInputFiles(PDF_PATH)
  await closeCurrentPdf.waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForSelector('div[data-page="1"] canvas', { timeout: 15000 })
  const reopenedDocumentName = await page.locator('[data-pdf-document-name="true"]').innerText()
  if (reopenedDocumentName !== PDF_NAME) throw new Error(`same PDF did not reopen after close: ${reopenedDocumentName}`)
  console.log('=== close and reopen current PDF ===')
  console.log(JSON.stringify({ cancelledPreserved: true, confirmedReleased: true, reopenedDocumentName }))

  // Conversation-local IndexedDB state must survive a full page refresh. Use
  // a non-default page, a view-only rotation, and an explicitly excluded
  // evidence image so restoring only the document name cannot satisfy it.
  await hoverNavigationControls()
  await page.getByTitle('点击输入页码跳转').click()
  await page.locator('input[type="number"]').fill('7')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('[title="点击输入页码跳转"]')?.textContent?.startsWith('7 /') === true)
  await openRotationMenu()
  await page.locator('[data-pdf-rotate-current-right="true"]').click()
  await page.waitForFunction(() => document.querySelector('div[data-page="7"]')?.dataset['pdfRotation'] === '90')

  await interactionModeButton.click()
  const persistenceSelectionPoint = await page.evaluate(() => {
    const scroller = document.querySelector('[data-pdf-scroll]')
    if (!(scroller instanceof HTMLElement)) return null
    const scrollerRect = scroller.getBoundingClientRect()
    for (const wrapper of scroller.querySelectorAll('div[data-page]')) {
      const layer = wrapper.querySelector('[data-pdf-selection-layer="true"]')
      if (!(layer instanceof HTMLElement)) continue
      const rect = layer.getBoundingClientRect()
      const left = Math.max(rect.left, scrollerRect.left)
      const top = Math.max(rect.top, scrollerRect.top)
      const right = Math.min(rect.right, scrollerRect.right)
      const bottom = Math.min(rect.bottom, scrollerRect.bottom)
      if (right - left >= 180 && bottom - top >= 140) return { x: left + 20, y: top + 20 }
    }
    return null
  })
  if (persistenceSelectionPoint === null) throw new Error('no visible point for PDF session persistence crop')
  await page.mouse.move(persistenceSelectionPoint.x, persistenceSelectionPoint.y)
  await page.mouse.down()
  await page.mouse.move(persistenceSelectionPoint.x + 130, persistenceSelectionPoint.y + 100, { steps: 5 })
  await page.mouse.up()
  await imageAiMenu.waitFor({ state: 'visible' })
  await imageAiMenu.locator('[data-pdf-image-ai-action="add-evidence"]').click()
  const persistenceEvidenceButton = page.getByRole('button', { name: '图文资料：共 1 张图片、0 段文字；已选 1 张图片、0 段文字', exact: true })
  await persistenceEvidenceButton.click()
  await page.getByRole('checkbox', { name: '本次提问使用图片资料 1', exact: true }).uncheck()
  await page.waitForTimeout(900)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-pdf-document-name="true"]').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForFunction(() => (
    document.querySelector('[title="点击输入页码跳转"]')?.textContent?.startsWith('7 /') === true
      && document.querySelector('div[data-page="7"]')?.dataset['pdfRotation'] === '90'
  ), { timeout: 15000 })
  const restoredEvidenceButton = page.getByRole('button', { name: '图文资料：共 1 张图片、0 段文字；已选 0 张图片、0 段文字', exact: true })
  await restoredEvidenceButton.waitFor({ state: 'visible' })
  await page.locator('[data-pdf-save-menu-button="true"]').click()
  const restoredOverwriteDisabled = await page.locator('[data-pdf-overwrite="true"]').isDisabled()
  if (!restoredOverwriteDisabled) throw new Error('restored PDF unexpectedly retained source overwrite permission')
  await page.locator('[data-pdf-save-menu-button="true"]').click()
  console.log('=== conversation PDF refresh restore ===')
  console.log(JSON.stringify({ document: PDF_NAME, page: 7, rotation: 90, evidenceSelected: 0, overwriteDisabled: true }))

  // Close the reader window: every pushed style must restore.
  await page.getByRole('button', { name: '收起 PDF 阅读器', exact: true }).dispatchEvent('click')
  await page.waitForTimeout(1200)

  const switchRows = page.getByRole('treeitem')
  if (await switchRows.count() > 2) {
    const selectedSession = page.locator('[role="treeitem"][aria-selected="true"]')
    const originalSessionText = (await selectedSession.textContent())?.trim() ?? ''
    let alternativeIndex = -1
    for (let index = 1; index < await switchRows.count(); index += 1) {
      if (await switchRows.nth(index).getAttribute('aria-selected') !== 'true') {
        alternativeIndex = index
        break
      }
    }
    if (alternativeIndex < 0) throw new Error('no alternate session row was available')
    await switchRows.nth(alternativeIndex).click()
    await page.waitForTimeout(300)
    if (originalSessionText.length === 0) throw new Error('current session row was not identifiable before switch')
    await page.getByRole('treeitem').filter({ hasText: originalSessionText }).first().click()
    await page.waitForTimeout(500)
    const restoredComposer = page.locator('textarea').last()
    const restoredAttachmentCount = await restoredComposer.evaluate((textarea) => {
      const root = textarea.closest('[data-composer-card]')
      if (root === null) return 0
      return [...root.querySelectorAll('img')].filter(image => image.src.startsWith('blob:')).length
    })
    const restoredDraft = await restoredComposer.inputValue()
    if (restoredAttachmentCount !== 0) throw new Error('session switch restored a crop released by closing the PDF')
    if (restoredDraft !== imeTyped) throw new Error('session switch changed the existing text draft')
    console.log('SESSION SWITCH', JSON.stringify({ restoredAttachmentCount, restoredDraft }))
  }

  console.log('=== after exit ===')
  console.log(JSON.stringify(await page.evaluate(geometry), null, 2))
  await page.screenshot({ path: join(HERE, 'shot-exit.png') })

  // Closing is stronger than collapsing: it deletes this conversation's
  // local recovery record, so a later refresh must return to the picker.
  await page.getByRole('button', { name: '显示或收起 PDF 阅读器', exact: true }).click()
  await closeCurrentPdf.waitFor({ state: 'visible' })
  page.once('dialog', dialog => { void dialog.accept() })
  await closeCurrentPdf.click()
  await closeCurrentPdf.waitFor({ state: 'hidden' })
  await page.waitForTimeout(900)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '选择 PDF 文件…', exact: true }).waitFor({ state: 'visible', timeout: 15000 })
  if (await page.locator('[data-pdf-document-name="true"]').count() !== 0) {
    throw new Error('explicit PDF close left a refresh-restorable document behind')
  }
  console.log('=== explicit close clears conversation PDF ===')
  console.log(JSON.stringify({ restoredAfterClose: false }))

  await browser.close()
}

run().catch((err) => { console.error(err); process.exit(1) })
