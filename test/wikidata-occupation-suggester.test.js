const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeForMatching,
  splitActivities,
  suggestOccupationsForActivity,
  suggestOccupationStatements,
  toQuickStatements,
  parseArgs
} = require('../wikidata-occupation-suggester');

test('normalizes Polish activity labels and splits activity column values', () => {
  assert.equal(normalizeForMatching('  Działaczka społeczna, Łódź! '), 'dzialaczka spoleczna lodz');
  assert.deepEqual(splitActivities('pisarka | poetka; działaczka społeczna'), [
    'pisarka',
    'poetka',
    'działaczka społeczna'
  ]);
});

test('suggests Wikidata occupation statements from IPSB activity values', () => {
  const suggestions = suggestOccupationStatements([
    {
      wikidata_qid: 'Q123',
      name: 'Ala Nowak',
      url: 'https://www.ipsb.nina.gov.pl/a/biografia/ala-nowak',
      activity: 'pisarka | poetka'
    }
  ]);

  assert.deepEqual(suggestions.map((suggestion) => suggestion.occupation_qid), ['Q36180', 'Q49757']);
  assert.equal(suggestions[0].property, 'P106');
  assert.equal(suggestions[0].reference_property, 'P854');
  assert.equal(suggestions[0].reference_url, 'https://www.ipsb.nina.gov.pl/a/biografia/ala-nowak');
});

test('quickstatements output includes occupation and IPSB URL reference', () => {
  const suggestions = suggestOccupationStatements([
    {
      wikidata_qid: 'Q123',
      url: 'https://www.ipsb.nina.gov.pl/a/biografia/ala-nowak',
      activity: 'pisarka'
    }
  ]);

  assert.equal(
    toQuickStatements(suggestions, new Date('2026-06-23T12:00:00Z')),
    'Q123\tP106\tQ36180\tS854\t"https://www.ipsb.nina.gov.pl/a/biografia/ala-nowak"\tS813\t+2026-06-23T00:00:00Z/11'
  );
});

test('occupation suggestion CLI args override input, output and format', () => {
  assert.deepEqual(parseArgs([
    '--input', 'in.csv',
    '--output', 'out.qs',
    '--format', 'quickstatements',
    '--activity-column', 'biography_activities',
    '--qid-column', 'item',
    '--min-confidence', '0.8'
  ]), {
    input: 'in.csv',
    output: 'out.qs',
    format: 'quickstatements',
    activityColumn: 'biography_activities',
    urlColumn: 'url',
    qidColumn: 'item',
    minConfidence: 0.8
  });
});

test('occupation suggestions avoid weak partial matches by default', () => {
  assert.deepEqual(
    suggestOccupationsForActivity('działaczka społeczna').map((suggestion) => suggestion.occupation_qid),
    ['Q10800557']
  );
});
