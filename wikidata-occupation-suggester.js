const fs = require('fs/promises');
const { parseCsv, toCsv } = require('./scraper');

const DEFAULT_ACTIVITY_COLUMN = 'activity';
const DEFAULT_URL_COLUMN = 'url';
const DEFAULT_QID_COLUMN = 'wikidata_qid';
const DEFAULT_MIN_CONFIDENCE = 0.7;

const OCCUPATION_SEEDS = [
  { qid: 'Q36180', label: 'pisarz', aliases: ['pisarz', 'pisarka', 'literat', 'literatka', 'prozaik', 'prozaiczka'] },
  { qid: 'Q49757', label: 'poeta', aliases: ['poeta', 'poetka'] },
  { qid: 'Q482980', label: 'autor', aliases: ['autor', 'autorka'] },
  { qid: 'Q1930187', label: 'dziennikarz', aliases: ['dziennikarz', 'dziennikarka', 'publicysta', 'publicystka'] },
  { qid: 'Q201788', label: 'historyk', aliases: ['historyk', 'historyczka'] },
  { qid: 'Q3621491', label: 'archeolog', aliases: ['archeolog', 'archeolożka'] },
  { qid: 'Q39631', label: 'lekarz', aliases: ['lekarz', 'lekarka', 'medyk', 'medyczka'] },
  { qid: 'Q40348', label: 'prawnik', aliases: ['prawnik', 'prawniczka', 'adwokat', 'adwokatka', 'radca prawny'] },
  { qid: 'Q82955', label: 'polityk', aliases: ['polityk', 'polityczka', 'działacz polityczny', 'działaczka polityczna'] },
  { qid: 'Q37226', label: 'nauczyciel', aliases: ['nauczyciel', 'nauczycielka', 'pedagog', 'pedagożka'] },
  { qid: 'Q121594', label: 'profesor', aliases: ['profesor', 'profesorka'] },
  { qid: 'Q1622272', label: 'wykładowca akademicki', aliases: ['wykładowca', 'wykładowczyni', 'akademik', 'akademiczka'] },
  { qid: 'Q1028181', label: 'malarz', aliases: ['malarz', 'malarka'] },
  { qid: 'Q1281618', label: 'rzeźbiarz', aliases: ['rzeźbiarz', 'rzeźbiarka'] },
  { qid: 'Q36834', label: 'kompozytor', aliases: ['kompozytor', 'kompozytorka'] },
  { qid: 'Q639669', label: 'muzyk', aliases: ['muzyk', 'muzyczka', 'instrumentalista', 'instrumentalistka'] },
  { qid: 'Q177220', label: 'śpiewak', aliases: ['śpiewak', 'śpiewaczka', 'piosenkarz', 'piosenkarka'] },
  { qid: 'Q33999', label: 'aktor', aliases: ['aktor', 'aktorka'] },
  { qid: 'Q2526255', label: 'reżyser filmowy', aliases: ['reżyser', 'reżyserka', 'reżyser filmowy', 'reżyserka filmowa'] },
  { qid: 'Q10800557', label: 'działacz społeczny', aliases: ['działacz społeczny', 'działaczka społeczna', 'społecznik', 'społeczniczka'] },
  { qid: 'Q42603', label: 'duchowny', aliases: ['duchowny', 'duchowna', 'ksiądz', 'kapłan', 'zakonnik', 'zakonnica'] },
  { qid: 'Q1234713', label: 'teolog', aliases: ['teolog', 'teolożka'] },
  { qid: 'Q81096', label: 'inżynier', aliases: ['inżynier', 'inżynierka'] },
  { qid: 'Q18844224', label: 'wojskowy', aliases: ['wojskowy', 'żołnierz', 'oficer'] },
  { qid: 'Q901', label: 'naukowiec', aliases: ['naukowiec', 'badacz', 'badaczka', 'uczony', 'uczona'] }
];

function normalizeForMatching(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitActivities(activity) {
  return String(activity || '')
    .split(/\s*(?:\||;|,)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildOccupationModel(seeds = OCCUPATION_SEEDS) {
  return seeds.map((seed) => ({
    ...seed,
    normalizedAliases: seed.aliases.map((alias) => normalizeForMatching(alias))
  }));
}

function scoreOccupation(activityPart, occupation) {
  const normalized = normalizeForMatching(activityPart);
  if (!normalized) {
    return 0;
  }

  let bestScore = 0;
  for (const alias of occupation.normalizedAliases) {
    if (normalized === alias) {
      bestScore = Math.max(bestScore, 1);
    } else if (normalized.includes(alias) || alias.includes(normalized)) {
      const shorter = Math.min(normalized.length, alias.length);
      const longer = Math.max(normalized.length, alias.length);
      bestScore = Math.max(bestScore, 0.75 + (0.2 * shorter) / longer);
    } else {
      const normalizedTokens = new Set(normalized.split(' '));
      const aliasTokens = alias.split(' ');
      const overlap = aliasTokens.filter((token) => normalizedTokens.has(token)).length;
      if (overlap) {
        bestScore = Math.max(bestScore, 0.45 + 0.35 * (overlap / aliasTokens.length));
      }
    }
  }

  return Number(bestScore.toFixed(3));
}

function suggestOccupationsForActivity(activity, { model = buildOccupationModel(), minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
  const suggestions = [];
  const seen = new Set();

  for (const activityPart of splitActivities(activity)) {
    for (const occupation of model) {
      const confidence = scoreOccupation(activityPart, occupation);
      if (confidence < minConfidence) {
        continue;
      }

      const key = `${occupation.qid}:${activityPart}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      suggestions.push({
        source_activity: activityPart,
        occupation_qid: occupation.qid,
        occupation_label: occupation.label,
        confidence
      });
    }
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence || a.occupation_label.localeCompare(b.occupation_label, 'pl'));
}

function suggestOccupationStatements(rows, options = {}) {
  const activityColumn = options.activityColumn || DEFAULT_ACTIVITY_COLUMN;
  const urlColumn = options.urlColumn || DEFAULT_URL_COLUMN;
  const qidColumn = options.qidColumn || DEFAULT_QID_COLUMN;
  const model = options.model || buildOccupationModel(options.seeds);
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  return rows.flatMap((row) => suggestOccupationsForActivity(row[activityColumn], { model, minConfidence }).map((suggestion) => ({
    item_qid: row[qidColumn] || '',
    name: row.name || row.biography_name || '',
    ipsb_url: row[urlColumn] || row.biography_url || '',
    activity: row[activityColumn] || '',
    ...suggestion,
    property: 'P106',
    reference_property: 'P854',
    reference_url: row[urlColumn] || row.biography_url || ''
  })));
}

function toQuickStatements(suggestions, retrievedDate = new Date()) {
  const date = retrievedDate.toISOString().slice(0, 10);
  const quickStatementsDate = `+${date}T00:00:00Z/11`;

  return suggestions
    .filter((suggestion) => suggestion.item_qid && suggestion.reference_url)
    .map((suggestion) => [
      suggestion.item_qid,
      'P106',
      suggestion.occupation_qid,
      'S854',
      `"${suggestion.reference_url.replace(/"/g, '%22')}"`,
      'S813',
      quickStatementsDate
    ].join('\t'))
    .join('\n');
}

function parseArgs(argv) {
  const args = {
    input: 'biography_data.csv',
    output: 'wikidata_occupation_suggestions.csv',
    format: 'csv',
    activityColumn: DEFAULT_ACTIVITY_COLUMN,
    urlColumn: DEFAULT_URL_COLUMN,
    qidColumn: DEFAULT_QID_COLUMN,
    minConfidence: DEFAULT_MIN_CONFIDENCE
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--input') {
      args.input = next;
      i += 1;
    } else if (arg === '--output') {
      args.output = next;
      i += 1;
    } else if (arg === '--format') {
      args.format = next;
      i += 1;
    } else if (arg === '--activity-column') {
      args.activityColumn = next;
      i += 1;
    } else if (arg === '--url-column') {
      args.urlColumn = next;
      i += 1;
    } else if (arg === '--qid-column') {
      args.qidColumn = next;
      i += 1;
    } else if (arg === '--min-confidence') {
      args.minConfidence = Number.parseFloat(next);
      i += 1;
    }
  }

  return args;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = parseCsv(await fs.readFile(options.input, 'utf8'));
  const suggestions = suggestOccupationStatements(rows, options);
  const output = options.format === 'quickstatements'
    ? toQuickStatements(suggestions)
    : toCsv(suggestions);

  await fs.writeFile(options.output, `${output}${output.endsWith('\n') || !output ? '' : '\n'}`, 'utf8');
  console.log(`Read ${rows.length} rows from ${options.input}`);
  console.log(`Wrote ${suggestions.length} occupation suggestions to ${options.output}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Wikidata occupation suggestion failed:', error.message);
    if (process.env.DEBUG === '1' && error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  });
}

module.exports = {
  OCCUPATION_SEEDS,
  buildOccupationModel,
  normalizeForMatching,
  splitActivities,
  suggestOccupationsForActivity,
  suggestOccupationStatements,
  toQuickStatements,
  parseArgs
};
