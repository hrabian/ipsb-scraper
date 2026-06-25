const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  scrapeBiographies,
  scrapeBiographiesToCsv,
  saveRecords,
  compactCsv,
  parseCsv
} = require('../scraper');

function pageHtml({ currentPage, pagerLabels, biographies }) {
  const pager = pagerLabels
    .map((entry) => {
      if (entry.current) {
        return `<span>${entry.label}</span>`;
      }
      return `<a id="${entry.id}">${entry.label}</a>`;
    })
    .join('\n');

  const cards = biographies
    .map(
      (bio) => `
      <div class="personItem">
        <div class="name"><a href="${bio.url}">${bio.name}</a></div>
        <span class="dates">${bio.dates}</span>
        <div class="activity">${bio.activities
          .map((a) => `<a href="/Search/Type,Biography/Tag,1/">${a}</a>`)
          .join('')}</div>
      </div>
    `
    )
    .join('\n');

  return `
    <form action="/Search/Type,Biography/Initial,A/">
      <input type="hidden" name="SJKPRADO_PAGESTATE" value="state-${currentPage}" />
      <input type="hidden" name="PRADO_PAGESTATE" value="" />
      <input type="hidden" name="__VIEWSTATE" value="view-${currentPage}" />
      <input type="hidden" name="PRADO_POSTBACK_TARGET" value="" />
      <input type="hidden" name="PRADO_POSTBACK_PARAMETER" value="" />
      <div class="pages">${pager}</div>
      ${cards}
    </form>
  `;
}

function biographyHtml({ name, surname, birth, death, activities, description }) {
  return `
    <span itemprop="givenName">${name}</span>
    <span itemprop="familyName">${surname}</span>
    <span class="birthDateText">${birth}</span>
    <span class="deathDateText">${death}</span>
    <div class="personalDataControl"><div class="black-bg">${activities
      .map((a) => `<a href="/Search/Type,Biography/Tag,1/">${a}</a>`)
      .join('')}</div></div>
    <div itemprop="description">${description}</div>
  `;
}

function createServer() {
  const page1 = pageHtml({
    currentPage: 1,
    pagerLabels: [
      { label: '1', current: true },
      { label: '2', id: 'SJK_ctl0_MC_C_ASC_ctl13_ctl1' }
    ],
    biographies: [{ url: '/a/biografia/ala', name: 'Ala', dates: '1901-1981', activities: ['pisarka'] }]
  });

  const page2 = pageHtml({
    currentPage: 2,
    pagerLabels: [{ label: '2', current: true }],
    biographies: [{ url: '/a/biografia/adam', name: 'Adam', dates: '1910-1990', activities: ['muzyk'] }]
  });

  const detailAla = biographyHtml({
    name: 'Ala',
    surname: 'Nowak',
    birth: '1901-01-01',
    death: '1981-01-01',
    activities: ['pisarka', 'poetka'],
    description: 'Ala opis biograficzny.'
  });

  const detailAdam = biographyHtml({
    name: 'Adam',
    surname: 'Kowal',
    birth: '1910-01-01',
    death: '1990-01-01',
    activities: ['muzyk'],
    description: 'Adam opis biograficzny.'
  });

  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/Search/Type,Biography/Initial,A/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(page1);
      return;
    }

    if (req.method === 'GET' && req.url === '/a/biografia/ala') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(detailAla);
      return;
    }

    if (req.method === 'GET' && req.url === '/a/biografia/adam') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(detailAdam);
      return;
    }

    if (req.method === 'POST' && req.url === '/Search/Type,Biography/Initial,A/') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const params = new URLSearchParams(body);
        const target = params.get('PRADO_POSTBACK_TARGET');

        res.setHeader('content-type', 'text/html; charset=utf-8');
        if (target === 'SJK$ctl0$MC$C$ASC$ctl13$ctl1') {
          res.end(page2);
          return;
        }
        res.end(page1);
      });
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });
}

test('scrapeBiographies follows postbacks and enriches records from biography pages', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/Search/Type,Biography/Initial,A/`;

  try {
    const result = await scrapeBiographies({
      baseUrl,
      delayMs: 0,
      timeoutMs: 5000,
      maxPages: 2,
      fetchDetails: true,
      detailsDelayMs: 0
    });

    assert.equal(result.totalPages, 2);
    assert.equal(result.scrapedPages, 2);
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0].biography_name, 'Ala Nowak');
    assert.equal(result.records[1].biography_activities, 'muzyk');
    assert.equal(result.records[0].biography_text, 'Ala opis biograficzny.');
  } finally {
    server.close();
  }
});

test('scrapeBiographiesToCsv checkpoints listings and details in low-memory mode', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ipsb-low-memory-'));
  const outputPath = path.join(tempDir, 'biography_data.csv');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/Search/Type,Biography/Initial,A/`;

  try {
    const result = await scrapeBiographiesToCsv({
      baseUrl,
      outputPath,
      delayMs: 0,
      timeoutMs: 5000,
      maxPages: 2,
      fetchDetails: true,
      detailsDelayMs: 0
    });
    const compacted = await compactCsv(outputPath);
    const rows = parseCsv(await fsp.readFile(outputPath, 'utf8'));

    assert.equal(result.totalPages, 2);
    assert.equal(result.scrapedPages, 2);
    assert.equal(result.recordsSaved, 2);
    assert.equal(result.detailsScraped, 2);
    assert.equal(compacted.records, 2);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].biography_name, 'Ala Nowak');
    assert.equal(rows[1].biography_text, 'Adam opis biograficzny.');
  } finally {
    server.close();
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

function createPagedServer(totalPages) {
  function renderPage(page) {
    const groupStart = page <= 10 ? 1 : 11;
    const groupEnd = Math.min(totalPages, groupStart + 9);
    const pagerLabels = [];

    for (let n = groupStart; n <= groupEnd; n += 1) {
      pagerLabels.push(n === page ? { label: String(n), current: true } : { label: String(n), id: `pager_${n}` });
    }

    if (groupEnd < totalPages) {
      pagerLabels.push({ label: '>', id: 'pager_next' });
    }

    return pageHtml({
      currentPage: page,
      pagerLabels,
      biographies: [
        { url: `/a/biografia/person-${page}`, name: `Person ${page}`, dates: '1900-1980', activities: ['test'] }
      ]
    });
  }

  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/Search/Type,Biography/Initial,A/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(renderPage(1));
      return;
    }

    if (req.method === 'POST' && req.url === '/Search/Type,Biography/Initial,A/') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const target = params.get('PRADO_POSTBACK_TARGET');
        const requestedPage = target === 'pager$next' ? 11 : Number.parseInt((target || '').replace('pager$', ''), 10);

        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(renderPage(Number.isFinite(requestedPage) ? requestedPage : 1));
      });
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });
}

test('scrapeBiographies continues past the first visible pager group', async () => {
  const server = createPagedServer(12);
  await new Promise((resolve) => server.listen(0, resolve));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/Search/Type,Biography/Initial,A/`;

  try {
    const result = await scrapeBiographies({
      baseUrl,
      delayMs: 0,
      timeoutMs: 5000,
      fetchDetails: false
    });

    assert.equal(result.totalPages, 12);
    assert.equal(result.scrapedPages, 12);
    assert.equal(result.records.length, 12);
    assert.equal(result.records.at(-1).name, 'Person 12');
  } finally {
    server.close();
  }
});

test('scrapeBiographies can scrape more than one initial and fetch duplicate details once', async () => {
  let duplicateDetailRequests = 0;

  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');

    if (req.method === 'GET' && req.url === '/Search/Type,Biography/Initial,A/') {
      res.end(pageHtml({
        currentPage: 1,
        pagerLabels: [{ label: '1', current: true }],
        biographies: [
          { url: '/a/biografia/shared', name: 'Shared A', dates: '1900-1980', activities: ['test'] },
          { url: '/a/biografia/shared', name: 'Shared A duplicate', dates: '1900-1980', activities: ['test'] }
        ]
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/Search/Type,Biography/Initial,B/') {
      res.end(pageHtml({
        currentPage: 1,
        pagerLabels: [{ label: '1', current: true }],
        biographies: [{ url: '/a/biografia/beta', name: 'Beta', dates: '1910-1990', activities: ['test'] }]
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/a/biografia/shared') {
      duplicateDetailRequests += 1;
      res.end(biographyHtml({
        name: 'Shared',
        surname: 'Person',
        birth: '1900-01-01',
        death: '1980-01-01',
        activities: ['test'],
        description: 'Shared biography.'
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/a/biografia/beta') {
      res.end(biographyHtml({
        name: 'Beta',
        surname: 'Person',
        birth: '1910-01-01',
        death: '1990-01-01',
        activities: ['test'],
        description: 'Beta biography.'
      }));
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const result = await scrapeBiographies({
      baseUrl: `http://127.0.0.1:${port}/Search/Type,Biography/Initial,A/`,
      initials: ['A', 'B'],
      delayMs: 0,
      timeoutMs: 5000,
      fetchDetails: true,
      detailsDelayMs: 0,
      detailConcurrency: 4
    });

    assert.equal(result.scrapedPages, 2);
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0].biography_name, 'Shared Person');
    assert.equal(result.records[1].biography_text, 'Beta biography.');
    assert.equal(duplicateDetailRequests, 1);
  } finally {
    server.close();
  }
});

test('scrapeBiographies resumes from existing records and skips already enriched details', async () => {
  let oldDetailRequests = 0;
  let newDetailRequests = 0;

  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');

    if (req.method === 'GET' && req.url === '/Search/Type,Biography/Initial,A/') {
      res.end(pageHtml({
        currentPage: 1,
        pagerLabels: [{ label: '1', current: true }],
        biographies: [
          { url: '/a/biografia/old', name: 'Old', dates: '1900-1980', activities: ['test'] },
          { url: '/a/biografia/new', name: 'New', dates: '1910-1990', activities: ['test'] }
        ]
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/a/biografia/old') {
      oldDetailRequests += 1;
      res.end(biographyHtml({
        name: 'Old',
        surname: 'Person',
        birth: '1900-01-01',
        death: '1980-01-01',
        activities: ['test'],
        description: 'Should not be fetched again.'
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/a/biografia/new') {
      newDetailRequests += 1;
      res.end(biographyHtml({
        name: 'New',
        surname: 'Person',
        birth: '1910-01-01',
        death: '1990-01-01',
        activities: ['test'],
        description: 'Fetched after resume.'
      }));
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const oldUrl = `http://127.0.0.1:${port}/a/biografia/old`;

  try {
    const result = await scrapeBiographies({
      baseUrl: `http://127.0.0.1:${port}/Search/Type,Biography/Initial,A/`,
      delayMs: 0,
      timeoutMs: 5000,
      fetchDetails: true,
      detailsDelayMs: 0,
      existingRecords: [{
        url: oldUrl,
        name: 'Old existing',
        biography_text: 'Already saved.'
      }]
    });

    assert.equal(result.records.length, 2);
    assert.equal(result.records.find((row) => row.url === oldUrl).biography_text, 'Already saved.');
    assert.equal(result.records.find((row) => row.name === 'New').biography_text, 'Fetched after resume.');
    assert.equal(oldDetailRequests, 0);
    assert.equal(newDetailRequests, 1);
  } finally {
    server.close();
  }
});

test('scrapeBiographies refetches resume records that are missing biography details', async () => {
  let incompleteDetailRequests = 0;

  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');

    if (req.method === 'GET' && req.url === '/Search/Type,Biography/Initial,A/') {
      res.end(pageHtml({
        currentPage: 1,
        pagerLabels: [{ label: '1', current: true }],
        biographies: [
          { url: '/a/biografia/incomplete', name: 'Incomplete', dates: '1900-1980', activities: ['test'] }
        ]
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/a/biografia/incomplete') {
      incompleteDetailRequests += 1;
      res.end(biographyHtml({
        name: 'Incomplete',
        surname: 'Person',
        birth: '1900-01-01',
        death: '1980-01-01',
        activities: ['test'],
        description: 'Fetched missing details.'
      }));
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const incompleteUrl = `http://127.0.0.1:${port}/a/biografia/incomplete`;

  try {
    const result = await scrapeBiographies({
      baseUrl: `http://127.0.0.1:${port}/Search/Type,Biography/Initial,A/`,
      delayMs: 0,
      timeoutMs: 5000,
      fetchDetails: true,
      detailsDelayMs: 0,
      existingRecords: [{
        url: incompleteUrl,
        name: 'Incomplete existing'
      }]
    });

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].biography_text, 'Fetched missing details.');
    assert.equal(incompleteDetailRequests, 1);
  } finally {
    server.close();
  }
});

test('scrapeBiographies writes a checkpoint before fetching biography details', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ipsb-checkpoint-'));
  const outputPath = path.join(tempDir, 'biography_data.csv');
  let checkpointExistedBeforeDetails = false;

  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');

    if (req.method === 'GET' && req.url === '/Search/Type,Biography/Initial,A/') {
      res.end(pageHtml({
        currentPage: 1,
        pagerLabels: [{ label: '1', current: true }],
        biographies: [
          { url: '/a/biografia/checkpoint', name: 'Checkpoint', dates: '1900-1980', activities: ['test'] }
        ]
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/a/biografia/checkpoint') {
      checkpointExistedBeforeDetails = fs.existsSync(outputPath)
        && fs.readFileSync(outputPath, 'utf8').includes('Checkpoint');
      res.end(biographyHtml({
        name: 'Checkpoint',
        surname: 'Person',
        birth: '1900-01-01',
        death: '1980-01-01',
        activities: ['test'],
        description: 'Checkpoint details.'
      }));
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const result = await scrapeBiographies({
      baseUrl: `http://127.0.0.1:${port}/Search/Type,Biography/Initial,A/`,
      delayMs: 0,
      timeoutMs: 5000,
      fetchDetails: true,
      detailsDelayMs: 0,
      onProgress: (records) => saveRecords(outputPath, records)
    });

    const finalCsv = await fsp.readFile(outputPath, 'utf8');
    assert.equal(result.records.length, 1);
    assert.equal(checkpointExistedBeforeDetails, true);
    assert.match(finalCsv, /Checkpoint details\./);
  } finally {
    server.close();
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('scrapeBiographies resumes listing from the saved page state', async () => {
  let initialGetRequests = 0;
  let postRequests = 0;
  const completedStates = [];

  const savedPage2 = pageHtml({
    currentPage: 2,
    pagerLabels: [
      { label: '1', id: 'pager_1' },
      { label: '2', current: true },
      { label: '3', id: 'pager_3' }
    ],
    biographies: [
      { url: '/a/biografia/person-2', name: 'Person 2', dates: '1900-1980', activities: ['test'] }
    ]
  });

  const page3 = pageHtml({
    currentPage: 3,
    pagerLabels: [
      { label: '2', id: 'pager_2' },
      { label: '3', current: true }
    ],
    biographies: [
      { url: '/a/biografia/person-3', name: 'Person 3', dates: '1900-1980', activities: ['test'] }
    ]
  });

  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');

    if (req.method === 'GET' && req.url === '/Search/Type,Biography/Initial,A/') {
      initialGetRequests += 1;
      res.statusCode = 500;
      res.end('Should resume from saved HTML instead of fetching page 1');
      return;
    }

    if (req.method === 'POST' && req.url === '/Search/Type,Biography/Initial,A/') {
      postRequests += 1;
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        assert.equal(params.get('PRADO_POSTBACK_TARGET'), 'pager$3');
        res.end(page3);
      });
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/Search/Type,Biography/Initial,A/`;

  try {
    const result = await scrapeBiographies({
      baseUrl,
      delayMs: 0,
      timeoutMs: 5000,
      maxPages: 3,
      fetchDetails: false,
      existingRecords: [
        {
          url: `http://127.0.0.1:${port}/a/biografia/person-1`,
          name: 'Person 1'
        },
        {
          url: `http://127.0.0.1:${port}/a/biografia/person-2`,
          name: 'Person 2'
        }
      ],
      resumeState: {
        initials: {
          [baseUrl]: {
            lastPage: 2,
            html: savedPage2,
            cookies: []
          }
        }
      },
      onStateProgress: (state) => {
        completedStates.push(state);
      }
    });

    assert.equal(initialGetRequests, 0);
    assert.equal(postRequests, 1);
    assert.equal(result.scrapedPages, 1);
    assert.equal(result.records.length, 3);
    assert.equal(result.records.at(-1).name, 'Person 3');
    assert.equal(completedStates.at(-1).completed, true);
    assert.equal(completedStates.at(-1).page, 3);
  } finally {
    server.close();
  }
});
