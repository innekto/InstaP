import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import logger from '../../logger.js';

function cookiesToSet(cookies) {
  return cookies.map(({ name, value, domain, path }) => ({
    name,
    value,
    domain,
    path,
  }));
}

function parseEdge(edge) {
  const node = edge?.node || {};
  const takenAt =
    typeof node.taken_at_timestamp === 'number'
      ? node.taken_at_timestamp
      : typeof node.taken_at === 'number'
        ? node.taken_at
        : null;
  const ts = takenAt ? new Date(takenAt * 1000).toISOString() : null;

  const mediaType = node.media_type;
  const productType = node.product_type;
  const type =
    productType === 'clips' || productType === 'reels' || mediaType === 2
      ? 'reels'
      : mediaType === 8 || node.carousel_media_count > 1
        ? 'carousel'
        : 'photo';

  const likes =
    node.like_count ??
    node.edge_liked_by?.count ??
    node.edge_media_preview_like?.count ??
    null;
  const comments =
    node.comment_count ?? node.edge_media_to_comment?.count ?? null;
  const views =
    node.play_count ??
    node.view_count ??
    node.video_view_count ??
    node.video_play_count ??
    null;

  return {
    link: node.code
      ? `https://www.instagram.com/p/${node.code}/`
      : node.shortcode
        ? `https://www.instagram.com/p/${node.shortcode}/`
        : null,
    __pk: node.pk || node.id || null,
    timestamp: ts,
    type,
    likes,
    comments,
    views,
  };
}

function extractTimeline(json) {
  const media =
    json?.data?.user?.edge_owner_to_timeline_media ||
    json?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
  if (!media) return { edges: [], pageInfo: null };
  return {
    edges: media.edges || [],
    pageInfo: media.page_info || null,
  };
}

function extractTotalCount(json) {
  const media =
    json?.data?.user?.edge_owner_to_timeline_media ||
    json?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
  const count =
    typeof media?.count === 'number'
      ? media.count
      : typeof media?.total_count === 'number'
        ? media.total_count
        : null;
  return count;
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

export async function fetchTimelineGraphQL(
  username,
  cookies = [],
  cutoffDate = null,
  maxPages = 50,
) {
  const headless =
    process.env.PUPPETEER_HEADLESS === 'false' ? false : 'new';
  const launchArgs = [];
  if (process.env.RENDER || process.env.NODE_ENV === 'production') {
    launchArgs.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  const browser = await puppeteer.launch({ headless, args: launchArgs });
  const page = await browser.newPage();
  if (cookies.length) await page.setCookie(...cookiesToSet(cookies));

  const initial = await new Promise(async (resolve, reject) => {
    let lastTimelineJson = null;
    let lastTemplate = null;
    const timer = setTimeout(() => {
      if (lastTimelineJson) {
        resolve({
          mode: 'none',
          queryHash: null,
          docId: null,
          variables: null,
          json: lastTimelineJson,
          template: lastTemplate,
        });
        return;
      }
      reject(new Error('Не удалось поймать GraphQL запрос'));
    }, 30000);

    const handler = async (res) => {
      try {
        const url = res.url();
        if (!url.includes('/graphql/') && !url.includes('/api/graphql/'))
          return;
        logger.debug('[GQL] response:', url, 'status:', res.status());

        const json = await res.json().catch(() => null);
        if (!json) {
          logger.debug('[GQL] no json body');
          return;
        }
        if (json?.data) {
          logger.debug('[GQL] data keys:', Object.keys(json.data));
        } else {
          logger.debug('[GQL] no data field, keys:', Object.keys(json));
        }
        if (json?.errors) {
          logger.debug('[GQL] response errors:', JSON.stringify(json.errors));
        }
        const hasTimeline =
          !!json?.data?.user?.edge_owner_to_timeline_media ||
          !!json?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
        if (!hasTimeline) return;
        lastTimelineJson = json;

        const req = res.request();
        const postData = req.postData() || '';
        const method = req.method();
        const headers = req.headers();
        const reqUrl = req.url();

        let queryHash = null;
        let docId = null;
        let variablesRaw = null;

        if (url.includes('/graphql/query')) {
          try {
            const u = new URL(url);
            queryHash = u.searchParams.get('query_hash');
            variablesRaw = u.searchParams.get('variables');
          } catch {}

          // если GET params пустые — пробуем из POST body
          if (!queryHash || !variablesRaw) {
            const params = new URLSearchParams(postData);
            queryHash = queryHash || params.get('query_hash');
            variablesRaw = variablesRaw || params.get('variables');
            docId = docId || params.get('doc_id');
          }

          if (!queryHash && !variablesRaw && !docId) {
            logger.debug('[GQL] full url (trunc):', url.slice(0, 500));
          }
        } else if (url.includes('/api/graphql/')) {
          const params = new URLSearchParams(postData);
          docId = params.get('doc_id');
          variablesRaw = params.get('variables');
          queryHash = params.get('query_hash');
        }

        if (!variablesRaw) {
          logger.info(
            '[GQL] request postData (trunc):',
            postData.slice(0, 500),
          );
        }

        logger.debug('[GQL] mode:', docId ? 'doc_id' : 'query_hash');
        logger.debug('[GQL] queryHash:', queryHash);
        logger.debug('[GQL] docId:', docId);
        logger.debug('[GQL] variablesRaw:', variablesRaw?.slice(0, 500));

        if (!variablesRaw || (!queryHash && !docId)) {
          // сохраняем тело запроса для отладки
          try {
            const dir = path.resolve('debug');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
              path.join(dir, 'last_timeline_request_body.txt'),
              postData,
            );
          } catch {}
          return;
        }

        lastTemplate = {
          url: reqUrl,
          method,
          headers,
          postData,
        };

        clearTimeout(timer);
        page.off('response', handler);
        resolve({
          mode: docId ? 'doc_id' : 'query_hash',
          queryHash,
          docId,
          variables: JSON.parse(variablesRaw),
          json,
          template: lastTemplate,
        });
      } catch {}
    };

    page.on('response', handler);

    try {
      await page.goto(`https://www.instagram.com/${username}/`, {
        waitUntil: 'networkidle2',
      });

      // триггерим дополнительные запросы
      await page.waitForSelector('main', { timeout: 20000 });
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.2));
      await page.waitForTimeout?.(1500);
      await page.waitForTimeout?.(1500);
    } catch (err) {
      clearTimeout(timer);
      page.off('response', handler);
      reject(err);
    }
  });

  const posts = [];
  let { edges, pageInfo } = extractTimeline(initial.json);
  let totalPosts = extractTotalCount(initial.json);
  const queryHash = initial.queryHash;
  const docId = initial.docId;
  const baseVars = initial.variables;
  const template = initial.template;

  const cutoff = cutoffDate ? new Date(cutoffDate) : null;

  const pushEdges = (edgesArr) => {
    for (const e of edgesArr) {
      const post = parseEdge(e);
      if (!post.timestamp) continue;
      if (cutoff && new Date(post.timestamp) < cutoff) continue;
      posts.push(post);
    }
  };

  pushEdges(edges);

  if (!edges || edges.length === 0) {
    try {
      const dir = path.resolve('debug');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'first_timeline_response.json'),
        JSON.stringify(initial.json, null, 2),
      );
      logger.debug('Saved debug/first_timeline_response.json');
    } catch {}
  } else {
    try {
      const dir = path.resolve('debug');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'first_timeline_response.json'),
        JSON.stringify(initial.json, null, 2),
      );
      logger.debug('Saved debug/first_timeline_response.json');
    } catch {}
  }

  let pageCount = 0;
  while (
    pageInfo?.has_next_page &&
    pageInfo?.end_cursor &&
    pageCount < maxPages &&
    baseVars
  ) {
    const nextJson = await page.evaluate(
      async (mode, qHash, dId, vars, cursor, tpl) => {
        const nextVars = { ...vars, after: cursor };

        const pickHeaders = (h) => {
          const lower = {};
          for (const [k, v] of Object.entries(h || {})) {
            lower[String(k).toLowerCase()] = v;
          }
          const out = {
            'Content-Type': 'application/x-www-form-urlencoded',
          };
          if (lower['x-ig-app-id']) out['X-IG-App-ID'] = lower['x-ig-app-id'];
          if (lower['x-csrftoken']) out['X-CSRFToken'] = lower['x-csrftoken'];
          if (lower['x-requested-with'])
            out['X-Requested-With'] = lower['x-requested-with'];
          if (lower['x-fb-lsd']) out['X-FB-LSD'] = lower['x-fb-lsd'];
          return out;
        };

        if (tpl?.method === 'POST' && tpl?.url) {
          const params = new URLSearchParams(tpl.postData || '');
          if (mode === 'doc_id' && dId) params.set('doc_id', dId);
          if (qHash) params.set('query_hash', qHash);
          params.set('variables', JSON.stringify(nextVars));

          const res = await fetch(tpl.url, {
            method: 'POST',
            credentials: 'include',
            headers: pickHeaders(tpl.headers),
            body: params,
          });
          const text = await res.text();
          try {
            return JSON.parse(text);
          } catch {
            return { __errorText: text.slice(0, 2000) };
          }
        }

        if (mode === 'doc_id') {
          const body = new URLSearchParams();
          body.set('doc_id', dId);
          body.set('variables', JSON.stringify(nextVars));
          const res = await fetch('https://www.instagram.com/api/graphql/', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
          });
          const text = await res.text();
          try {
            return JSON.parse(text);
          } catch {
            return { __errorText: text.slice(0, 2000) };
          }
        }

        const url =
          'https://www.instagram.com/graphql/query/?query_hash=' +
          qHash +
          '&variables=' +
          encodeURIComponent(JSON.stringify(nextVars));
        const res = await fetch(url, { credentials: 'include' });
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          return { __errorText: text.slice(0, 2000) };
        }
      },
      initial.mode,
      queryHash,
      docId,
      baseVars,
      pageInfo.end_cursor,
      template,
    );

    if (nextJson?.__errorText) {
      try {
        const dir = path.resolve('debug');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'last_graphql_error.html'),
          nextJson.__errorText,
        );
      } catch {}
      logger.warn(
        'GraphQL non-JSON response, stopping pagination. See debug/last_graphql_error.html',
      );
      break;
    }

    const extracted = extractTimeline(nextJson);
    edges = extracted.edges;
    pageInfo = extracted.pageInfo;
    pushEdges(edges);

    // если самая старая дата в этой пачке уже < cutoff — можно остановиться
    if (cutoff && edges.length) {
      const minTs = Math.min(
        ...edges
          .map((e) => e?.node?.taken_at_timestamp)
          .filter((t) => typeof t === 'number'),
      );
      if (minTs && new Date(minTs * 1000) < cutoff) break;
    }

    pageCount += 1;
  }

  if (totalPosts == null) {
    totalPosts = await extractTotalFromPage(page);
  }

  await page.close();
  await browser.close();

  // добор views для reels отключён (endpoint блокируется)

  // убрать служебные поля
  posts.forEach((p) => {
    if ('__pk' in p) delete p.__pk;
  });

  return { posts, totalPosts };
}
