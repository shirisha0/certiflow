import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // E2E tests share one database, so run test files one after another.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
