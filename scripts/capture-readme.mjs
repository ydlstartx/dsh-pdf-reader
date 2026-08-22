/**
 * Capture the README walkthrough with the openly licensed Dive into Deep
 * Learning PDF. The script only drives local UI; it never submits an AI turn.
 *
 * Usage:
 *   D2L_PDF=/absolute/path/to/d2l-en.pdf node scripts/capture-readme.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const defaultHarnessRoot = join(dirname(dirname(ROOT)), 'deepseek-harness')
const harnessRoot = process.env['DSH_ROOT'] ?? defaultHarnessRoot
const require = createRequire(join(harnessRoot, 'apps', 'web', 'package.json'))
const { chromium } = require('playwright')

const d2lPath = process.env['D2L_PDF']
if (d2lPath === undefined || d2lPath.trim() === '') {
  throw new Error('Set D2L_PDF to an absolute path to the Dive into Deep Learning PDF.')
}

const outputDir = join(ROOT, 'docs', 'images', 'readme')
mkdirSync(outputDir, { recursive: true })

const gotoPage = async (page, pageNumber) => {
  const controls = page.locator('[data-pdf-navigation-controls]')
  const box = await controls.boundingBox()
  if (box === null) throw new Error('PDF navigation controls are unavailable.')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(220)
  await page.getByTitle('点击输入页码跳转').click()
  const input = page.locator('input[type="number"]')
  await input.fill(String(pageNumber))
  await input.press('Enter')
  await page.waitForFunction((target) => {
    const canvas = document.querySelector(`div[data-page="${String(target)}"] canvas`)
    return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0
  }, pageNumber, { timeout: 20_000 })
  await page.waitForTimeout(650)
}

const selectTextSpan = async (page, pageNumber, needle) => {
  await page.waitForFunction((target) => (
    document.querySelector(`div[data-page="${String(target)}"] [data-pdf-text-layer="true"]`)
      ?.getAttribute('data-pdf-has-text') === 'true'
  ), pageNumber, { timeout: 10_000 })
  const box = await page.evaluate(({ target, text }) => {
    const spans = [...document.querySelectorAll(`div[data-page="${String(target)}"] [data-pdf-text-layer="true"] span`)]
    const span = spans.find(candidate => candidate.textContent?.includes(text))
      ?? spans.find(candidate => (candidate.textContent?.trim().length ?? 0) > 35)
    if (!(span instanceof HTMLElement)) return null
    const rect = span.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }, { target: pageNumber, text: needle })
  if (box === null) throw new Error(`No selectable text found on PDF page ${String(pageNumber)}.`)
  await page.mouse.move(box.x + 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + Math.max(4, box.width - 2), box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  await page.locator('[data-pdf-annotation-menu="true"]').waitFor({ state: 'visible', timeout: 5_000 })
}

const run = async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
    await page.goto('http://127.0.0.1:3080', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2_000)

    const demoSession = page.getByRole('treeitem', { name: '新会话', exact: true })
    if (await demoSession.count() > 0) await demoSession.last().click()
    await page.waitForTimeout(700)

    await page.locator('input[type="file"]').setInputFiles(resolve(d2lPath))
    await page.waitForSelector('div[data-page="1"] canvas', { timeout: 20_000 })
    await page.waitForTimeout(1_000)

    // Hero: a real Transformer page plus the whole-document question surface.
    await gotoPage(page, 482)
    await page.screenshot({ path: join(outputDir, 'd2l-overview.png') })
    await page.locator('[data-pdf-document-ai="true"]').click()
    await page.getByRole('textbox', { name: '询问 PDF 的问题', exact: true })
      .fill('请结合图 11.7.1 解释 Transformer 编码器和解码器的信息流。')
    await page.screenshot({ path: join(outputDir, 'd2l-ask-pdf.png') })
    await page.getByRole('button', { name: '关闭询问 PDF', exact: true }).click()

    // Native text: selection, compact annotation controls, and AI reading menu.
    await gotoPage(page, 473)
    await selectTextSpan(page, 473, 'Before providing the implementation')
    await page.getByRole('button', { name: 'AI 阅读工具', exact: true }).click()
    await page.locator('[data-pdf-ai-menu="true"]').waitFor({ state: 'visible' })
    await page.screenshot({ path: join(outputDir, 'd2l-text-ai.png') })
    await page.keyboard.press('Escape')

    await selectTextSpan(page, 473, 'Based on this design')
    await page.getByRole('button', { name: '使用黄色高亮', exact: true }).click()
    await page.locator('[data-pdf-text-markup-annotation="true"]').first().waitFor({ state: 'visible' })
    await page.screenshot({ path: join(outputDir, 'd2l-annotation.png') })

    // Mixed evidence: crop the Transformer figure, then pair its caption text.
    await gotoPage(page, 482)
    const interactionMode = page.locator('[data-pdf-interaction-mode-button="true"]')
    await interactionMode.click()
    const figureBox = await page.evaluate(() => {
      const pageElement = document.querySelector('div[data-page="482"]')
      const scroller = document.querySelector('[data-pdf-scroll]')
      if (!(pageElement instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return null
      const pageRect = pageElement.getBoundingClientRect()
      const scrollRect = scroller.getBoundingClientRect()
      const x1 = pageRect.left + pageRect.width * 0.30
      const y1 = pageRect.top + pageRect.height * 0.06
      const x2 = pageRect.left + pageRect.width * 0.77
      const y2 = pageRect.top + pageRect.height * 0.49
      return {
        x1: Math.max(x1, scrollRect.left + 8),
        y1: Math.max(y1, scrollRect.top + 8),
        x2: Math.min(x2, scrollRect.right - 8),
        y2: Math.min(y2, scrollRect.bottom - 8),
      }
    })
    if (figureBox === null) throw new Error('Transformer figure is unavailable.')
    await page.mouse.move(figureBox.x1, figureBox.y1)
    await page.mouse.down()
    await page.mouse.move(figureBox.x2, figureBox.y2, { steps: 10 })
    await page.mouse.up()
    const imageMenu = page.locator('[data-pdf-image-ai-menu="true"]')
    await imageMenu.waitFor({ state: 'visible', timeout: 5_000 })
    await imageMenu.locator('[data-pdf-image-ai-action="add-evidence"]').click()
    await interactionMode.click()

    await selectTextSpan(page, 482, 'The Transformer architecture')
    await page.getByRole('button', { name: 'AI 阅读工具', exact: true }).click()
    const textAiMenu = page.locator('[data-pdf-ai-menu="true"]')
    await textAiMenu.locator('[data-pdf-ai-action="evidence"]').click()

    const evidenceButton = page.locator('[data-pdf-evidence-button="true"]')
    await evidenceButton.click()
    const evidenceDrawer = page.locator('[data-pdf-evidence-drawer="true"]')
    await evidenceDrawer.waitFor({ state: 'visible' })
    const selectAllEvidence = evidenceDrawer.locator('[data-pdf-evidence-select-all="true"]')
    if (await selectAllEvidence.isEnabled()) await selectAllEvidence.click()
    await evidenceDrawer.locator('[data-pdf-evidence-ai-button="true"]').click()
    await evidenceDrawer.locator('[data-pdf-evidence-ai-action="question"]').click()
    await evidenceDrawer.getByRole('textbox', { name: '图文资料问题', exact: true })
      .fill('图中的每个模块分别对应正文中的哪些计算步骤？')
    await page.screenshot({ path: join(outputDir, 'd2l-mixed-evidence.png') })
    await evidenceDrawer.getByRole('button', { name: '关闭图文资料', exact: true }).click()

    await evidenceButton.click()
    await evidenceDrawer.waitFor({ state: 'visible' })
    await evidenceDrawer.getByRole('button', { name: '删除图片资料 1', exact: true }).click()
    await evidenceDrawer.getByRole('button', { name: '删除文字资料 1', exact: true }).click()
    await evidenceDrawer.waitFor({ state: 'hidden' })

  } finally {
    await browser.close()
  }
}

await run()
