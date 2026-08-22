/** Lightweight browser compatibility smoke for an ephemeral Harness checkout. */

import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = dirname(here)
const harnessRoot = process.env['DSH_ROOT']
if (harnessRoot === undefined) throw new Error('DSH_ROOT must point to a DeepSeek Harness checkout')

const require = createRequire(join(harnessRoot, 'apps', 'web', 'package.json'))
const { chromium } = require('playwright')
const pdfPath = process.env['PDF_PATH'] ?? join(pluginRoot, 'test-fixtures', 'test.pdf')
const artifactDir = process.env['UI_SMOKE_ARTIFACT_DIR'] ?? join(pluginRoot, 'ui-smoke-artifacts')
const workspacePath = process.env['UI_SMOKE_WORKSPACE_DIR'] ?? artifactDir
const baseUrl = process.env['DSH_WEB_URL'] ?? 'http://127.0.0.1:3080'

await mkdir(artifactDir, { recursive: true })
await mkdir(workspacePath, { recursive: true })

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const pageErrors = []
page.on('pageerror', error => { pageErrors.push(String(error)) })

const picker = page.locator('input[type="file"][accept*=".pdf"]')
const waitForPicker = async (timeout) => picker.waitFor({ state: 'attached', timeout }).then(
  () => true,
  () => false,
)

/** A pristine Harness home blocks the app until its versioned notice is acknowledged. */
const acknowledgeHarnessWelcome = async () => {
  const continueButton = page.getByRole('button', { name: /^(?:Continue|继续)$/ })
  const visible = await continueButton.waitFor({ state: 'visible', timeout: 3_000 }).then(
    () => true,
    () => false,
  )
  if (!visible) return
  await continueButton.click()
  await continueButton.waitFor({ state: 'hidden', timeout: 15_000 })
}

/** PDF rendering needs no model credential, so use Harness's supported defer action. */
const deferHarnessProviderSetup = async () => {
  const configureLaterButton = page.getByRole('button', { name: /^(?:Configure later|稍后配置)$/ })
  const visible = await configureLaterButton.waitFor({ state: 'visible', timeout: 10_000 }).then(
    () => true,
    () => false,
  )
  if (!visible) return
  await configureLaterButton.click()
  await configureLaterButton.waitFor({ state: 'hidden', timeout: 15_000 })
}

/** A fresh CI profile has no Workspace, so no session-scoped PDF panel exists yet. */
const ensureWorkspaceSession = async () => {
  if (await waitForPicker(3_000)) return

  const chooseWorkspace = page.getByRole('button', { name: /^(?:Choose workspace|选择工作区)$/ })
  await chooseWorkspace.first().waitFor({ state: 'visible', timeout: 15_000 })
  await chooseWorkspace.first().click()

  const editPath = page.getByRole('button', { name: /^(?:Edit path|编辑路径)$/ })
  await editPath.waitFor({ state: 'visible', timeout: 15_000 })
  await editPath.click()

  const pathEditor = page.getByRole('textbox', { name: /^(?:Edit path|编辑路径)$/ })
  await pathEditor.fill(workspacePath)
  await pathEditor.press('Enter')

  const openDirectory = page.getByRole('button', { name: /^(?:Open|打开)$/ })
  await openDirectory.waitFor({ state: 'visible', timeout: 15_000 })
  await openDirectory.click()

  if (!await waitForPicker(20_000)) {
    throw new Error('PDF reader did not mount after selecting the smoke-test Workspace')
  }
}

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1_000)
  await acknowledgeHarnessWelcome()
  await deferHarnessProviderSetup()

  const sessionRows = page.getByRole('treeitem')
  if (await sessionRows.count() > 1) await sessionRows.nth(1).click()

  await ensureWorkspaceSession()
  await picker.setInputFiles(pdfPath)
  await page.waitForSelector('div[data-page="1"] canvas', { timeout: 20_000 })
  await page.waitForFunction(() => {
    const canvas = document.querySelector('div[data-page="1"] canvas')
    return canvas instanceof HTMLCanvasElement && canvas.width > 1 && canvas.height > 1
  }, { timeout: 20_000 })

  await picker.setInputFiles(pdfPath)
  const tabs = page.locator('[data-pdf-document-tab]')
  await tabs.nth(1).waitFor({ state: 'visible', timeout: 20_000 })
  if (await tabs.count() !== 2) throw new Error(`Expected two PDF tabs, found ${String(await tabs.count())}`)

  await tabs.first().click()
  await page.waitForSelector('div[data-page="1"] canvas', { timeout: 20_000 })
  await page.locator('[data-pdf-thumbnails-button="true"]').click()
  const thumbnailCanvas = page.locator('[data-pdf-thumbnail-canvas="true"]').first()
  await thumbnailCanvas.waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForFunction(() => {
    const canvas = document.querySelector('[data-pdf-thumbnail-canvas="true"]')
    return canvas instanceof HTMLCanvasElement && canvas.width > 1 && canvas.height > 1
  }, { timeout: 20_000 })

  if (pageErrors.length > 0) throw new Error(`Page errors: ${pageErrors.join(' | ')}`)
  await page.screenshot({ path: join(artifactDir, 'success.png'), fullPage: true })
  console.log(JSON.stringify({
    pdf: basename(pdfPath),
    tabs: await tabs.count(),
    renderedPage: true,
    renderedThumbnail: true,
  }))
} catch (error) {
  console.error(JSON.stringify({
    url: page.url(),
    pageErrors,
    pdfPickerCount: await picker.count(),
    workspaceChooserCount: await page.getByRole('button', { name: /^(?:Choose workspace|选择工作区)$/ }).count(),
    welcomeContinueCount: await page.getByRole('button', { name: /^(?:Continue|继续)$/ }).count(),
    configureLaterCount: await page.getByRole('button', { name: /^(?:Configure later|稍后配置)$/ }).count(),
  }))
  await page.screenshot({ path: join(artifactDir, 'failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await browser.close()
}
