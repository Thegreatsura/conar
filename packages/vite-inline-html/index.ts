import { createHash } from 'node:crypto'

import type { Plugin } from 'vite'

import { PLUGIN_NAME, replaceMarkers } from './utils.ts'

interface InlineHtmlOptions {
  scripts: { marker: string; entry: string }[]
  // A script-src placeholder filled with the inlined scripts' sha256 hashes in a build, so the CSP needs no 'unsafe-inline'. Dev keeps 'unsafe-inline': Vite injects the React Fast Refresh preamble as an inline script whose bytes we never see.
  cspMarker?: string
}

const bundleScript = async (root: string, entry: string) => {
  const { build } = await import('vite')
  const result = await build({
    build: {
      lib: { entry, fileName: 'inline', formats: ['iife'], name: 'inline' },
      write: false,
    },
    configFile: false,
    logLevel: 'error',
    root,
  })

  const [bundle] = Array.isArray(result) ? result : [result]
  const chunk = 'output' in bundle ? bundle.output[0] : null

  if (chunk?.type !== 'chunk') {
    throw new Error(`[${PLUGIN_NAME}] ${entry} produced no chunk`)
  }

  return chunk.code
}

// Hashes the script's text exactly as it sits between the tags, so the CSP matches what the browser parses.
const scriptHash = (code: string) =>
  `'sha256-${createHash('sha256').update(code).digest('base64')}'`

export const inlineHtml = ({
  scripts,
  cspMarker,
}: InlineHtmlOptions): Plugin => {
  let bundles = new Map<string, Promise<string>>()
  let root: string
  let isBuild = false

  return {
    configResolved({ root: resolved, command }) {
      root = resolved
      isBuild = command === 'build'
    },
    configureServer(server) {
      server.watcher.on('change', (file) => {
        if (file.startsWith(root)) {
          bundles = new Map()
        }
      })
    },
    name: PLUGIN_NAME,
    async transformIndexHtml(html) {
      const inlined = await Promise.all(
        scripts.map(async ({ marker, entry }) => {
          const code = bundles.get(entry) ?? bundleScript(root, entry)
          bundles.set(entry, code)

          return { code: await code, marker }
        })
      )

      const replacements: [string, string][] = inlined.map(
        ({ marker, code }) => [marker, `<script>${code}</script>`]
      )

      if (cspMarker) {
        replacements.push([
          cspMarker,
          isBuild
            ? inlined.map(({ code }) => scriptHash(code)).join(' ')
            : `'unsafe-inline'`,
        ])
      }

      return replaceMarkers(html, replacements)
    },
  }
}
