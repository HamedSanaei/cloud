import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup-env.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
    },
  },
})