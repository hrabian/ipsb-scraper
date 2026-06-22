const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const {
  extractTotalPages,
  extractBiographyItems,
  extractBiographyDetails,
  getPostbackTargetFromId,
  parseAspNetState,
  getPaginationTargets,
  toCsv,
  parseCsv,
  dedupeRecords,
  updateCookies,
  extractInitialUrls,
  buildInitialUrls
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

test('parseCsv reads escaped values and dedupeRecords keeps enriched duplicates', () => {
  const csv = toCsv([
    {
      url: 'https://x/y',
      name: 'Jan "X"',
      dates: '1900,1980',
      biography_name: ''
    },
    {
      url: 'https://x/y',
      name: 'Jan X',
      dates: '1900,1980',
      biography_name: 'Jan X',
      biography_text: 'Opis'
    }
  ]);

  const parsed = parseCsv(csv);
  assert.equal(parsed[0].name, 'Jan "X"');
  assert.equal(parsed[0].dates, '1900,1980');

  const deduped = dedupeRecords(parsed);
  assert.equal(deduped.duplicates, 1);
  assert.equal(deduped.records.length, 1);
  assert.equal(deduped.records[0].biography_text, 'Opis');
});


test('dedupeRecords keeps successful biography text over duplicate errors', () => {
  const deduped = dedupeRecords([
    { url: 'https://x/y', name: 'Jan X', biography_text: 'Poprawny opis' },
    { url: 'https://x/y', name: 'Jan X', biography_error: 'HTTP 500' }
  ]);

  assert.equal(deduped.duplicates, 1);
  assert.equal(deduped.records.length, 1);
  assert.equal(deduped.records[0].biography_text, 'Poprawny opis');
  assert.equal(deduped.records[0].biography_error, undefined);
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
