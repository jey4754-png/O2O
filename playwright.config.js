import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.O2O_E2E_PORT || 4187);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('O2O_E2E_PORT must be a valid TCP port');
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'mobile-webkit',
      use: {
        ...devices['iPhone 14'],
      },
    },
  ],
  webServer: {
    command: `VITE_RELEASE_PHASE=9 VITE_ENABLE_GROUP_LOCAL_FALLBACK=true VITE_O2O_LOCAL_ADMIN_PIN=2468 pnpm dev --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    // A focused run must not inherit a server owned by another test command:
    // that command can finish and shut it down during the new run.
    reuseExistingServer: !process.env.CI && process.env.O2O_E2E_REUSE_SERVER !== 'false',
    timeout: 120_000,
  },
});
