import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    // Tests share module-level engine state; keep files isolated but sequential
    // inside a file (vitest default) — no network, no live APIs.
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['skills/**/*.js', 'utils/**/*.js', 'config/**/*.js', 'server/**/*.js'],
      exclude: ['skills/render_creative.js'],
      reporter: ['text'],
      thresholds: {
        // Feature 240: modest floor that ratchets up over time.
        lines: 10,
        functions: 10,
        branches: 5,
        statements: 10,
      },
      clean: true,
      reportOnFailure: true,
    },
    pool: 'forks',
    fileParallelism: false,
    teardownTimeout: 5000,
  },
});
