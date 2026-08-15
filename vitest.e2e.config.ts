import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.ts'],
    typecheck: { enabled: false },
    // The CLI is a real process talking to a real model; one at a time keeps
    // the account's rate limit out of the results.
    fileParallelism: false,
    testTimeout: 120_000,
  },
})
