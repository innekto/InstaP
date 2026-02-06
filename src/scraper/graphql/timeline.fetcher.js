import puppeteer from 'puppeteer';
import logger from '../../logger.js';

function cookiesToSet(cookies) {
  return cookies.map(({ name, value, domain, path }) => ({
    name,
    value,
    domain,
    path,
  }));
}

const parseCount = (raw) => {
  if (!raw) return null;
  const m = String(raw).match(/([\d,.]+)\s*([KMB])?/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  const suf = (m[2] || '').toUpperCase();
  if (suf === 'K') n *= 1e3;
  if (suf === 'M') n *= 1e6;
  if (suf === 'B') n *= 1e9;
  return Math.round(n);
};

async function extractTotalFromPage(page) {
  try {
    const { candidates, metaDesc } = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('header section ul li'))
        .map((li) => li.innerText || li.textContent || '')
        .filter(Boolean);
      const meta =
        document
          .querySelector('meta[name="description"]')
          ?.getAttribute('content') ||
        document
          .querySelector('meta[property="og:description"]')
          ?.getAttribute('content') ||
        '';
      return { candidates: items, metaDesc: meta };
    });

    const texts = [...candidates, metaDesc].filter(Boolean);
    for (const text of texts) {
      const m = text.match(
        /([\d,.]+)\s*([KMB])?\s*(posts|post|пост|публикац)/i,
      );
      if (m) return parseCount(`${m[1]}${m[2] || ''}`);
    }
  } catch {}
  return null;
}

// Собираем ссылки постов на текущем экране
async function collectPostLinksOnce(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('main a[href*="/p/"]')).map(
      (a) => a.href,
    ),
  );
}

const countPosts = (page) =>
  page.evaluate(() => document.querySelectorAll('main a[href*="/p/"]').length);

const waitPostsStable = async (page) => {
  let last = 0;
  let stable = 0;
  for (let i = 0; i < 20; i++) {
    const count = await countPosts(page);
    if (count > last) {
      last = count;
      stable = 0;
    } else {
      stable += 1;
    }
    if (stable >= 3) break;
    await new Promise((r) => setTimeout(r, 500));
  }
};

const waitForAtLeast = async (page, targetCount) => {
  for (let i = 0; i < 30; i++) {
    const count = await countPosts(page);
    if (count >= targetCount) return count;
    await new Promise((r) => setTimeout(r, 500));
  }
  return countPosts(page);
};

// Вытаскиваем данные из карточки одного поста
async function fetchPostData(page, postLink, debugConsole = false) {
  const startedAt = Date.now();
  try {
    await page.goto(postLink, { waitUntil: 'networkidle2' });
  } catch (err) {
    logger.warn('Не удалось открыть пост:', postLink, err.message);
    return null;
  }

  try {
    await page.waitForSelector('article', { timeout: 20000 });
  } catch {}

  const data = await page.evaluate(() => {
    const timeEl =
      document.querySelector('article time') || document.querySelector('time');
    let timestamp = timeEl?.getAttribute('datetime') || null;

    let ldData = null;
    const ld = document.querySelector('script[type="application/ld+json"]');
    if (ld?.textContent) {
      try {
        ldData = JSON.parse(ld.textContent);
      } catch {}
    }

    if (!timestamp && ldData?.datePublished) timestamp = ldData.datePublished;
    if (!timestamp) return null;

    const type = document.querySelector('article video')
      ? 'reels'
      : document.querySelector('article svg[aria-label="Carousel"]')
        ? 'carousel'
        : 'photo';

    const parseCount = (raw) => {
      if (!raw) return null;
      const m = String(raw).match(/([\d,.]+)\s*([KMB])?/i);
      if (!m) return null;
      let n = parseFloat(m[1].replace(/,/g, ''));
      const suf = (m[2] || '').toUpperCase();
      if (suf === 'K') n *= 1e3;
      if (suf === 'M') n *= 1e6;
      if (suf === 'B') n *= 1e9;
      return Math.round(n);
    };

    let views = null;
    let likes = null;
    let comments = null;
    if (ldData?.interactionStatistic) {
      const stats = Array.isArray(ldData.interactionStatistic)
        ? ldData.interactionStatistic
        : [ldData.interactionStatistic];
      const watch = stats.find((s) =>
        String(s.interactionType || '').includes('WatchAction'),
      );
      if (watch?.userInteractionCount)
        views = Number(watch.userInteractionCount);
      const like = stats.find((s) =>
        String(s.interactionType || '').includes('LikeAction'),
      );
      if (like?.userInteractionCount) likes = Number(like.userInteractionCount);
    }

    if (views == null) {
      const viewsNode = document.querySelector('article section span');
      if (viewsNode) {
        const text = viewsNode.innerText.replace(/\D/g, '');
        if (text) views = parseInt(text, 10);
      }
    }

    if (likes == null) {
      const metaDesc =
        document
          .querySelector('meta[name="description"]')
          ?.getAttribute('content') ||
        document
          .querySelector('meta[property="og:description"]')
          ?.getAttribute('content') ||
        '';
      // example: "73K likes, 335 comments - ..."
      const likeMatch = metaDesc.match(/([\d,.]+)\s*([KMB])?\s*likes/i);
      if (likeMatch) {
        likes = parseCount(`${likeMatch[1]}${likeMatch[2] || ''}`);
      }
      const commentMatch = metaDesc.match(/([\d,.]+)\s*([KMB])?\s*comments/i);
      if (commentMatch) {
        comments = parseCount(`${commentMatch[1]}${commentMatch[2] || ''}`);
      }
      // example: "... 1,234 views - ..."
      if (views == null) {
        const viewMatch = metaDesc.match(/([\d,.]+)\s*([KMB])?\s*views/i);
        if (viewMatch) {
          views = parseCount(`${viewMatch[1]}${viewMatch[2] || ''}`);
        }
      }
    }

    return {
      timestamp,
      type,
      views,
      likes,
      comments,
    };
  });

  // Логирование DOM в консоль
  if (debugConsole) {
    logger.debug('--- DEBUG DOM для поста:', postLink, '---');
    logger.debug(
      'HTML <article> (усечённо):',
      data.articleHTML?.slice(0, 500),
      '...',
    );
    logger.debug('LD+JSON:', data.ldJson?.slice(0, 500), '...');
    logger.debug('--------------------------------------');
  }

  // Сохраняем на диск, если views нет
  // debug disabled

  const durationMs = Date.now() - startedAt;
  logger.info(`Время обработки поста: ${durationMs} ms | ${postLink}`);
  return data;
}

// Параллельная обработка с динамическим concurrency
async function fetchPostsParallel(
  browser,
  postLinks,
  cookies,
  sinceDate,
  debugConsole = false,
) {
  const posts = [];
  const total = postLinks.length;

  let concurrency = total;

  logger.info(`Общий прогресс: ${total} постов, concurrency = ${concurrency}`);

  for (let i = 0; i < total; i += concurrency) {
    const batch = postLinks.slice(i, i + concurrency);

    const pages = await Promise.all(batch.map(() => browser.newPage()));

    for (let page of pages) {
      await page.setCookie(...cookiesToSet(cookies));
      page.on('console', (msg) => {
        const text = msg.text();
        if (
          text.includes('selfxss') ||
          text.includes('PolarisStoriesV3TrayContainerQuery') ||
          text.includes('Invalid module param')
        )
          return;
        logger.debug('PAGE LOG:', text);
      });
    }

    const results = await Promise.all(
      pages.map((page, idx) => fetchPostData(page, batch[idx], debugConsole)),
    );

    results.forEach((data, idx) => {
      if (!data) {
        logger.info(`Пропуск поста (нет даты): ${batch[idx]}`);
        return;
      }
      if (sinceDate && new Date(data.timestamp) < sinceDate) {
        return;
      }

      posts.push({
        link: batch[idx],
        ...data,
      });

      logger.info(
        `Добавлен пост #${posts.length}/${total}: ${batch[idx]} | Тип: ${data.type}`,
      );
    });

    await Promise.all(pages.map((p) => p.close()));
    await new Promise((r) => setTimeout(r, 800));
  }

  return posts;
}

export async function fetchTimeline(
  username,
  cookies,
  sinceDate = null,
  debugConsole = false,
) {
  const headless =
    process.env.PUPPETEER_HEADLESS === 'false' ? false : 'new';
  const launchArgs = [];
  if (process.env.RENDER || process.env.NODE_ENV === 'production') {
    launchArgs.push(
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    );
  }
  const browser = await puppeteer.launch({ headless, args: launchArgs });
  const page = await browser.newPage();

  await page.setCookie(...cookiesToSet(cookies));

  let totalPosts = null;
  try {
    await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: 'networkidle2',
    });
    await page.waitForSelector('main', { timeout: 20000 });
    totalPosts = await extractTotalFromPage(page);
  } catch (err) {
    logger.warn('Ошибка при открытии страницы:', err.message);
  }

  const cutoffDate = new Date('2026-02-02T00:00:00Z');
  const batchSize = 10;
  const maxBatches = 20;
  const allPosts = [];
  const seenLinks = new Set();

  logger.info(`Собираем ссылки постов пользователя ${username}...`);

  let batchIndex = 0;
  let lastProcessedCount = 0;

  while (batchIndex < maxBatches) {
    await waitPostsStable(page);
    await waitForAtLeast(page, lastProcessedCount + batchSize);

    const links = await page.evaluate(() => {
      const anchors = Array.from(
        document.querySelectorAll('main a[href*="/p/"]'),
      );
      const filtered = anchors.filter((a) => {
        const article = a.closest('article');
        if (!article) return true;
        const text = article.innerText?.toLowerCase() || '';
        const pinnedIcon = article.querySelector(
          'svg[aria-label*="Pinned"], svg[aria-label*="Закреп"]',
        );
        return (
          !text.includes('pinned') && !text.includes('закреп') && !pinnedIcon
        );
      });

      const items = filtered.map((a) => {
        const r = a.getBoundingClientRect();
        return {
          href: a.href,
          top: Math.round(r.top),
          left: Math.round(r.left),
        };
      });

      // сортировка как в визуальной сетке: сверху вниз, слева направо
      items.sort((a, b) => a.top - b.top || a.left - b.left);

      // уникальные по href в порядке отображения
      const out = [];
      const seen = new Set();
      for (const it of items) {
        if (seen.has(it.href)) continue;
        seen.add(it.href);
        out.push(it.href);
      }
      return out;
    });
    const newLinks = links.filter((l) => !seenLinks.has(l));
    newLinks.forEach((l) => seenLinks.add(l));

    const batchLinks = newLinks.slice(0, batchSize);
    if (batchLinks.length === 0) {
      logger.info('Новых ссылок нет, завершаем.');
      break;
    }

    logger.info(
      `Партия #${batchIndex + 1}: новых ссылок ${batchLinks.length}, всего уникальных ${seenLinks.size}`,
    );

    const batchPosts = await fetchPostsParallel(
      browser,
      batchLinks,
      cookies,
      null,
      debugConsole,
    );

    const batchDates = batchPosts
      .map((p) => new Date(p.timestamp))
      .filter((d) => !Number.isNaN(d.getTime()));
    const minDate =
      batchDates.length > 0
        ? new Date(Math.min(...batchDates.map((d) => d.getTime())))
        : null;

    if (minDate) {
      logger.info(`Самая ранняя дата в партии: ${minDate.toISOString()}`);
    }

    logger.info(
      'Даты в партии:',
      batchPosts.map((p) => p.timestamp).filter(Boolean),
    );

    const filtered = batchPosts.filter(
      (p) => new Date(p.timestamp) >= cutoffDate,
    );
    allPosts.push(...filtered);

    if (minDate && minDate < cutoffDate) {
      logger.info('Достигли дату старше 2026-02-02. Останавливаемся.');
      break;
    }

    // Останавливаемся после первой партии (до первого скролла)
    break;
  }

  await page.close();

  logger.info(
    `Сбор завершен, всего постов после фильтрации: ${allPosts.length}`,
  );
  await browser.close();

  return { posts: allPosts, totalPosts };
}
