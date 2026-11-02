# Kanji SRS (offline PWA, SQLite on device)

Static site, served from `/japanese/` on GitHub Pages: https://jugacostase.github.io/language-practice-center/japanese/ . There is no build step.

```
index.html            the app
db-worker.js          SQLite in a Web Worker, stored in OPFS via the "opfs-sahpool" VFS
sqlite/               official SQLite WASM build (3.54.1, from @sqlite.org/sqlite-wasm)
sw.js                 service worker: caches the app for offline use
manifest.webmanifest  install metadata + icons/
```

## Hosting

It must be served over HTTPS (service workers and OPFS need a secure context). Any static
host works because the sahpool VFS needs no COOP/COEP headers. GitHub Pages: push this folder
to a repo, then Settings → Pages → deploy from branch.

When you change any file, bump `VERSION` in `sw.js`, or phones keep serving the cached copy.

Local test: `python -m http.server 8000` in this folder, then open http://localhost:8000.

## Install on iPhone

Open the URL in Safari → Share → Add to Home Screen. Open it once while online so it caches;
after that it runs offline. Only one tab/window can own the database at a time.

## Backups

* Daily snapshots: kept automatically inside the app storage (last 7 study days). They undo
  mistakes but die with the device/browser data.
* Reminder banner (default every 3 days): "Back up now" opens the share sheet on a phone
  (Save to Files → iCloud Drive) or downloads the file on a computer. Browsers don't let a web
  app write files on iOS without a tap, so this is as automatic as iOS allows.
* Chrome/Edge on a computer: Settings → Automatic backup file. The chosen file is overwritten
  ~20 s after you study, with no prompts (the browser asks again for permission after a restart).
* Restore: Settings → Restore from a file… accepts a `.sqlite3` backup or the old JSON export.

## Import from WaniKani

Settings → Import from WaniKani reads the WaniKani app's `local-cache.db` on the device (the
file never leaves it). Kanji and vocabulary with an assignment are written to the `items`
table and show up next to the built-in N5 list; radicals and kana-only words are skipped.
For items the app already has, WaniKani's extra meanings, alternate readings and your
synonyms become accepted answers.

Each item's SRS stage becomes an SM-2 review card:

| WaniKani stage | interval | due |
|---|---|---|
| Lesson (not started) | stays a new card | |
| Apprentice 1–3 | 1 d | WaniKani's next review time |
| Apprentice 4 | 2 d | 〃 |
| Guru 1 / Guru 2 | 7 d / 14 d | 〃 |
| Master | 30 d | 〃 |
| Enlightened | 120 d | 〃 |
| Burned | 365 d | burned date + 365 d |

Ease is 250% at 95%+ WaniKani accuracy, minus 2 points per point below 95 (floor 130%);
lapses = wrong answers, reps = answers. Reviews that would already be overdue are spread over a
chosen number of days (default 30), lowest stage and accuracy first. Cards already studied in
this app keep their own progress, so re-importing is safe. The cache only has per-item totals,
not a review log, so nothing is added to `reviews`. A pre-import snapshot is taken first.

## Schema

```
cards(card_id PK, deck, item, state, step, due_ms, interval_days, ease, reps, lapses, last_review_ms)
reviews(review_id PK, ts_ms, study_day, card_id, deck, item, grade, typed, typed_correct,
        answers_json, answer_ms, state_before, interval_before, ease_before, due_before_ms,
        state_after, interval_after, ease_after, due_after_ms)
daily(study_day PK, date, reviews, new_kanji, new_words, new_recall)
items(kind, item, source, sort, data_json)  -- extra content, PK (kind, item)
settings(key PK, value JSON)      meta(key PK, value)
view reviews_readable             -- local datetimes, seconds per answer
```

Times are unix milliseconds. `study_day` counts days since 1970-01-01 with the day rolling
over at 4 a.m. local time. `grade` is 1 again / 2 hard / 3 good / 4 easy.

```python
import sqlite3, pandas as pd
con = sqlite3.connect("kanji-srs-2026-11-01.sqlite3")
rev = pd.read_sql("SELECT * FROM reviews", con)
rev["ts"] = pd.to_datetime(rev.ts_ms, unit="ms")
rev.groupby("deck").grade.apply(lambda g: (g > 1).mean())   # retention by deck
```
