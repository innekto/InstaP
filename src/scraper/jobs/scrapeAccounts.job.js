import fs from 'fs';
import path from 'path';
import { fetchTimeline } from '../graphql/timeline.fetcher.js';
import { fetchTimelineGraphQL } from '../graphql/timeline.fetcher.graphql.js';
import logger from '../../logger.js';

export async function scrapeAccountsJob(
  username,
  {
    useGraphQL = true,
    cutoffDate = '2026-01-01T00:00:00Z',
    cookies: cookiesOverride,
  } = {},
) {
  logger.info(`🚀 Сбор постов для ${username}...`);

  const cookies =
    Array.isArray(cookiesOverride) && cookiesOverride.length
      ? cookiesOverride
      : readCookiesFromFile();

  const result = useGraphQL
    ? await fetchTimelineGraphQL(username, cookies, cutoffDate)
    : await fetchTimeline(username, cookies, cutoffDate);
  const posts = Array.isArray(result) ? result : result.posts || [];
  const totalPosts =
    !Array.isArray(result) && typeof result.totalPosts === 'number'
      ? result.totalPosts
      : null;

  logger.info(`Собрано постов: ${posts.length}`);

  // сохраняем raw посты
  fs.writeFileSync(path.resolve('posts.json'), JSON.stringify(posts, null, 2));
  logger.info('✅ Все посты сохранены: posts.json');

  // считаем статистику по дням
  const dailyStats = {};
  posts.forEach((p) => {
    const day = new Date(p.timestamp).toISOString().split('T')[0]; // YYYY-MM-DD
    if (!dailyStats[day]) dailyStats[day] = { photo: 0, reels: 0, carousel: 0 };
    if (p.type in dailyStats[day]) dailyStats[day][p.type]++;
  });

  fs.writeFileSync(
    path.resolve('dailyStats.json'),
    JSON.stringify(dailyStats, null, 2),
  );
  logger.info('✅ Статистика по дням сохранена: dailyStats.json');

  return { posts, dailyStats, totalPosts };
}

function readCookiesFromFile() {
  const cookiesPath = path.resolve('cookies.json');
  try {
    const raw = fs.readFileSync(cookiesPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Не удалось прочитать cookies: ${cookiesPath}. ${err.message}`,
    );
  }
}
