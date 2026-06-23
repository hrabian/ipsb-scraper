# IPSB Scraper

Node.js scraper for IPSB biography listings with incremental CSV checkpoints and resume support.

## Running

```bash
npm install
npm run scrape
```

By default the scraper writes `biography_data.csv` and a sidecar state file named `biography_data.csv.state.json`.

## Resume behavior

Resume is enabled by default. On startup the scraper:

1. loads existing records from the output CSV,
2. loads per-initial page state from the JSON sidecar,
3. writes an initial CSV checkpoint immediately,
4. continues listings from saved page HTML/last page where available,
5. writes CSV and JSON checkpoints as progress is made.

Set `RESUME=false` to ignore existing CSV/state files for a fresh run.

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OUTPUT` | `biography_data.csv` | CSV output path. |
| `STATE_PATH` | `${OUTPUT}.state.json` | JSON resume state path. |
| `INITIALS` | Polish initials list | Comma-separated initials, or `discover`. |
| `MAX_PAGES` | unset | Optional page limit for testing. |
| `FETCH_DETAILS` | `true` | Set to `false` to skip biography detail pages. |

## Wikidata occupation suggestions

Generate candidate Wikidata `occupation` (`P106`) statements from scraped IPSB rows by reading the CSV `activity` column and attaching the IPSB biography URL as a reference URL (`P854`):

```bash
npm run suggest:wikidata -- --input biography_data.csv --output wikidata_occupation_suggestions.csv
```

If the CSV contains a Wikidata item column, export QuickStatements instead:

```bash
npm run suggest:wikidata -- --input biography_data.csv --output wikidata_occupations.qs --format quickstatements --qid-column wikidata_qid
```

The suggester is a local, deterministic, seed-trained classifier. Review suggestions before importing them to Wikidata.

## Conflict checks

The test suite includes a pre-flight check that fails if tracked text files contain unresolved Git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`). Run it with:

```bash
npm test
```
