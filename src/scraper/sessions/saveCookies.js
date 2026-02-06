import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import logger from '../../logger.js';

const OUT_PATH = path.resolve('cookies.json');

async function saveCookies() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  logger.info('Открылся браузер. Залогинься в Instagram.');
  logger.info('После логина вернись сюда и нажми Enter в консоли.');

  await page.goto('https://www.instagram.com/', {
    waitUntil: 'networkidle2',
  });

  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => resolve());
  });

  const cookies = await page.cookies();
  fs.writeFileSync(OUT_PATH, JSON.stringify(cookies, null, 2));
  logger.info(`Cookies сохранены в ${OUT_PATH}`);

  await browser.close();
  process.exit(0);
}

saveCookies().catch((err) => {
  logger.error(err);
  process.exit(1);
});
