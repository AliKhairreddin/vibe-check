import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  outputDir: './output/playwright/results',
  use: { baseURL: 'http://127.0.0.1:4175' },
  webServer: {
    command: 'pnpm --dir frontend exec vite --host 127.0.0.1 --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175',
  },
});
