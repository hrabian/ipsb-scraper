const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cheerio = require('cheerio');

const {
  extractTotalPages,
  extractBiographyItems,
  extractBiographyDetails,
  getPostbackTargetFromId,
  parseAspNetState,
  getPaginationTargets,
  toCsv,
  updateCookies,
  extractInitialUrls,
  buildInitialUrls,
  appendRecords,
  loadCsvProgress,
  compactCsv,
  parseCsv
} = require('../scraper');

test('extractTotalPages returns highest visible page number from links and span', () => {
  const $ = cheerio.load(`
    <div class="pages">
      <span>1</span>
      <a id="SJK_ctl0_MC_C_ASC_ctl13_ctl1">2</a>
      <a id="SJK_ctl0_MC_C_ASC_ctl13_ctl2">3</a>
      <a id="SJK_ctl0_MC_C_ASC_ctl13_ctl10">></a>
    </div>
  `);

  assert.equal(extractTotalPages($), 3);
});

test('extractBiographyItems parses biography cards and joins activity links', () => {
  const $ = cheerio.load(`
    <div class="personItem">
      <div class="name"><a href="/a/biografia/test">Jan Kowalski</a></div>
      <span class="dates">1900-1980</span>
      <div class="activity">
        <a href="/Search/Type,Biography/Tag,1/">poeta</a>
        <a href="/Search/Type,Biography/Tag,2/">eseista</a>
      </div>
    </div>
  `);

  assert.deepEqual(extractBiographyItems($, 'https://www.ipsb.nina.gov.pl'), [
    {
      url: 'https://www.ipsb.nina.gov.pl/a/biografia/test',
      name: 'Jan Kowalski',
      dates: '1900-1980',
      activity: 'poeta | eseista'
    }
  ]);
});

test('extractBiographyDetails parses data from biography page', () => {
  const $ = cheerio.load(`
    <meta property="og:title" content="Antoni Abraham" />
    <span itemprop="givenName">Antoni</span>
    <span itemprop="familyName">Abraham</span>
    <span class="birthDateText">1869-12-19</span>
    <span class="deathDateText">1923-06-23</span>
    <div class="personalDataControl">
      <div class="black-bg">
        <a href="/Search/Type,Biography/Tag,444/">pisarz ludowy</a>
        <a href="/Search/Type,Biography/Tag,18090/">działacz kaszubski</a>
      </div>
    </div>
    <div itemprop="description">To jest biogram testowy.</div>
  `);

  const details = extractBiographyDetails($, 'https://www.ipsb.nina.gov.pl', 'https://www.ipsb.nina.gov.pl/a/biografia/test');
  assert.equal(details.biography_name, 'Antoni Abraham');
  assert.equal(details.biography_birth_date, '1869-12-19');
  assert.equal(details.biography_death_date, '1923-06-23');
  assert.equal(details.biography_activities, 'pisarz ludowy | działacz kaszubski');
  assert.equal(details.biography_text, 'To jest biogram testowy.');
});

test('getPostbackTargetFromId converts DOM id to PRADO event target format', () => {
  assert.equal(
    getPostbackTargetFromId('SJK_ctl0_MC_C_ASC_ctl13_ctl1'),
    'SJK$ctl0$MC$C$ASC$ctl13$ctl1'
  );
  assert.equal(getPostbackTargetFromId('arf_ctl0_MC_ctl0_X'), 'arf$ctl0$MC$ctl0$X');
});

test('parseAspNetState and getPaginationTargets extract postback data', () => {
  const $ = cheerio.load(`
    <form action="/Search/Type,Biography/Initial,A/">
      <input type="hidden" name="SJKPRADO_PAGESTATE" value="abc123" />
      <input type="hidden" name="PRADO_PAGESTATE" value="" />
      <input type="hidden" name="__VIEWSTATE" value="xyz" />
      <div class="pages">
        <span>1</span>
        <a id="SJK_ctl0_MC_C_ASC_ctl13_ctl1">2</a>
        <a id="SJK_ctl0_MC_C_ASC_ctl13_ctl10">></a>
      </div>
    </form>
  `);

  const state = parseAspNetState($);
  const pagination = getPaginationTargets($);

  assert.equal(state.action, '/Search/Type,Biography/Initial,A/');
  assert.equal(state.appPageStateName, 'SJKPRADO_PAGESTATE');
  assert.equal(state.appPageState, 'abc123');
  assert.deepEqual(state.extraHiddenFields, [{ name: '__VIEWSTATE', value: 'xyz' }]);
  assert.equal(pagination.numeric.get(2), 'SJK_ctl0_MC_C_ASC_ctl13_ctl1');
  assert.equal(pagination.nextId, 'SJK_ctl0_MC_C_ASC_ctl13_ctl10');
});

test('toCsv escapes commas and quotes and keeps biography columns', () => {
  const csv = toCsv([
    {
      url: 'https://x/y',
      name: 'Jan "X"',
      dates: '1900,1980',
      activity: 'poeta | eseista',
      biography_name: 'Jan X'
    }
  ]);

  assert.match(csv, /"Jan ""X"""/);
  assert.match(csv, /"1900,1980"/);
  assert.match(csv.split('\n')[0], /biography_name/);
});

test('toCsv creates a complete header row for empty checkpoints', () => {
  const csv = toCsv([]);
  const headers = csv.split('\n')[0].split(',');

  assert.deepEqual(headers, [
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
  ]);
});

test('updateCookies keeps full cookie values including "="', () => {
  const updated = updateCookies(['token=abc=123'], ['session=new=value; Path=/; HttpOnly']);
  assert.deepEqual(updated.sort(), ['session=new=value', 'token=abc=123'].sort());
});

test('extractInitialUrls discovers unique initial links and buildInitialUrls replaces current initial', () => {
  const $ = cheerio.load(`
    <div class="alphabet">
      <a href="/Search/Type,Biography/Initial,A/">A</a>
      <a href="/Search/Type,Biography/Initial,B/">B</a>
      <a href="/Search/Type,Biography/Initial,A/">A duplicate</a>
    </div>
  `);

  assert.deepEqual(extractInitialUrls($, 'https://www.ipsb.nina.gov.pl/Search/Type,Biography/Initial,A/'), [
    'https://www.ipsb.nina.gov.pl/Search/Type,Biography/Initial,A/',
    'https://www.ipsb.nina.gov.pl/Search/Type,Biography/Initial,B/'
  ]);

  assert.deepEqual(buildInitialUrls('https://www.ipsb.nina.gov.pl/Search/Type,Biography/Initial,A/', ['A', 'Ł']), [
    'https://www.ipsb.nina.gov.pl/Search/Type,Biography/Initial,A/',
    'https://www.ipsb.nina.gov.pl/Search/Type,Biography/Initial,%C5%81/'
  ]);
});

test('parseCsv and dedupeRecords detect duplicate CSV rows by URL and merge newest data', () => {
  const {
    dedupeRecords
  } = require('../scraper');

  const parsed = parseCsv('url,name,biography_text\nhttps://x/a,Old,"old, text"\nhttps://x/a,New,new text\n');
  const deduped = dedupeRecords(parsed);

  assert.equal(parsed.length, 2);
  assert.equal(deduped.length, 1);
  assert.deepEqual(deduped[0], {
    url: 'https://x/a',
    name: 'New',
    biography_text: 'new text'
  });
});

test('appendRecords checkpoints incrementally and compactCsv keeps the latest row per URL', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipsb-stream-csv-'));
  const outputPath = path.join(tempDir, 'biography_data.csv');

  try {
    await appendRecords(outputPath, [
      {
        url: 'https://www.ipsb.nina.gov.pl/a/biografia/test',
        name: 'Test Person',
        activity: 'pisarz'
      }
    ]);
    await appendRecords(outputPath, [
      {
        url: 'https://www.ipsb.nina.gov.pl/a/biografia/test',
        name: 'Test Person',
        activity: 'pisarz',
        biography_text: 'Full biography text.'
      }
    ]);

    const progress = await loadCsvProgress(outputPath);
    assert.equal(progress.knownKeys.size, 1);
    assert.equal(progress.enrichedUrls.has('https://www.ipsb.nina.gov.pl/a/biografia/test'), true);

    const compacted = await compactCsv(outputPath);
    const rows = parseCsv(await fs.readFile(outputPath, 'utf8'));

    assert.equal(compacted.records, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].biography_text, 'Full biography text.');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
