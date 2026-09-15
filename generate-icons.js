/**
 * Generates PNG favicon sizes from favicon.svg using Puppeteer.
 * Run: npm run gen-icons
 * The SVG is the source of truth; PNGs are generated artifacts.
 */
import puppeteer from 'puppeteer';
import fs from 'fs';

const svgContent = fs.readFileSync('./favicon.svg', 'utf8');
const encoded = encodeURIComponent(svgContent);
const dataUrl = `data:image/svg+xml;charset=utf-8,${encoded}`;

const sizes = [
  { name: 'favicon-16x16.png', w: 16, h: 16 },
  { name: 'favicon-32x32.png', w: 32, h: 32 },
  { name: 'favicon-48x48.png', w: 48, h: 48 },
  { name: 'favicon-180.png', w: 180, h: 180 },
  { name: 'favicon-192.png', w: 192, h: 192 },
  { name: 'favicon-512.png', w: 512, h: 512 },
];

const browser = await puppeteer.launch({ headless: 'new' });

for (const s of sizes) {
  const page = await browser.newPage();
  await page.setViewport({ width: s.w, height: s.h, deviceScaleFactor: 1 });
  await page.setContent(
    `<html><body style="margin:0;padding:0;background:#07090e"><img src="${dataUrl}" width="${s.w}" height="${s.h}" style="display:block" /></body></html>`,
    { waitUntil: 'networkidle0' }
  );
  await page.screenshot({ path: `./${s.name}`, width: s.w, height: s.h });
  console.log(`[icon] Generated ${s.name} (${s.w}x${s.h})`);
  await page.close();
}

await browser.close();
console.log('[icon] All favicon PNGs generated.');
