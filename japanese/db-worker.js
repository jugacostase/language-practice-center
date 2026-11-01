// SQLite (WASM) running in a dedicated worker, stored in the Origin Private File System
// through the "opfs-sahpool" VFS. That VFS needs no special HTTP headers, so the app
// works on any static host (GitHub Pages etc.) and on iOS Safari 16.4+.
import sqlite3InitModule from "./sqlite/sqlite3.mjs";

const DB_NAME = "/kanji-srs.sqlite3";
const SNAP_PREFIX = "/snapshot-";       // rolling daily copies kept next to the main db
const SNAP_KEEP = 7;
const SCHEMA_VERSION = 2;

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
-- Study content added on top of the built-in N5 list (e.g. imported from WaniKani).
-- For an item the app already has, the row only adds extra accepted answers.
CREATE TABLE IF NOT EXISTS items (
  kind      TEXT NOT NULL,                  -- kanji | word
  item      TEXT NOT NULL,                  -- the kanji or word itself
  source    TEXT NOT NULL,                  -- wanikani
  sort      INTEGER NOT NULL DEFAULT 0,     -- order new cards are introduced in
  data_json TEXT NOT NULL,                  -- {meaning, on, kun, acceptM, acceptR, level} or {r, m, acceptM, acceptR, level}
  PRIMARY KEY (kind, item)
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
  run("INSERT OR IGNORE INTO meta(key, value) VALUES ('created_ms', ?)", [String(Date.now())]);
  setMeta("schema_version", SCHEMA_VERSION);
}

function isOurDb(bytes) {
  // Validate an imported file by opening it in memory and checking for our tables.
  let mem;
  try { mem = openMem(bytes); } catch (e) { return e.message; }
  try {
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
    items: q("SELECT kind, item, source, sort, data_json FROM items ORDER BY sort"),
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

const ITEM_COLS = ["kind", "item", "source", "sort", "data_json"];
function putItem(r) {
  run(`INSERT INTO items(${ITEM_COLS.join(",")}) VALUES (${ITEM_COLS.map(c => "$" + c).join(",")})
       ON CONFLICT(kind, item) DO UPDATE SET source=excluded.source, sort=excluded.sort, data_json=excluded.data_json`, bindOf(ITEM_COLS, r));
}

// Open a SQLite file in memory (read only use). Caller closes it.
function openMem(bytes) {
  const head = new TextDecoder().decode(bytes.subarray(0, 15));
  if (head !== "SQLite format 3") throw new Error("That file isn't a SQLite database.");
  const mem = new sqlite3.oo1.DB(":memory:");
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(mem.pointer, "main", p, bytes.length, bytes.length,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
  if (rc) { mem.close(); throw new Error("Couldn't read that database."); }
  return mem;
}

/* ---------- WaniKani app cache (local-cache.db) ----------
   Rows hold protocol-buffer blobs. Field numbers, as found in the file:
   assignment: 2 level, 3 subject_id, 4 subject_type, 5 available_at, 6 started_at, 7 srs_stage, 8 passed_at, 9 burned_at
   subject:    2 level, 5 characters, 6 reading{1 text, 2 primary, 3 type 1 on/2 kun/3 nanori}, 7 meaning{1 text, 3 type 1 primary/2 alt/3 whitelist/4 blacklist}
   review_stats: 2 subject_id, 5/6 meaning correct/incorrect, 9/10 reading correct/incorrect
   study_materials: 2 subject_id, 5 meaning synonym (repeated)
   user: 1 username, 2 level                                                          */
function pbFields(buf) {
  const out = []; let i = 0;
  const varint = () => { let r = 0, mul = 1, b; do { b = buf[i++]; r += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80); return r; };
  while (i < buf.length) {
    const key = varint(), f = Math.floor(key / 8), w = key & 7;
    if (w === 0) out.push([f, varint()]);
    else if (w === 2) { const n = varint(); out.push([f, buf.subarray(i, i + n)]); i += n; }
    else if (w === 1) i += 8; else if (w === 5) i += 4;
    else throw new Error("Unexpected data in the WaniKani file.");
  }
  return out;
}
const utf8 = new TextDecoder();
const pbObj = buf => { const o = {}; for (const [f, v] of pbFields(buf)) (o[f] ||= []).push(v); return o; };
const one = (o, f) => o[f] ? o[f][0] : undefined;
const str = v => v === undefined ? "" : utf8.decode(v);
const sec = v => v ? v * 1000 : null;

function readWaniKani(bytes) {
  const mem = openMem(bytes);
  try {
    const tables = mem.selectValues("SELECT name FROM sqlite_master WHERE type='table'");
    if (!["subjects", "assignments"].every(n => tables.includes(n))) throw new Error("That database isn't a WaniKani app cache (no subjects/assignments tables).");
    const rows = (sql) => mem.exec({ sql, rowMode: "array", returnValue: "resultRows" });
    let user = {};
    if (tables.includes("user")) { const r = rows("SELECT pb FROM user LIMIT 1")[0]; if (r) { const u = pbObj(r[0]); user = { username: str(one(u, 1)), level: one(u, 2) || 0 }; } }
    const stats = {};
    if (tables.includes("review_stats")) for (const [b] of rows("SELECT pb FROM review_stats")) {
      const o = pbObj(b); stats[one(o, 2)] = { mc: one(o, 5) || 0, mi: one(o, 6) || 0, rc: one(o, 9) || 0, ri: one(o, 10) || 0 };
    }
    const syn = {};
    if (tables.includes("study_materials")) for (const [b] of rows("SELECT pb FROM study_materials")) {
      const o = pbObj(b); const list = (o[5] || []).map(str).filter(Boolean); if (list.length) syn[one(o, 2)] = list;
    }
    const asg = {};
    for (const [b] of rows("SELECT pb FROM assignments")) {
      const o = pbObj(b);
      asg[one(o, 3)] = { stage: one(o, 7) || 0, availableMs: sec(one(o, 5)), startedMs: sec(one(o, 6)), passedMs: sec(one(o, 8)), burnedMs: sec(one(o, 9)) };
    }
    const items = []; let radicals = 0;
    for (const [id, type, level, b] of rows("SELECT id, type, level, pb FROM subjects WHERE id IN (SELECT subject_id FROM assignments) ORDER BY level, id")) {
      if (type === 1) { radicals++; continue; }
      if (type !== 2 && type !== 3) continue;
      const o = pbObj(b);
      const ch = str(one(o, 5)); if (!ch) continue;
      const meanings = (o[7] || []).map(pbObj).map(m => ({ text: str(one(m, 1)), type: one(m, 3) || 0 })).filter(m => m.text);
      const readings = (o[6] || []).map(pbObj).map(r => ({ text: str(one(r, 1)), primary: !!one(r, 2), type: one(r, 3) || 0 })).filter(r => r.text);
      items.push({ sid: id, kind: type === 2 ? "kanji" : "word", ch, level, meanings, readings, synonyms: syn[id] || [], stats: stats[id] || null, ...asg[id] });
    }
    return { user, items, radicals };
  } finally { mem.close(); }
}

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
  readWaniKani({ bytes }) { return readWaniKani(bytes); },
  // Add imported study content and cards in one go, after a pre-import snapshot.
  importItems({ items, cards, meta }) {
    try { pool.importDb(`${SNAP_PREFIX}pre-import-${Date.now()}.sqlite3`, exportBytes()); prune(/pre-import-/, 2); } catch (e) {}
    db.transaction(() => {
      items.forEach(putItem); cards.forEach(putCard);
      for (const [k, v] of Object.entries(meta || {})) setMeta(k, v);
    });
    return loadAll();
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
