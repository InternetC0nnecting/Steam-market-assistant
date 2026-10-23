'use strict';
const path = require('node:path');

(async () => {
  const { packager } = await import('@electron/packager');
  const root = path.resolve(__dirname, '..');
  const result = await packager({
    dir: root,
    name: 'SteamMarketAssistant',
    appVersion: require('../package.json').version,
    appCopyright: '2026 Steam Market Assistant',
    platform: 'win32', arch: 'x64',
    out: process.env.STEAM_DESK_BUILD_OUT || path.join(root, 'dist'),
    tmpdir: path.join(process.env.STEAM_DESK_BUILD_OUT || path.join(root, 'dist'), '.packager-tmp'),
    electronZipDir: process.env.STEAM_DESK_ELECTRON_ZIP_DIR || undefined,
    asar: true, prune: true, overwrite: true,
    ignore: [/^\/test(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/dist(?:\/|$)/, /^\/README\.md$/, /^\/启动开发版\.cmd$/, /^\/\.gitignore$/],
    win32metadata: { CompanyName: 'Local Tools', FileDescription: 'Steam Market Assistant', ProductName: 'Steam Market Assistant' }
  });
  console.log(result.join('\n'));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
