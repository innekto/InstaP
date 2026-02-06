import 'dotenv/config';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import swaggerJSDoc from 'swagger-jsdoc';
import { v2 as cloudinary } from 'cloudinary';
import XLSX from 'xlsx';
import multer from 'multer';
import { scrapeAccountsJob } from './scraper/jobs/scrapeAccounts.job.js';
import logger from './logger.js';

const app = express();
process.on('unhandledRejection', (err) => {
  logger.error('UnhandledRejection:', err);
});
process.on('uncaughtException', (err) => {
  logger.error('UncaughtException:', err);
  process.exit(1);
});
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Insta Parser API',
      version: '1.0.0',
      description: 'API для запуска парсера Instagram',
    },
  },
  apis: [],
});

swaggerSpec.paths = {
  '/scrape': {
    post: {
      summary: 'Запуск парсера (хардкод)',
      description:
        'Запускает парсер с текущими хардкод-параметрами внутри сервиса.',
      requestBody: {
        required: false,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                cookies: {
                  type: 'string',
                  format: 'binary',
                  description: 'Файл cookies.json для текущего запроса.',
                },
                pageUrl: {
                  type: 'string',
                  format: 'uri',
                  example:
                    'https://www.instagram.com/advicefromtraders?igsh=d2toNXV1bWV1OG4=',
                  description:
                    'Ссылка на страницу Instagram, с которой собираем посты.',
                },
                cutoffDate: {
                  type: 'string',
                  format: 'date-time',
                  example: '2026-01-01T00:00:00Z',
                  description:
                    'Искать посты до этой даты (ISO 8601, UTC предпочтительно).',
                },
              },
            },
          },
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                pageUrl: {
                  type: 'string',
                  format: 'uri',
                  example:
                    'https://www.instagram.com/advicefromtraders?igsh=d2toNXV1bWV1OG4=',
                  description:
                    'Ссылка на страницу Instagram, с которой собираем посты.',
                },
                cutoffDate: {
                  type: 'string',
                  format: 'date-time',
                  example: '2026-01-01T00:00:00Z',
                  description:
                    'Искать посты до этой даты (ISO 8601, UTC предпочтительно).',
                },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Парсер успешно завершён',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  postsCount: { type: 'number' },
                  totalPosts: { type: 'number', nullable: true },
                  xlsxUrl: { type: 'string', format: 'uri' },
                  dailyStats: { type: 'object' },
                },
              },
            },
          },
        },
        500: {
          description: 'Ошибка выполнения парсера',
        },
      },
    },
  },
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.post('/scrape', upload.single('cookies'), async (req, res) => {
  try {
    if (!process.env.CLOUDINARY_URL) {
      return res.status(500).json({
        ok: false,
        error: 'CLOUDINARY_URL is not set on the server',
      });
    }
    const pageUrl =
      typeof req.body?.pageUrl === 'string' && req.body.pageUrl.trim()
        ? req.body.pageUrl.trim()
        : undefined;
    const cutoffDate =
      typeof req.body?.cutoffDate === 'string' && req.body.cutoffDate.trim()
        ? req.body.cutoffDate.trim()
        : undefined;
    if (cutoffDate) {
      const parsed = new Date(cutoffDate);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({
          ok: false,
          error:
            'Invalid cutoffDate. Use ISO 8601 date-time, e.g. 2026-01-01T00:00:00Z',
        });
      }
    }
    let username = 'advicefromtraders';
    let accountUrl = `https://www.instagram.com/${username}/`;
    if (pageUrl) {
      try {
        const url = new URL(pageUrl);
        if (!url.hostname.endsWith('instagram.com')) {
          return res.status(400).json({
            ok: false,
            error: 'Invalid pageUrl. Must be an instagram.com URL.',
          });
        }
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 1) {
          return res.status(400).json({
            ok: false,
            error:
              'Invalid pageUrl. Must be a profile URL like /username',
          });
        }
        username = parts[0];
        accountUrl = `https://www.instagram.com/${username}/`;
      } catch {
        return res.status(400).json({
          ok: false,
          error: 'Invalid pageUrl. Must be a valid URL.',
        });
      }
    }

    let cookiesFromUpload;
    if (req.file) {
      try {
        const raw = req.file.buffer.toString('utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          return res.status(400).json({
            ok: false,
            error: 'Invalid cookies file. Expected JSON array.',
          });
        }
        cookiesFromUpload = parsed;
      } catch (err) {
        return res.status(400).json({
          ok: false,
          error: `Invalid cookies file. ${err.message}`,
        });
      }
    }

    const { posts, dailyStats, totalPosts } = await scrapeAccountsJob(username, {
      cutoffDate,
      cookies: cookiesFromUpload,
    });

    const postsKeys =
      posts && posts.length && typeof posts[0] === 'object'
        ? Object.keys(posts[0])
        : [];
    const postsSheet = XLSX.utils.aoa_to_sheet([
      ['accountUrl', accountUrl, 'totalPosts', totalPosts ?? null],
      postsKeys,
    ]);
    if (postsKeys.length) {
      XLSX.utils.sheet_add_json(postsSheet, posts, {
        header: postsKeys,
        skipHeader: true,
        origin: 'A3',
      });
    }
    const statsRows = Object.entries(dailyStats || {}).map(([day, stats]) => ({
      day,
      photo: stats?.photo ?? 0,
      reels: stats?.reels ?? 0,
      carousel: stats?.carousel ?? 0,
    }));
    const statsHeader = ['day', 'photo', 'reels', 'carousel'];
    const statsSheet = XLSX.utils.aoa_to_sheet([
      ['accountUrl', accountUrl, 'totalPosts', totalPosts ?? null],
      statsHeader,
    ]);
    if (statsRows.length) {
      XLSX.utils.sheet_add_json(statsSheet, statsRows, {
        header: statsHeader,
        skipHeader: true,
        origin: 'A3',
      });
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, postsSheet, 'posts');
    XLSX.utils.book_append_sheet(workbook, statsSheet, 'dailyStats');

    const xlsxBuffer = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
    });

    const uploadRaw = (buffer, filename) =>
      new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'raw',
            folder: 'insta-parser',
            public_id: filename,
            overwrite: true,
          },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          },
        );
        stream.end(buffer);
      });

    const fileRes = await uploadRaw(xlsxBuffer, `insta-${username}`);

    res.json({
      ok: true,
      postsCount: posts.length,
      totalPosts,
      xlsxUrl: fileRes.secure_url,
      dailyStats,
    });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`API запущен на http://localhost:${PORT}`);
  logger.info('Swagger UI: http://localhost:' + PORT + '/docs');
});
