const fs = require('fs/promises');
const nodeFs = require('fs');
const readline = require('readline');
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

const CSV_COLUMNS = [
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

function getRecordKey(row) {
  return normalizeText(row.url || row.biography_url || row.name).toLowerCase();
}

function dedupeRecords(records) {
  const byKey = new Map();

  for (const record of records) {
    const key = getRecordKey(record);
    if (!key) {
      continue;
    }

    byKey.set(key, { ...(byKey.get(key) || {}), ...record });
  }

  return [...byKey.values()];
}

function parseCsvRows(csv) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    const next = csv[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function parseCsv(csv) {
  const rows = parseCsvRows(csv);
  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0];
  return rows
    .slice(1)
    .filter((values) => values.some(Boolean))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

async function loadExistingRecords(outputPath) {
  try {
    const csv = await fs.readFile(outputPath, 'utf8');
    return dedupeRecords(parseCsv(csv));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function escapeCsv(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function getCsvHeadersForData(data, baseHeaders = CSV_COLUMNS) {
  const preferred = [
    ...CSV_COLUMNS
  ];

  const discovered = [...new Set(data.flatMap((row) => Object.keys(row)))];
  const base = [
    ...preferred.filter((key) => baseHeaders.includes(key)),
    ...baseHeaders.filter((key) => !preferred.includes(key))
  ];

  return data.length
    ? [
        ...base.filter((key) => discovered.includes(key)),
        ...discovered.filter((key) => !base.includes(key))
      ]
    : base;
}

function recordsToCsvLines(data, headers) {
  const rows = data.map((row) => headers.map((h) => escapeCsv(row[h])).join(','));
  return rows.join('\n');
}

function toCsv(data) {
  const headers = getCsvHeadersForData(data);
  const rows = recordsToCsvLines(data, headers);
  return rows ? `${headers.join(',')}\n${rows}` : headers.join(',');
}

async function saveRecords(outputPath, records) {
  await fs.writeFile(outputPath, toCsv(dedupeRecords(records)), 'utf8');
}

async function ensureCsvFile(outputPath) {
  try {
    const stat = await fs.stat(outputPath);
    if (stat.size > 0) {
      return;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.writeFile(outputPath, `${CSV_COLUMNS.join(',')}\n`, 'utf8');
}

async function readCsvHeaders(outputPath) {
  try {
    const handle = await fs.open(outputPath, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (!bytesRead) {
        return [];
      }
      const firstLine = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/, 1)[0];
      return parseCsvRows(`${firstLine}\n`)[0] || [];
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function appendRecords(outputPath, records) {
  const rows = records.filter((record) => getRecordKey(record));
  if (!rows.length) {
    return;
  }

  await ensureCsvFile(outputPath);
  const headers = await readCsvHeaders(outputPath);
  await fs.appendFile(outputPath, `${recordsToCsvLines(rows, headers.length ? headers : CSV_COLUMNS)}\n`, 'utf8');
}

async function forEachCsvRecord(outputPath, onRecord, { end } = {}) {
  let headers;
  const streamOptions = {
    encoding: 'utf8',
    ...(typeof end === 'number' && end >= 0 ? { end } : {})
  };
  const stream = nodeFs.createReadStream(outputPath, streamOptions);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!headers) {
      headers = parseCsvRows(`${line}\n`)[0] || [];
      continue;
    }
    if (!line) {
      continue;
    }

    const values = parseCsvRows(`${line}\n`)[0] || [];
    if (!values.some(Boolean)) {
      continue;
    }

    await onRecord(Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
  }
}

async function loadCsvProgress(outputPath) {
  const progress = {
    knownKeys: new Set(),
    enrichedUrls: new Set(),
    rowCount: 0
  };

  try {
    await forEachCsvRecord(outputPath, async (row) => {
      const key = getRecordKey(row);
      if (key) {
        progress.knownKeys.add(key);
      }
      if (row.url && hasBiographyDetails(row)) {
        progress.enrichedUrls.add(row.url);
      }
      progress.rowCount += 1;
    });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  return progress;
}

async function compactCsv(outputPath) {
  await ensureCsvFile(outputPath);
  const headers = await readCsvHeaders(outputPath);
  const outputHeaders = headers.length ? headers : CSV_COLUMNS;
  const rowsTempPath = `${outputPath}.compact.rows.tmp`;
  const outputTempPath = `${outputPath}.compact.tmp`;
  const latestByKey = new Map();
  let rowsHandle;
  let readHandle;
  let writeHandle;
  let offset = 0;

  try {
    rowsHandle = await fs.open(rowsTempPath, 'w');

    await forEachCsvRecord(outputPath, async (row) => {
      const key = getRecordKey(row);
      if (!key) {
        return;
      }

      const line = `${outputHeaders.map((header) => escapeCsv(row[header])).join(',')}\n`;
      const buffer = Buffer.from(line, 'utf8');
      await rowsHandle.write(buffer, 0, buffer.length, offset);
      latestByKey.set(key, { offset, length: buffer.length });
      offset += buffer.length;
    });

    await rowsHandle.close();
    rowsHandle = undefined;

    readHandle = await fs.open(rowsTempPath, 'r');
    writeHandle = await fs.open(outputTempPath, 'w');
    await writeHandle.write(`${outputHeaders.join(',')}\n`, null, 'utf8');

    for (const location of latestByKey.values()) {
      const buffer = Buffer.alloc(location.length);
      await readHandle.read(buffer, 0, location.length, location.offset);
      await writeHandle.write(buffer);
    }

    await readHandle.close();
    readHandle = undefined;
    await writeHandle.close();
    writeHandle = undefined;

    await fs.rename(outputTempPath, outputPath);
    return { records: latestByKey.size };
  } finally {
    if (rowsHandle) {
      await rowsHandle.close().catch(() => {});
    }
    if (readHandle) {
      await readHandle.close().catch(() => {});
    }
    if (writeHandle) {
      await writeHandle.close().catch(() => {});
    }
    await fs.rm(rowsTempPath, { force: true }).catch(() => {});
    await fs.rm(outputTempPath, { force: true }).catch(() => {});
  }
}

function getDefaultStatePath(outputPath) {
  return `${outputPath}.state.json`;
}

async function loadScrapeState(statePath) {
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    return {
      initials: {},
      ...state,
      initials: state.initials || {}
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { initials: {} };
    }
    throw error;
  }
}

async function saveScrapeState(statePath, state) {
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
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

async function scrapeViaPostback({
  baseUrl,
  delayMs,
  maxPages,
  timeoutMs,
  firstHtml,
  firstCookies,
  startPage = 1,
  accumulateRecords = true,
  onPageRecords,
  onRecords,
  onPageState
}) {
  let html = firstHtml;
  let cookies = firstCookies;
  let $ = cheerio.load(html);
  const pageLimit = maxPages && maxPages > 0 ? maxPages : Infinity;
  let totalPages = extractTotalPages($);
  let currentPage = Math.max(1, Number.parseInt(startPage, 10) || 1);
  let scrapedPages = startPage > 1 ? 0 : 1;
  const records = [];

  if (currentPage === 1) {
    const pageItems = extractBiographyItems($, baseUrl);
    if (accumulateRecords) {
      records.push(...pageItems);
    }
    if (onPageRecords) {
      await onPageRecords(pageItems);
    }
    const recordLabel = accumulateRecords ? `${records.length} cumulative records` : `${pageItems.length} records`;
    console.log(`Scraped page 1/${Number.isFinite(pageLimit) ? pageLimit : '?'} (${recordLabel})`);
    if (onRecords) {
      await onRecords(records);
    }
    if (onPageState) {
      await onPageState({ page: currentPage, totalPages, html, cookies });
    }
  } else {
    console.log(`Resuming ${baseUrl} from saved page ${currentPage}`);
  }

  for (let targetPage = currentPage + 1; targetPage <= pageLimit; targetPage += 1) {
    let reachedTargetPage = false;

    while (!reachedTargetPage) {
      const { numeric, nextId } = getPaginationTargets($);
      totalPages = Math.max(totalPages, ...numeric.keys(), currentPage);

      const pageLinkId = numeric.get(targetPage) || nextId;
      if (!pageLinkId) {
        return { totalPages: Math.max(totalPages, currentPage), scrapedPages, records, cookies, html, currentPage };
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
      totalPages = Math.max(totalPages, extractTotalPages($), currentPage);
      reachedTargetPage = extractCurrentPage($) === targetPage || Boolean(numeric.get(targetPage));
    }

    currentPage = targetPage;
    scrapedPages += 1;

    const pageItems = extractBiographyItems($, baseUrl);
    if (accumulateRecords) {
      records.push(...pageItems);
    }
    if (onPageRecords) {
      await onPageRecords(pageItems);
    }
    console.log(`Scraped page ${targetPage}/${Number.isFinite(pageLimit) ? pageLimit : '?'} (${pageItems.length} records)`);
    if (onRecords) {
      await onRecords(records);
    }
    if (onPageState) {
      await onPageState({ page: currentPage, totalPages, html, cookies });
    }

    if (targetPage < pageLimit && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return { totalPages, scrapedPages, records, cookies, html, currentPage };
}

async function mapWithConcurrency(items, worker, concurrency) {
  const safeConcurrency = Math.max(1, Number.parseInt(concurrency, 10) || 1);
  const workerCount = Math.min(safeConcurrency, items.length);
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

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function hasBiographyDetails(row) {
  return Boolean(row.biography_text || row.biography_error);
}

async function enrichWithBiographyPages({
  rows,
  timeoutMs,
  delayMs,
  cookies,
  detailConcurrency,
  existingRecords = [],
  onProgress
}) {
  const detailsByUrl = new Map();
  for (const record of existingRecords) {
    if (record.url && hasBiographyDetails(record)) {
      detailsByUrl.set(record.url, record);
    }
  }

  const seenRows = new Set();
  const uniqueRows = [];
  for (const row of rows) {
    if (!row.url || seenRows.has(row.url) || detailsByUrl.has(row.url)) {
      continue;
    }
    seenRows.add(row.url);
    uniqueRows.push(row);
  }

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

      if (onProgress) {
        await onProgress(rows.map((currentRow) => (
          currentRow.url ? { ...currentRow, ...detailsByUrl.get(currentRow.url) } : currentRow
        )));
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

async function enrichCsvWithBiographyPages({
  outputPath,
  timeoutMs,
  delayMs,
  cookies,
  detailConcurrency,
  enrichedUrls = new Set()
}) {
  await ensureCsvFile(outputPath);
  const stat = await fs.stat(outputPath);
  const readEnd = stat.size > 0 ? stat.size - 1 : undefined;
  const seenUrls = new Set();
  const safeConcurrency = Math.max(1, Number.parseInt(detailConcurrency, 10) || 1);
  const active = new Set();
  let appendCheckpoint = Promise.resolve();
  let scheduled = 0;
  let completed = 0;
  let skipped = 0;

  const queueAppend = (record) => {
    appendCheckpoint = appendCheckpoint.then(() => appendRecords(outputPath, [record]));
    return appendCheckpoint;
  };

  const schedule = (row) => {
    scheduled += 1;
    const task = (async () => {
      let details;
      try {
        const response = await fetchHtml(row.url, {
          timeoutMs,
          cookies,
          retries: 1
        });
        const $ = cheerio.load(response.html);
        details = extractBiographyDetails($, row.url);
      } catch (error) {
        details = { biography_url: row.url, biography_error: error.message };
      }

      await queueAppend({ ...row, ...details });
      enrichedUrls.add(row.url);
      completed += 1;
      console.log(`Scraped biography details ${completed}/${scheduled}`);

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    })();

    active.add(task);
    task.then(
      () => active.delete(task),
      () => active.delete(task)
    );
    return task;
  };

  await forEachCsvRecord(outputPath, async (row) => {
    if (!row.url || seenUrls.has(row.url)) {
      return;
    }

    seenUrls.add(row.url);
    if (enrichedUrls.has(row.url) || hasBiographyDetails(row)) {
      enrichedUrls.add(row.url);
      skipped += 1;
      return;
    }

    schedule(row);
    if (active.size >= safeConcurrency) {
      await Promise.race(active);
    }
  }, { end: readEnd });

  await Promise.all(active);
  await appendCheckpoint;

  return {
    scraped: completed,
    skipped,
    totalSeen: seenUrls.size
  };
}

async function scrapeBiographiesToCsv({
  baseUrl,
  outputPath,
  delayMs,
  maxPages,
  timeoutMs,
  fetchDetails = true,
  detailsDelayMs = 300,
  detailConcurrency = 3,
  initials,
  discoverInitials = false,
  csvProgress,
  resumeState = { initials: {} },
  onStateProgress
}) {
  await ensureCsvFile(outputPath);

  const first = discoverInitials ? await fetchHtml(baseUrl, { timeoutMs }) : null;
  const firstPage = first ? cheerio.load(first.html) : null;
  const initialUrls = discoverInitials
    ? extractInitialUrls(firstPage, baseUrl)
    : buildInitialUrls(baseUrl, initials);
  const urlsToScrape = initialUrls.length ? initialUrls : [baseUrl];

  const progress = csvProgress || await loadCsvProgress(outputPath);
  let totalPages = 0;
  let scrapedPages = 0;
  let latestCookies = first ? first.cookies : [];

  const appendNewListingRecords = async (records) => {
    const freshRecords = [];

    for (const record of records) {
      const key = getRecordKey(record);
      if (!key || progress.knownKeys.has(key)) {
        continue;
      }

      progress.knownKeys.add(key);
      freshRecords.push(record);
    }

    if (freshRecords.length) {
      await appendRecords(outputPath, freshRecords);
    }
  };

  for (const [index, initialUrl] of urlsToScrape.entries()) {
    const initialState = resumeState.initials?.[initialUrl];
    if (initialState?.completed) {
      totalPages += initialState.totalPages || 0;
      console.log(`Skipping completed initial ${index + 1}/${urlsToScrape.length}: ${initialUrl}`);
      continue;
    }

    const hasSavedPage = initialState?.html && initialState?.lastPage;
    const initialFirst = hasSavedPage
      ? { html: initialState.html, cookies: initialState.cookies || latestCookies }
      : await fetchHtml(initialUrl, { timeoutMs, cookies: latestCookies });
    const startPage = hasSavedPage ? initialState.lastPage : 1;

    const listing = await scrapeViaPostback({
      baseUrl: initialUrl,
      delayMs,
      maxPages,
      timeoutMs,
      firstHtml: initialFirst.html,
      firstCookies: initialFirst.cookies,
      startPage,
      accumulateRecords: false,
      onPageRecords: appendNewListingRecords,
      onPageState: onStateProgress
        ? (pageState) => onStateProgress({
            initialUrl,
            initialIndex: index,
            totalInitials: urlsToScrape.length,
            completed: false,
            ...pageState
          })
        : undefined
    });

    latestCookies = listing.cookies;
    totalPages += listing.totalPages;
    scrapedPages += listing.scrapedPages;

    if (onStateProgress) {
      await onStateProgress({
        initialUrl,
        initialIndex: index,
        totalInitials: urlsToScrape.length,
        page: listing.currentPage,
        totalPages: listing.totalPages,
        html: listing.html,
        cookies: latestCookies,
        completed: true
      });
    }

    console.log(`Completed initial ${index + 1}/${urlsToScrape.length}: ${initialUrl}`);
    if (index < urlsToScrape.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  const detailStats = fetchDetails
    ? await enrichCsvWithBiographyPages({
        outputPath,
        timeoutMs,
        delayMs: detailsDelayMs,
        cookies: latestCookies,
        detailConcurrency,
        enrichedUrls: progress.enrichedUrls
      })
    : { scraped: 0, skipped: progress.enrichedUrls.size, totalSeen: progress.knownKeys.size };

  return {
    totalPages,
    scrapedPages,
    recordsSaved: progress.knownKeys.size,
    detailsScraped: detailStats.scraped,
    detailsSkipped: detailStats.skipped,
    detailRowsSeen: detailStats.totalSeen
  };
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
  discoverInitials = false,
  existingRecords = [],
  onProgress,
  resumeState = { initials: {} },
  onStateProgress
}) {
  const first = discoverInitials ? await fetchHtml(baseUrl, { timeoutMs }) : null;
  const firstPage = first ? cheerio.load(first.html) : null;
  const initialUrls = discoverInitials
    ? extractInitialUrls(firstPage, baseUrl)
    : buildInitialUrls(baseUrl, initials);
  const urlsToScrape = initialUrls.length ? initialUrls : [baseUrl];

  const allRecords = [...existingRecords];
  let totalPages = 0;
  let scrapedPages = 0;
  let latestCookies = first ? first.cookies : [];

  for (const [index, initialUrl] of urlsToScrape.entries()) {
    const initialState = resumeState.initials?.[initialUrl];
    if (initialState?.completed) {
      totalPages += initialState.totalPages || 0;
      console.log(`Skipping completed initial ${index + 1}/${urlsToScrape.length}: ${initialUrl}`);
      continue;
    }

    const hasSavedPage = initialState?.html && initialState?.lastPage;
    const initialFirst = hasSavedPage
      ? { html: initialState.html, cookies: initialState.cookies || latestCookies }
      : await fetchHtml(initialUrl, { timeoutMs, cookies: latestCookies });
    const startPage = hasSavedPage ? initialState.lastPage : 1;

    const listing = await scrapeViaPostback({
      baseUrl: initialUrl,
      delayMs,
      maxPages,
      timeoutMs,
      firstHtml: initialFirst.html,
      firstCookies: initialFirst.cookies,
      startPage,
      onRecords: onProgress
        ? (currentInitialRecords) => onProgress([...allRecords, ...currentInitialRecords])
        : undefined,
      onPageState: onStateProgress
        ? (pageState) => onStateProgress({
            initialUrl,
            initialIndex: index,
            totalInitials: urlsToScrape.length,
            completed: false,
            ...pageState
          })
        : undefined
    });

    latestCookies = listing.cookies;
    totalPages += listing.totalPages;
    scrapedPages += listing.scrapedPages;
    allRecords.push(...listing.records);

    if (onStateProgress) {
      await onStateProgress({
        initialUrl,
        initialIndex: index,
        totalInitials: urlsToScrape.length,
        page: listing.currentPage,
        totalPages: listing.totalPages,
        html: listing.html,
        cookies: latestCookies,
        completed: true
      });
    }

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
        detailConcurrency,
        existingRecords,
        onProgress
      })
    : allRecords;

  if (onProgress) {
    await onProgress(records);
  }

  return {
    totalPages,
    scrapedPages,
    records: dedupeRecords(records)
  };
}

async function main() {
  const options = {
    baseUrl: process.env.BASE_URL || 'https://www.ipsb.nina.gov.pl/Search/Type,Biography/Initial,A/',
    outputPath: process.env.OUTPUT || 'biography_data.csv',
    statePath: process.env.STATE_PATH || getDefaultStatePath(process.env.OUTPUT || 'biography_data.csv'),
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
    discoverInitials: process.env.INITIALS === 'discover',
    resume: process.env.RESUME === 'false' ? false : true
  };

  try {
    if (options.resume) {
      await ensureCsvFile(options.outputPath);
    } else {
      await fs.writeFile(options.outputPath, `${CSV_COLUMNS.join(',')}\n`, 'utf8');
      await saveScrapeState(options.statePath, { initials: {} });
    }

    const scrapeState = options.resume ? await loadScrapeState(options.statePath) : { initials: {} };
    const csvProgress = await loadCsvProgress(options.outputPath);
    if (csvProgress.knownKeys.size) {
      console.log(`Loaded ${csvProgress.knownKeys.size} unique record keys from existing CSV for resume/deduplication`);
    }

    let saveStateCheckpoint = Promise.resolve();
    const queueStateCheckpoint = ({ initialUrl, ...progress }) => {
      scrapeState.initials[initialUrl] = {
        ...(scrapeState.initials[initialUrl] || {}),
        ...progress,
        lastPage: progress.page,
        updatedAt: new Date().toISOString()
      };
      saveStateCheckpoint = saveStateCheckpoint.then(() => saveScrapeState(options.statePath, scrapeState));
      return saveStateCheckpoint;
    };

    const result = await scrapeBiographiesToCsv({
      ...options,
      csvProgress,
      resumeState: scrapeState,
      onStateProgress: queueStateCheckpoint
    });
    await saveStateCheckpoint;

    const compacted = await compactCsv(options.outputPath);

    console.log(`Total pages available: ${result.totalPages}`);
    console.log(`Pages scraped: ${result.scrapedPages}`);
    console.log(`Biography details scraped: ${result.detailsScraped}`);
    console.log(`Biography details already present: ${result.detailsSkipped}`);
    console.log(`Records saved: ${compacted.records}`);
    console.log(`Output file: ${options.outputPath}`);
    console.log(`Resume state file: ${options.statePath}`);
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
  scrapeBiographiesToCsv,
  toCsv,
  parseCsv,
  parseCsvRows,
  dedupeRecords,
  loadExistingRecords,
  saveRecords,
  appendRecords,
  loadCsvProgress,
  compactCsv,
  getDefaultStatePath,
  loadScrapeState,
  saveScrapeState,
  updateCookies
};
