// SQLite (WASM) running in a dedicated worker, stored in the Origin Private File System
// through the "opfs-sahpool" VFS. That VFS needs no special HTTP headers, so the app
// works on any static host (GitHub Pages etc.) and on iOS Safari 16.4+.
import sqlite3InitModule from "./sqlite/sqlite3.mjs";

const DB_NAME = "/kanji-srs.sqlite3";
const SNAP_PREFIX = "/snapshot-";       // rolling daily copies kept next to the main db
const SNAP_KEEP = 7;
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- Current scheduling state of every card that has been studied at least once.
CREATE TABLE IF NOT EXISTS cards (
  card_id        TEXT PRIMARY KEY,          -- 'k:日', 'w:毎日', 'r:日'
  deck           TEXT NOT NULL,             -- kanji | words | recall
  item           TEXT NOT NULL,             -- the kanji or word itself
  state          TEXT NOT NULL,             -- new | learn | review | relearn
  step           INTEGER NOT NULL DEFAULT 0,-- index into the learning/relearning steps
  due_ms         INTEGER,                   -- unix epoch milliseconds
  interval_days  INTEGER NOT NULL DEFAULT 0,
  ease           REAL NOT NULL DEFAULT 2.5,
  reps           INTEGER NOT NULL DEFAULT 0,
  lapses         INTEGER NOT NULL DEFAULT 0,
  last_review_ms INTEGER
);
-- One row per answer: the full review log.
CREATE TABLE IF NOT EXISTS reviews (
  review_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms            INTEGER NOT NULL,        -- when the grade was given (unix ms)
  study_day        INTEGER NOT NULL,        -- day number, new day starts 4 a.m. local
  card_id          TEXT NOT NULL,
  deck             TEXT NOT NULL,
  item             TEXT NOT NULL,
  grade            INTEGER NOT NULL,        -- 1 again, 2 hard, 3 good, 4 easy
  typed            INTEGER NOT NULL DEFAULT 0, -- 1 if answered by typing
  typed_correct    INTEGER,                 -- 1/0 for typed answers, NULL otherwise
  answers_json     TEXT,                    -- what was typed, per question
  answer_ms        INTEGER,                 -- time from card shown to grade
  state_before     TEXT, interval_before INTEGER, ease_before REAL, due_before_ms INTEGER,
  state_after      TEXT, interval_after  INTEGER, ease_after  REAL, due_after_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS reviews_card ON reviews(card_id);
CREATE INDEX IF NOT EXISTS reviews_day  ON reviews(study_day);
-- Per-day counters (drive the daily new-card limit and the streak).
CREATE TABLE IF NOT EXISTS daily (
  study_day  INTEGER PRIMARY KEY,
  date       TEXT NOT NULL,                 -- local calendar date of that study day
  reviews    INTEGER NOT NULL DEFAULT 0,
  new_kanji  INTEGER NOT NULL DEFAULT 0,
  new_words  INTEGER NOT NULL DEFAULT 0,
  new_recall INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                       -- JSON
);
CREATE VIEW IF NOT EXISTS reviews_readable AS
  SELECT review_id, datetime(ts_ms / 1000, 'unixepoch', 'localtime') AS reviewed_at,
         deck, item, grade, typed, typed_correct, answer_ms / 1000.0 AS answer_seconds,
         state_before, interval_before, state_after, interval_after, ease_after,
         datetime(due_after_ms / 1000, 'unixepoch', 'localtime') AS next_due
  FROM reviews;
`;

let sqlite3, pool, db;

function q(sql, bind) { return db.exec({ sql, bind, rowMode: "object", returnValue: "resultRows" }); }
function run(sql, bind) { db.exec({ sql, bind }); }

function openDb() {
  db = new pool.OpfsSAHPoolDb(DB_NAME);
  run("PRAGMA foreign_keys = ON;");
  run(SCHEMA);
  run("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?), ('created_ms', ?)", [String(SCHEMA_VERSION), String(Date.now())]);
}

function isOurDb(bytes) {
  // Validate an imported file by opening it in memory and checking for our tables.
  const head = new TextDecoder().decode(bytes.subarray(0, 15));
  if (head !== "SQLite format 3") return "That file isn't a SQLite database.";
  const mem = new sqlite3.oo1.DB(":memory:");
  try {
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    const rc = sqlite3.capi.sqlite3_deserialize(mem.pointer, "main", p, bytes.length, bytes.length,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
    if (rc) return "Couldn't read that database.";
    const names = mem.selectValues("SELECT name FROM sqlite_master WHERE type='table'");
    if (!["cards", "reviews", "settings"].every(n => names.includes(n))) return "That database isn't a Kanji SRS backup.";
    return null;
  } finally { mem.close(); }
}

function loadAll() {
  const settings = {};
  for (const r of q("SELECT key, value FROM settings")) { try { settings[r.key] = JSON.parse(r.value); } catch (e) {} }
  return {
    cards: q("SELECT * FROM cards"),
    daily: q("SELECT * FROM daily"),
    settings,
    meta: Object.fromEntries(q("SELECT key, value FROM meta").map(r => [r.key, r.value])),
    reviewCount: db.selectValue("SELECT count(*) FROM reviews"),
  };
}

const CARD_COLS = ["card_id", "deck", "item", "state", "step", "due_ms", "interval_days", "ease", "reps", "lapses", "last_review_ms"];
const REVIEW_COLS = ["ts_ms", "study_day", "card_id", "deck", "item", "grade", "typed", "typed_correct", "answers_json", "answer_ms",
  "state_before", "interval_before", "ease_before", "due_before_ms", "state_after", "interval_after", "ease_after", "due_after_ms"];
const DAILY_COLS = ["study_day", "date", "reviews", "new_kanji", "new_words", "new_recall"];
const upsertSql = (table, cols, key) =>
  `INSERT INTO ${table}(${cols.join(",")}) VALUES (${cols.map(c => "$" + c).join(",")})
   ON CONFLICT(${key}) DO UPDATE SET ${cols.filter(c => c !== key).map(c => `${c}=excluded.${c}`).join(",")}`;
const bindOf = (cols, row) => Object.fromEntries(cols.map(c => ["$" + c, row[c] ?? null]));

function putCard(c) { run(upsertSql("cards", CARD_COLS, "card_id"), bindOf(CARD_COLS, c)); }
function putDaily(d) { run(upsertSql("daily", DAILY_COLS, "study_day"), bindOf(DAILY_COLS, d)); }
function putSettings(s) { for (const [k, v] of Object.entries(s)) run("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, JSON.stringify(v)]); }
function setMeta(k, v) { run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, String(v)]); }

function exportBytes() { return sqlite3.capi.sqlite3_js_db_export(db); }

function snapshots() {
  return pool.getFileNames().filter(n => n.startsWith(SNAP_PREFIX)).sort();
}
// Keep one copy per day for the last SNAP_KEEP days. Guards against a bad import or a
// bug; it lives in the same browser storage, so it is NOT a backup against losing the device.
function dailySnapshot(day) {
  const name = `${SNAP_PREFIX}${day}.sqlite3`;
  if (pool.getFileNames().includes(name)) return;
  pool.importDb(name, exportBytes());
  prune(/^\/snapshot-\d+\.sqlite3$/, SNAP_KEEP);
}
function prune(re, keep) {
  const all = snapshots().filter(n => re.test(n));
  for (const old of all.slice(0, Math.max(0, all.length - keep))) pool.unlink(old);
}

async function replaceWith(bytes) {
  db.close();
  try { await pool.importDb(DB_NAME, bytes); }
  finally { openDb(); }
}

const ops = {
  async init() {
    sqlite3 = await sqlite3InitModule();
    // A page that was just reloaded or updated can still hold the file handles for a
    // moment while its old worker shuts down, so retry for a few seconds.
    for (let attempt = 1; ; attempt++) {
      try {
        pool = await sqlite3.installOpfsSAHPoolVfs({ name: "kanji-srs-pool", initialCapacity: 16, forceReinitIfPreviouslyFailed: true });
        break;
      } catch (e) {
        if (attempt >= 12) throw e;
        await new Promise(r => setTimeout(r, 250 * attempt));
      }
    }
    await pool.reserveMinimumCapacity(16);
    openDb();
    return { sqliteVersion: sqlite3.version.libVersion, ...loadAll() };
  },
  load: () => loadAll(),
  // One answer: card state + review log row + day counters, atomically.
  review({ card, review, daily }) {
    dailySnapshot(daily.study_day); // start-of-day copy, taken before the day's first answer is written
    db.transaction(() => {
      putCard(card);
      run(`INSERT INTO reviews(${REVIEW_COLS.join(",")}) VALUES (${REVIEW_COLS.map(c => "$" + c).join(",")})`, bindOf(REVIEW_COLS, review));
      putDaily(daily);
    });
  },
  undoReview({ cardId, prevCard, ts, daily }) {
    db.transaction(() => {
      if (prevCard) putCard(prevCard); else run("DELETE FROM cards WHERE card_id = ?", [cardId]);
      run("DELETE FROM reviews WHERE card_id = ? AND ts_ms = ?", [cardId, ts]);
      putDaily(daily);
    });
  },
  settings(s) { putSettings(s); },
  daily(d) { putDaily(d); },
  meta({ key, value }) { setMeta(key, value); },
  // Replace cards/daily/settings with a whole state (JSON import, migration, reset).
  replaceState({ cards, daily, settings, clearReviews }) {
    db.transaction(() => {
      run("DELETE FROM cards"); run("DELETE FROM daily");
      if (clearReviews) run("DELETE FROM reviews");
      cards.forEach(putCard); daily.forEach(putDaily); putSettings(settings);
    });
  },
  exportDb() { const bytes = exportBytes(); return { bytes, transfer: [bytes.buffer] }; },
  async importDb({ bytes }) {
    const err = isOurDb(bytes); if (err) throw new Error(err);
    try { pool.importDb(`${SNAP_PREFIX}pre-import-${Date.now()}.sqlite3`, exportBytes()); prune(/pre-import-/, 2); } catch (e) {}
    await replaceWith(bytes);
    return loadAll();
  },
  listSnapshots() { return snapshots().map(n => n.slice(SNAP_PREFIX.length).replace(".sqlite3", "")); },
  async restoreSnapshot({ id }) {
    const bytes = pool.exportFile(`${SNAP_PREFIX}${id}.sqlite3`);
    await replaceWith(bytes);
    return loadAll();
  },
};

onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    const out = await ops[op](args);
    if (out && out.transfer) postMessage({ id, ok: true, result: out.bytes }, out.transfer);
    else postMessage({ id, ok: true, result: out });
  } catch (err) {
    postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
