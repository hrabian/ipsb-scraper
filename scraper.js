const fs = require('fs/promises');
const cheerio = require('cheerio');

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(baseUrl, maybeRelativeUrl) {
  return new URL(maybeRelativeUrl, baseUrl).toString();
}

function extractTotalPages($) {
  const numericLabels = $('.pages a, .pages span')
    .map((_, el) => normalizeText($(el).text()))
    .get()
    .map((label) => Number.parseInt(label, 10))
    .filter((n) => Number.isFinite(n));

  return numericLabels.length ? Math.max(...numericLabels) : 1;
}

function extractCurrentPage($) {
  const currentPage = $('.pages span')
    .map((_, el) => Number.parseInt(normalizeText($(el).text()), 10))
    .get()
    .filter((n) => Number.isFinite(n));

  return currentPage.length ? Math.max(...currentPage) : 1;
}

function extractBiographyItems($, baseUrl) {
  return $('.personItem')
    .map((_, item) => {
      const nameLink = $(item).find('.name a').first();
      const link = nameLink.attr('href') || '';

      const activities = $(item)
        .find('.activity a')
        .map((__, a) => normalizeText($(a).text()))
        .get()
        .filter(Boolean)
        .join(' | ');

      return {
        url: link ? absoluteUrl(baseUrl, link) : '',
        name: normalizeText(nameLink.text()),
        dates: normalizeText($(item).find('.dates').first().text()),
        activity: activities
      };
    })
    .get();
}

function extractInitialUrls($, baseUrl) {
  const urls = $('.initials a, .letters a, .alphabet a, a[href*="/Search/Type,Biography/Initial,"]')
    .map((_, a) => $(a).attr('href') || '')
    .get()
    .filter(Boolean)
    .map((href) => absoluteUrl(baseUrl, href));

  return [...new Set(urls)];
}

function buildInitialUrls(baseUrl, initials) {
  if (!initials || initials.length === 0) {
    return [baseUrl];
  }

  return initials.map((initial) => {
    const encoded = encodeURIComponent(initial);
    if (/Initial,[^/]+/i.test(baseUrl)) {
      return baseUrl.replace(/Initial,[^/]+/i, `Initial,${encoded}`);
    }
    return absoluteUrl(baseUrl, `/Search/Type,Biography/Initial,${encoded}/`);
  });
}

function extractBiographyDetails($, biographyUrl) {
  const givenName = normalizeText($('[itemprop="givenName"]').first().text());
  const familyName = normalizeText($('[itemprop="familyName"]').first().text());
  const combinedName = normalizeText([givenName, familyName].filter(Boolean).join(' '));
  const ogTitle = normalizeText($('meta[property="og:title"]').attr('content'));

  const headerActivities = $('.personalDataControl .black-bg a[href*="/Search/Type,Biography/Tag"]')
    .map((_, a) => normalizeText($(a).text()))
    .get()
    .filter(Boolean);

  const uniqueActivities = [...new Set(headerActivities)];
  const biographyText = normalizeText($('[itemprop="description"]').first().text());

  return {
    biography_url: biographyUrl,
    biography_name: combinedName || ogTitle,
    biography_birth_date: normalizeText($('.birthDateText').first().text()),
    biography_death_date: normalizeText($('.deathDateText').first().text()),
    biography_activities: uniqueActivities.join(' | '),
    biography_text: biographyText
  };
}

function toCsv(data) {
  const preferred = [
    'url',
    'name',
    'dates',
    'activity',
    'biography_url',
    'biography_name',
    'biography_birth_date',
    'biography_death_date',
    'biography_activities',
    'biography_text',
    'biography_error'
  ];

  const discovered = [...new Set(data.flatMap((row) => Object.keys(row)))];
  const headers = [
    ...preferred.filter((key) => discovered.includes(key)),
    ...discovered.filter((key) => !preferred.includes(key))
  ];

  const escapeCsv = (value) => {
    const text = String(value ?? '');
    if (/[",\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const rows = data.map((row) => headers.map((h) => escapeCsv(row[h])).join(','));
  return [headers.join(','), ...rows].join('\n');
}

function getPostbackTargetFromId(id) {
  return id.replaceAll('_', '$');
}

function parseAspNetState($) {
  const form = $('form').first();
  const action = form.attr('action') || '/';

  const appPageStateField = $('input[type="hidden"]')
    .filter((_, el) => {
      const name = $(el).attr('name') || '';
      return name.endsWith('PRADO_PAGESTATE') && name !== 'PRADO_PAGESTATE';
    })
    .first();

  return {
    action,
    pradoPageState: $('#PRADO_PAGESTATE').val() || appPageStateField.val() || '',
    appPageStateName: appPageStateField.attr('name') || '',
    appPageState: appPageStateField.val() || '',
    extraHiddenFields: $('input[type="hidden"]')
      .map((_, el) => ({
        name: $(el).attr('name') || '',
        value: $(el).val() || ''
      }))
      .get()
      .filter(
        (f) =>
          f.name &&
          !f.name.endsWith('PRADO_PAGESTATE') &&
          !['PRADO_POSTBACK_TARGET', 'PRADO_POSTBACK_PARAMETER'].includes(f.name)
      )
  };
}

function getPaginationTargets($) {
  const links = $('.pages a')
    .map((_, el) => ({
      id: $(el).attr('id') || '',
      label: normalizeText($(el).text())
    }))
    .get()
    .filter((x) => x.id);

  const numeric = new Map();
  let nextId = '';

  for (const link of links) {
    if (/^\d+$/.test(link.label)) {
      numeric.set(Number.parseInt(link.label, 10), link.id);
    } else if (link.label === '>') {
      nextId = link.id;
    }
  }

  return { numeric, nextId };
}

function parseSetCookie(setCookieValue) {
  const [firstPart] = setCookieValue.split(';');
  const eq = firstPart.indexOf('=');
  if (eq <= 0) {
    return null;
  }
  return {
    name: firstPart.slice(0, eq).trim(),
    value: firstPart.slice(eq + 1).trim()
  };
}

function updateCookies(current, setCookieHeaders = []) {
  const jar = new Map();

  for (const cookie of current) {
    const parsed = parseSetCookie(cookie);
    if (parsed) {
      jar.set(parsed.name, parsed.value);
    }
  }

  for (const cookie of setCookieHeaders) {
    const parsed = parseSetCookie(cookie);
    if (parsed) {
      jar.set(parsed.name, parsed.value);
    }
  }

  return [...jar.entries()].map(([name, value]) => `${name}=${value}`);
}

async function fetchHtml(url, { timeoutMs, method = 'GET', formBody, cookies = [], retries = 2 }) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          ...DEFAULT_HEADERS,
          ...(cookies.length ? { Cookie: cookies.join('; ') } : {}),
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
        },
        body: formBody
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      const html = await response.text();
      const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];

      return {
        html,
        cookies: updateCookies(cookies, setCookie)
      };
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(Math.min(250 * 2 ** attempt, 1500));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

function buildPostbackBody(state, targetId) {
  const body = new URLSearchParams();

  for (const field of state.extraHiddenFields) {
    body.set(field.name, field.value);
  }

  const pageStateValue = state.pradoPageState || state.appPageState;
  body.set('PRADO_PAGESTATE', pageStateValue);
  if (state.appPageStateName) {
    body.set(state.appPageStateName, state.appPageState || pageStateValue);
  }

  body.set('PRADO_POSTBACK_TARGET', getPostbackTargetFromId(targetId));
  body.set('PRADO_POSTBACK_PARAMETER', '');

  return body.toString();
}

async function scrapeViaPostback({ baseUrl, delayMs, maxPages, timeoutMs, firstHtml, firstCookies }) {
  let html = firstHtml;
  let cookies = firstCookies;
  let $ = cheerio.load(html);
  const pageLimit = maxPages && maxPages > 0 ? maxPages : Infinity;
  let totalPages = extractTotalPages($);
  let scrapedPages = 1;
  const records = [];

  records.push(...extractBiographyItems($, baseUrl));
  console.log(`Scraped page 1/${Number.isFinite(pageLimit) ? pageLimit : '?'} (${records.length} cumulative records)`);

  for (let targetPage = 2; targetPage <= pageLimit; targetPage += 1) {
    let reachedTargetPage = false;

    while (!reachedTargetPage) {
      const { numeric, nextId } = getPaginationTargets($);
      totalPages = Math.max(totalPages, ...numeric.keys(), scrapedPages);

      const pageLinkId = numeric.get(targetPage) || nextId;
      if (!pageLinkId) {
        return { totalPages: Math.max(totalPages, scrapedPages), scrapedPages, records, cookies };
      }

      const state = parseAspNetState($);
      const postUrl = absoluteUrl(baseUrl, state.action);
      const response = await fetchHtml(postUrl, {
        timeoutMs,
        method: 'POST',
        formBody: buildPostbackBody(state, pageLinkId),
        cookies
      });

      html = response.html;
      cookies = response.cookies;
      $ = cheerio.load(html);
      totalPages = Math.max(totalPages, extractTotalPages($), scrapedPages);
      reachedTargetPage = extractCurrentPage($) === targetPage || Boolean(numeric.get(targetPage));
    }

    scrapedPages = targetPage;

    const pageItems = extractBiographyItems($, baseUrl);
    records.push(...pageItems);
    console.log(`Scraped page ${targetPage}/${Number.isFinite(pageLimit) ? pageLimit : '?'} (${pageItems.length} records)`);

    if (targetPage < pageLimit && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return { totalPages, scrapedPages, records, cookies };
}

async function mapWithConcurrency(items, worker, concurrency) {
  const safeConcurrency = Math.max(1, Number.parseInt(concurrency, 10) || 1);
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: safeConcurrency }, () => runWorker()));
  return results;
}

async function enrichWithBiographyPages({ rows, timeoutMs, delayMs, cookies, detailConcurrency }) {
  const uniqueRows = [...new Map(rows.filter((row) => row.url).map((row) => [row.url, row])).values()];

  const detailsByUrl = new Map();

  await mapWithConcurrency(
    uniqueRows,
    async (row, index) => {
      if (detailsByUrl.has(row.url)) {
        return;
      }

      try {
        const response = await fetchHtml(row.url, {
          timeoutMs,
          cookies,
          retries: 1
        });
        const $ = cheerio.load(response.html);
        detailsByUrl.set(row.url, extractBiographyDetails($, row.url));
      } catch (error) {
        detailsByUrl.set(row.url, { biography_url: row.url, biography_error: error.message });
      }

      if (delayMs > 0) {
        await sleep(delayMs);
      }

      console.log(`Scraped biography ${index + 1}/${uniqueRows.length}`);
    },
    detailConcurrency
  );

  return rows.map((row) => (row.url ? { ...row, ...detailsByUrl.get(row.url) } : row));
}

async function scrapeBiographies({
  baseUrl,
  delayMs,
  maxPages,
  timeoutMs,
  fetchDetails = true,
  detailsDelayMs = 300,
  detailConcurrency = 3,
  initials,
  discoverInitials = false
}) {
  const first = await fetchHtml(baseUrl, { timeoutMs });
  const firstPage = cheerio.load(first.html);
  const initialUrls = discoverInitials
    ? extractInitialUrls(firstPage, baseUrl)
    : buildInitialUrls(baseUrl, initials);
  const urlsToScrape = initialUrls.length ? initialUrls : [baseUrl];

  const allRecords = [];
  let totalPages = 0;
  let scrapedPages = 0;
  let latestCookies = first.cookies;

  for (const [index, initialUrl] of urlsToScrape.entries()) {
    const initialFirst = index === 0 && initialUrl === baseUrl
      ? first
      : await fetchHtml(initialUrl, { timeoutMs, cookies: latestCookies });

    const listing = await scrapeViaPostback({
      baseUrl: initialUrl,
      delayMs,
      maxPages,
      timeoutMs,
      firstHtml: initialFirst.html,
      firstCookies: initialFirst.cookies
    });

    latestCookies = listing.cookies;
    totalPages += listing.totalPages;
    scrapedPages += listing.scrapedPages;
    allRecords.push(...listing.records);

    console.log(`Completed initial ${index + 1}/${urlsToScrape.length}: ${initialUrl}`);
    if (index < urlsToScrape.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  const records = fetchDetails
    ? await enrichWithBiographyPages({
        rows: allRecords,
        timeoutMs,
        delayMs: detailsDelayMs,
        cookies: latestCookies,
        detailConcurrency
      })
    : allRecords;

  return {
    totalPages,
    scrapedPages,
    records
  };
}

async function main() {
  const options = {
    baseUrl: process.env.BASE_URL || 'https://www.ipsb.nina.gov.pl/Search/Type,Biography/Initial,A/',
    outputPath: process.env.OUTPUT || 'biography_data.csv',
    delayMs: Number.parseInt(process.env.DELAY_MS || '1200', 10),
    maxPages: process.env.MAX_PAGES ? Number.parseInt(process.env.MAX_PAGES, 10) : undefined,
    timeoutMs: Number.parseInt(process.env.TIMEOUT_MS || '30000', 10),
    fetchDetails: process.env.FETCH_DETAILS === 'false' ? false : true,
    detailsDelayMs: Number.parseInt(process.env.DETAILS_DELAY_MS || '300', 10),
    detailConcurrency: Number.parseInt(process.env.DETAIL_CONCURRENCY || '3', 10),
    initials: process.env.INITIALS === 'discover'
      ? undefined
      : (process.env.INITIALS || 'A,Ą,B,C,Ć,D,E,F,G,H,I,J,K,L,Ł,M,N,O,Ó,P,R,S,Ś,T,U,W,Y,Z,Ź,Ż')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
    discoverInitials: process.env.INITIALS === 'discover'
  };

  try {
    const { totalPages, scrapedPages, records } = await scrapeBiographies(options);
    await fs.writeFile(options.outputPath, toCsv(records), 'utf8');

    console.log(`Total pages available: ${totalPages}`);
    console.log(`Pages scraped: ${scrapedPages}`);
    console.log(`Records saved: ${records.length}`);
    console.log(`Output file: ${options.outputPath}`);
  } catch (error) {
    console.error('Scraping failed:', error.message);
    if (process.env.DEBUG === '1' && error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  extractTotalPages,
  extractCurrentPage,
  extractBiographyItems,
  extractBiographyDetails,
  extractInitialUrls,
  buildInitialUrls,
  getPostbackTargetFromId,
  parseAspNetState,
  getPaginationTargets,
  scrapeBiographies,
  toCsv,
  updateCookies
};
