import path from 'path';
import { defineConfig } from 'vitest/config';

const root = path.resolve(__dirname, '../..');

export default defineConfig({
  resolve: {
    alias: {
      '@pixel-agents/core': path.join(root, 'packages', 'core', 'src'),
      '@pixel-agents/server': path.join(root, 'packages', 'server', 'src'),
    },
  },
  test: {
    globals: true,
    testTimeout: 10_000,
    include: ['__tests__/**/*.test.ts'],
  },
});
