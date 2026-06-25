# IPSB Scraper

Node.js scraper for IPSB biography listings with incremental CSV checkpoints and resume support.
The CLI writes checkpoints in an append-only, low-memory mode and compacts the CSV after a successful run.

## Running

```bash
npm install
npm run scrape
```

By default the scraper writes `biography_data.csv` and a sidecar state file named `biography_data.csv.state.json`.
During a long run the CSV can temporarily contain older checkpoint rows for the same URL; after the run finishes it is compacted back to one latest row per biography.

## Resume behavior

Resume is enabled by default. On startup the scraper:

1. scans existing record keys from the output CSV without loading full biography texts into memory,
2. loads per-initial page state from the JSON sidecar,
3. continues listings from saved page HTML/last page where available,
4. appends CSV and JSON checkpoints as progress is made,
5. skips biography detail pages that are already present in the CSV,
6. compacts the CSV after a successful run.

Set `RESUME=false` to ignore existing CSV/state files for a fresh run.

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OUTPUT` | `biography_data.csv` | CSV output path. |
| `STATE_PATH` | `${OUTPUT}.state.json` | JSON resume state path. |
| `INITIALS` | Polish initials list | Comma-separated initials, or `discover`. |
| `MAX_PAGES` | unset | Optional page limit for testing. |
| `FETCH_DETAILS` | `true` | Set to `false` to skip biography detail pages. |
| `DETAIL_CONCURRENCY` | `3` | Number of biography detail pages fetched in parallel. |

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
