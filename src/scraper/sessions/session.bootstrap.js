import puppeteer from 'puppeteer';
import fs from 'fs';

export async function bootstrapSession() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  await page.goto('https://www.instagram.com/', {
    waitUntil: 'networkidle2',
  });

  console.log('🔐 Залогинься вручную и нажми Enter');
  await new Promise((resolve) => process.stdin.once('data', resolve));

  const cookies = await page.cookies();
  await fs.promises.writeFile('cookies.json', JSON.stringify(cookies));

  await browser.close();

  return {
    cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    appId: '936619743392459',
  };
}
