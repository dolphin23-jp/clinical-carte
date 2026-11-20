// アイコンの PNG を作る（public/ に書き出す。出力はコミットする。アイコンを変えたときだけ動かす）。
// 使い方：pnpm --filter @clinical-carte/web exec node scripts/make-icons.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium } from 'playwright-core';

const PUBLIC = resolve(import.meta.dirname, '../public');
const svg = readFileSync(resolve(PUBLIC, 'icon.svg'), 'utf8');
// iOS は自分で角を丸めるので、apple-touch-icon は全面を塗る
const square = svg.replace('rx="14"', 'rx="0"');

const outputs: { name: string; size: number; source: string }[] = [
  { name: 'icon-192.png', size: 192, source: svg },
  { name: 'icon-512.png', size: 512, source: svg },
  { name: 'apple-touch-icon.png', size: 180, source: square },
];

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const executablePath = process.env['CARTE_CHROMIUM_PATH'];
const browser = await chromium.launch({ ...(executablePath === undefined ? {} : { executablePath }), args: isRoot ? ['--no-sandbox'] : [] });
for (const { name, size, source } of outputs) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${source.replace('<svg ', '<svg width="100%" height="100%" ')}</body></html>`);
  writeFileSync(resolve(PUBLIC, name), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
  await page.close();
}
await browser.close();
process.stdout.write(`書き出した: ${outputs.map((o) => o.name).join(', ')}\n`);
