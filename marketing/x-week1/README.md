# X Week 1 — Aegis OS launch calendar

7 days × 3 posts = 21 posts, scheduled in **CET** (Europe/Amsterdam).
Primary product: **Aegis OS**. Heurion 2.0 appears as the first-party reference app.

## Files

| File | Purpose |
|---|---|
| `calendar-x-week1.csv` | Master calendar: 21 rows, full copy, link, image, notes |
| `buffer-x-week1.csv` | Buffer bulk-upload format: `Text, Image URL, Tags, Posting Time` (19 rows) |
| `typefully-x-week1.csv` | Typefully bulk format: `content, scheduled_date, threadify` (21 rows) |
| `build_csv.py` | Regenerates all three CSVs from the source data |

The seven visual cards are in `apps/site/x-week1-day*.png` and are publicly served at:

```text
https://heurion.org/site/x-week1-day1.png
...
https://heurion.org/site/x-week1-day7.png
```

Regenerate them with:

```bash
python3 scripts/generate_og_cards.py
```

## Buffer

1. Open the target X channel in Buffer.
2. Channel settings (gear icon) → **Bulk Upload**.
3. Upload `buffer-x-week1.csv`.
4. Check the preview for every row before confirming.

Buffer's bulk upload supports **text + one image** only. Therefore:

- The **Day 1 poll** and **Day 5 thread** are intentionally excluded. Schedule them manually in X/Buffer's composer.
- Link posts leave `Image URL` empty so X can generate the link card from the page's OG tags.
- Visual posts use the public `/site/x-week1-day*.png` URLs.
- `Posting Time` must stay in `YYYY-MM-DD HH:mm`. If Excel rewrites it, import the original CSV instead of re-saving from Excel.
- Buffer uses the connected channel's timezone. The times above are CET; confirm the channel timezone before importing.

## Typefully

`typefully-x-week1.csv` uses the shape used by the community Typefully CLI/SDK bulk importer:

```csv
content,scheduled_date,threadify
```

- `threadify=true` is set for the Day 5 thread; the four tweets are separated by blank lines.
- The official Typefully web app does not expose a stable CSV import button. If you use the web composer, copy rows from `calendar-x-week1.csv`.
- Attach `x-week1-day5.png` to the first tweet of the thread manually.
- The Day 1 poll should be created with X's native poll UI; the CSV contains the question and options as plain text.

## Posting notes

- Best slots: `08:00` CET (Europe morning / China afternoon), `14:00` CET (China evening / US morning), `20:00` CET (US afternoon / Europe evening).
- Keep at most one or two main posts per day with an external link; put secondary links in the first reply.
- Do not attach an image to a link post; let X pull the OG card.
- Reply to comments within the first hour. Quote one relevant conversation per day.
- All 21 posts are under X's 280 weighted-character limit; the longest is 265.
- Optional UTM suffix for tracking: `?utm_source=x&utm_medium=social&utm_campaign=aegis_week1`.
