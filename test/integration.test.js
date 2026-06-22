const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { scrapeBiographies, scrapeAllBiographies } = require('../scraper');

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

function createLongPagedServer(totalPages) {
  function makePage(page) {
    const visibleStart = page <= 10 ? 1 : 11;
    const visibleEnd = Math.min(totalPages, visibleStart + 9);
    const pagerLabels = [];

    for (let label = visibleStart; label <= visibleEnd; label += 1) {
      if (label === page) {
        pagerLabels.push({ label: String(label), current: true });
      } else {
        pagerLabels.push({ label: String(label), id: `SJK_ctl0_MC_C_ASC_ctl13_ctl${label}` });
      }
    }

    if (visibleEnd < totalPages) {
      pagerLabels.push({ label: '>', id: 'SJK_ctl0_MC_C_ASC_ctl13_next' });
    }

    return pageHtml({
      currentPage: page,
      pagerLabels,
      biographies: [
        {
          url: `/a/biografia/person-${page}`,
          name: `Person ${page}`,
          dates: `1900 - 19${String(page).padStart(2, '0')}`,
          activities: ['test']
        }
      ]
    });
  }

  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/Search/Type,Biography/Initial,A/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(makePage(1));
      return;
    }

    if (req.method === 'POST' && req.url === '/Search/Type,Biography/Initial,A/') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const params = new URLSearchParams(body);
        const target = params.get('PRADO_POSTBACK_TARGET') || '';
        const targetPageMatch = target.match(/ctl13\$ctl(\d+)$/);
        const targetPage = target.includes('ctl13$next') ? 11 : Number.parseInt(targetPageMatch?.[1] || '1', 10);

        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(makePage(targetPage));
      });
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });
}

test('scrapeBiographies continues past first visible pager window', async () => {
  const server = createLongPagedServer(12);
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


function createMultiInitialServer() {
  function makePage(initial) {
    return pageHtml({
      currentPage: 1,
      pagerLabels: [{ label: '1', current: true }],
      biographies: [
        {
          url: `/a/biografia/person-${encodeURIComponent(initial)}`,
          name: `Person ${initial}`,
          dates: '1900 - 1950',
          activities: ['test']
        }
      ]
    });
  }

  return http.createServer((req, res) => {
    const match = decodeURIComponent(req.url).match(/Initial,([^/]+)\//);
    if (req.method === 'GET' && match) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(makePage(match[1]));
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });
}

test('scrapeAllBiographies aggregates configured initials', async () => {
  const server = createMultiInitialServer();
  await new Promise((resolve) => server.listen(0, resolve));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/Search/Type,Biography/Initial,A/`;

  try {
    const result = await scrapeAllBiographies({
      baseUrl,
      initials: ['A', 'B', 'Ł'],
      delayMs: 0,
      initialDelayMs: 0,
      timeoutMs: 5000,
      fetchDetails: false
    });

    assert.equal(result.scrapedPages, 3);
    assert.equal(result.records.length, 3);
    assert.deepEqual(
      result.records.map((record) => record.initial),
      ['A', 'B', 'Ł']
    );
  } finally {
    server.close();
  }
});
