import { defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config'

// Kept separate from vite.config.ts so the renderer build stays on plain
// `vite`'s types and never imports vitest — this file is the only place that
// knows about tests. Merging (rather than redeclaring) inherits the `@` /
// `@hermes/shared` aliases and the react dedupe, which the component tests need.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Electron main-process tests use node:test and are run separately by
      // `test:desktop:platforms`; Vitest should only collect renderer tests.
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      // jsdom is also passed by `test:ui`'s --environment flag; setting it here
      // means a bare `npx vitest run` behaves the same, instead of failing with
      // `document is not defined`.
      environment: 'jsdom',
      // Loads the jsdom shims (CSS.escape) before any test module evaluates.
      setupFiles: ['./src/test-setup.ts']
    }
  })
)
