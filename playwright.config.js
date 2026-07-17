const { defineConfig } = require('@playwright/test');

const mobileUserAgent = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)',
  'AppleWebKit/605.1.15 (KHTML, like Gecko)',
  'Version/19.0 Mobile/15E148 Safari/604.1'
].join(' ');

const commonUse = {
  baseURL: 'http://127.0.0.1:4173',
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  colorScheme: 'light',
  reducedMotion: 'reduce',
  serviceWorkers: 'block',
  trace: 'retain-on-failure',
  screenshot: 'only-on-failure'
};

function desktopProject(name, width, height) {
  return {
    name,
    testMatch: /ejs-visual\.spec\.js/,
    use: {
      ...commonUse,
      browserName: 'chromium',
      launchOptions: {
        args: [
          '--disable-font-subpixel-positioning',
          '--disable-gpu',
          '--disable-lcd-text'
        ]
      },
      viewport: { width, height },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false
    }
  };
}

function mobileProject(name, width, height) {
  return {
    name,
    testMatch: /ejs-visual\.spec\.js/,
    use: {
      ...commonUse,
      browserName: 'webkit',
      viewport: { width, height },
      screen: { width, height },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: mobileUserAgent
    }
  };
}

module.exports = defineConfig({
  testDir: './test/visual',
  outputDir: './test-results/ejs-visual',
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFilePath}/{projectName}/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  updateSnapshots: 'none',
  timeout: 45_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'device',
      threshold: 0.2,
      maxDiffPixelRatio: 0.01
    }
  },
  reporter: [
    ['line'],
    ['html', { outputFolder: 'test-results/ejs-visual-report', open: 'never' }]
  ],
  webServer: {
    command: 'node test/helpers/ejs-visual-harness.js',
    url: 'http://127.0.0.1:4173/__visual/ready',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      BROWSER_HARNESS_PORT: '4173',
      TZ: 'Asia/Shanghai'
    }
  },
  projects: [
    {
      name: 'html-snapshots',
      testMatch: /ejs-html\.spec\.js/,
      use: {
        ...commonUse,
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1
      }
    },
    desktopProject('desktop-1080p', 1920, 1080),
    desktopProject('desktop-2k', 2560, 1440),
    desktopProject('desktop-4k', 3840, 2160),
    mobileProject('iphone-17', 402, 874),
    mobileProject('iphone-air', 420, 912),
    mobileProject('iphone-17-pro-max', 440, 956)
  ]
});
