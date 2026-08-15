import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Unit specs run by default; `*.e2e.ts` spends real tokens and is opt-in
    // by naming the file explicitly.
    include: ['tests/**/*.spec.ts'],
    typecheck: { enabled: false },
  },
})
