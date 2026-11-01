/**
 * Build configuration for the dsh-pdf-reader dual-face plugin.
 *
 * Three browser/host surfaces land in lib/:
 *   - lib/index.js    Node half, loaded by the host Cordis Loader.
 *   - lib/client.js   Browser half, served at /plugins/dsh-pdf-reader/client.js
 *                     and fetched by the Web shell module loader.
 *   - lib/ocr-assets/ Lazy PaddleOCR runtime, loaded only after permission.
 *
 * The browser bundle mirrors the harness client preset: it wraps the factory
 * in `window.__ModuleLoader__.load({ id, factory })` and resolves platform
 * modules (react, cordis, slots, web-react, …) through the injected require;
 * everything else is inlined. Styles are inlined in components, so no CSS
 * pipeline is needed.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

/** Plugin id — the Loader entry name and the /plugins/<id>/ bundle route. */
const ID = 'dsh-pdf-reader'

/**
 * Virtual module `virtual:pdfjs-worker`: the pdf.js worker source as a
 * string. The browser half builds a blob-URL module worker from it, so the
 * bundle stays one self-contained file (no asset URLs, no import.meta).
 */
const PDFJS_WORKER_VIRTUAL = '\0virtual:pdfjs-worker'
const PDFJS_BINARY_DATA_VIRTUAL = '\0virtual:pdfjs-binary-data'
const pdfjsWorkerRaw = {
  name: 'pdfjs-worker-raw',
  resolveId(source: string): string | null {
    return source === 'virtual:pdfjs-worker' ? PDFJS_WORKER_VIRTUAL : null
  },
  load(id: string): string | null {
    if (id !== PDFJS_WORKER_VIRTUAL) return null
    const require = createRequire(import.meta.url)
    const workerPath = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs')
    return `export default ${JSON.stringify(readFileSync(workerPath, 'utf8'))};`
  },
}

/**
 * pdf.js loads packed CMaps, fallback fonts, and image-codec WASM on demand.
 * The Harness only serves this plugin's client.js entry, so expose those
 * official pdfjs-dist assets through the same self-contained bundle rather
 * than relying on unavailable relative URLs.
 */
const pdfjsBinaryDataRaw = {
  name: 'pdfjs-binary-data-raw',
  resolveId(source: string): string | null {
    return source === 'virtual:pdfjs-binary-data' ? PDFJS_BINARY_DATA_VIRTUAL : null
  },
  load(id: string): string | null {
    if (id !== PDFJS_BINARY_DATA_VIRTUAL) return null
    const require = createRequire(import.meta.url)
    const workerPath = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs')
    const pdfjsRoot = join(dirname(workerPath), '..')
    const groups = [
      { kind: 'cMapUrl', directory: 'cmaps', extensions: ['.bcmap'] },
      { kind: 'standardFontDataUrl', directory: 'standard_fonts', extensions: ['.pfb', '.ttf'] },
      { kind: 'wasmUrl', directory: 'wasm', extensions: ['.wasm'] },
    ] as const
    const encoded: Record<string, string> = {}
    for (const group of groups) {
      const directory = join(pdfjsRoot, group.directory)
      for (const filename of readdirSync(directory)) {
        if (!group.extensions.some(extension => filename.endsWith(extension))) continue
        encoded[`${group.kind}:${filename}`] = readFileSync(join(directory, filename)).toString('base64')
      }
    }
    return `export default ${JSON.stringify(encoded)};`
  },
}

/** Paddle's worker is already a self-contained browser module; publish it as a lazy asset. */
const paddleOcrWorkerAsset = {
  name: 'paddle-ocr-worker-asset',
  buildStart(this: { emitFile: (asset: { type: 'asset'; fileName: string; source: string }) => void }) {
    const assets = join(dirname(fileURLToPath(import.meta.resolve('@paddleocr/paddleocr-js'))), 'assets')
    const worker = readdirSync(assets).find(filename => /^worker-entry-.*\.js$/u.test(filename))
    if (worker === undefined) throw new Error('PaddleOCR worker asset is missing')
    this.emitFile({
      type: 'asset',
      fileName: 'ocr-worker.js',
      source: readFileSync(join(assets, worker), 'utf8'),
    })
  },
}

/**
 * OpenCV's universal distribution contains guarded Node-only `fs`/`path`
 * branches. They are unreachable in this browser build, but resolving them to
 * inert virtual modules keeps the static bundler from reporting false missing
 * dependency warnings. The real browser OCR path is smoke-tested after build.
 */
const BROWSER_NODE_STUB_PREFIX = '\0browser-node-stub:'
const browserNodeBuiltinStubs = {
  name: 'browser-node-builtin-stubs',
  resolveId(source: string): string | null {
    return source === 'fs' || source === 'path' ? `${BROWSER_NODE_STUB_PREFIX}${source}` : null
  },
  load(id: string): string | null {
    return id.startsWith(BROWSER_NODE_STUB_PREFIX) ? 'export default {};' : null
  },
}

/**
 * Browser platform modules the Web shell seeds into its frozen module table
 * (mirror of `PLATFORM_MODULES` in the running Harness `client/web`
 * package). These are the only specifiers a dynamic bundle may `require()`
 * from the table; every other module must inline.
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

/** Node-half externals: provided by the profile's installed dependency tree. */
const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-tools',
]

export default defineConfig([
  {
    name: ID,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: true,
    fixedExtension: false,
    clean: false,
    deps: {
      neverBundle: [...HOST_EXTERNALS],
    },
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: [...PLATFORM_MODULES],
      alwaysBundle: (id: string) => (PLATFORM_MODULES.includes(id as never) ? undefined : true),
      onlyBundle: false,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    // Anything not in the platform table must inline: a require() the frozen
    // module table cannot answer is a guaranteed runtime throw. pdfjs-dist
    // therefore inlines into the bundle when the reader lands. (pdf.js also
    // keeps a Node-only canvas factory behind its `isNodeJS` guard that calls
    // `require("url")`; that guard is false in every browser, so the request
    // stays in dead code and never reaches the module table.)
    plugins: [pdfjsWorkerRaw, pdfjsBinaryDataRaw],
    outputOptions: {
      entryFileNames: 'client.js',
      // A lazy chunk registers under its own file name; the entry registers as
      // the plugin id. The loader keys the module table by these strings.
      banner: (chunk: { isEntry: boolean; fileName: string }): string => {
        const identity = chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `
        return `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, ${identity}factory: (require) => {`
      },
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      chunkFileNames: 'client.[name].js',
    },
  },
  {
    name: `${ID}/ocr-runtime`,
    entry: { 'ocr-runtime': 'src/client/ocr-runtime.ts' },
    outDir: 'lib/ocr-assets',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: false,
    codeSplitting: false,
    clean: false,
    deps: {
      alwaysBundle: () => true,
      onlyBundle: false,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    plugins: [browserNodeBuiltinStubs, paddleOcrWorkerAsset],
    outputOptions: {
      entryFileNames: 'ocr-runtime.js',
      chunkFileNames: '[name].js',
    },
  },
])
