import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/cross/**/*.test.mjs'], testTimeout: 30000 } });
