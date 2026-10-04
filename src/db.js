import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR, UPLOAD_DIR } from './config.js';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'party.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS guests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,          -- lowercase, for dedupe + autocomplete
  token      TEXT UNIQUE,             -- filled at token generation
  token_used INTEGER NOT NULL DEFAULT 0,
  costume_id INTEGER REFERENCES costumes(id) ON DELETE SET NULL,
  onboarded  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS costumes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('single','couple','group')),
  -- Two resolutions: photo is a small preview served in every grid, so a
  -- 50-costume ballot stays light on venue wifi. photo_hd is fetched only
  -- when someone taps to look closely.
  photo      TEXT,
  photo_hd   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS votes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id   INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  costume_id INTEGER NOT NULL REFERENCES costumes(id) ON DELETE CASCADE,
  category   TEXT NOT NULL CHECK (category IN ('beautiful','scary','original')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (guest_id, category)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_guests_key  ON guests(name_key);
CREATE INDEX IF NOT EXISTS idx_votes_cat   ON votes(category);
`);

export const CATEGORIES = [
  { key: 'beautiful', label: 'Most Beautiful' },
  { key: 'scary', label: 'Most Scary' },
  { key: 'original', label: 'Most Original' },
];

export const KINDS = {
  single: { members: 1, label: 'Solo' },
  couple: { members: 2, label: 'Couple' },
  group: { members: 2, label: 'Group' }, // 2 or more; headcount isn't fixed
};

/**
 * The costume type follows from how many guests are in it — the host never
 * picks it. Kept here (not in the browser) so the rule can't drift.
 */
export function deriveKind(count) {
  if (count === 1) return 'single';
  if (count === 2) return 'couple';
  if (count > 2) return 'group';
  return null;
}

export const getSetting = (key) =>
  db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;

export const setSetting = (key, value) =>
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));

/* ---------------------------------------------------------------- tokens */

// Unambiguous alphabet: no 0/O, 1/I/L, U/V confusion.
const ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';

function randomToken(len = 8) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function newToken() {
  for (let i = 0; i < 50; i++) {
    const t = randomToken();
    if (!db.prepare('SELECT 1 FROM guests WHERE token = ?').get(t)) return t;
  }
  throw new Error('Could not allocate a unique token');
}

export function newPhotoName(ext = 'jpg') {
  return `${randomUUID()}.${ext}`;
}

/* ------------------------------------------------------------- accessors */

export const guestById = (id) => db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
export const guestByToken = (t) => db.prepare('SELECT * FROM guests WHERE token = ?').get(t);
export const costumeById = (id) => db.prepare('SELECT * FROM costumes WHERE id = ?').get(id);
export const allCostumes = () => db.prepare('SELECT * FROM costumes ORDER BY id').all();
export const allGuests = () =>
  db.prepare('SELECT * FROM guests ORDER BY name COLLATE NOCASE').all();

export function membersOf(costumeId) {
  if (costumeId == null) return [];
  return db
    .prepare('SELECT id, name FROM guests WHERE costume_id = ? ORDER BY name COLLATE NOCASE')
    .all(costumeId);
}

/** Costumes eligible for a given guest, with member names attached. */
export function ballotFor(guestId) {
  const guest = guestById(guestId);
  const votes = db
    .prepare('SELECT category, costume_id FROM votes WHERE guest_id = ?')
    .all(guestId);
  const voted = Object.fromEntries(votes.map((v) => [v.category, v.costume_id]));

  const costumes = allCostumes().map((c) => ({
    ...c,
    members: membersOf(c.id).map((m) => m.name),
    isOwn: c.id === guest.costume_id,
  }));

  const cast = (category) => votes.find((v) => v.category === category) || null;

  return {
    guest: { id: guest.id, name: guest.name, costume_id: guest.costume_id },
    costumes,
    // A costume is votable only if the guest is a member of it.
    votable: costumes.filter((c) => !c.isOwn && guest.costume_id != null),
    votes: { beautiful: cast('beautiful'), scary: cast('scary'), original: cast('original') },
  };
}

export function tally() {
  const rows = db
    .prepare(
      `SELECT category, costume_id, COUNT(*) AS n
         FROM votes GROUP BY category, costume_id`
    )
    .all();
  // Members must travel with each costume: both the admin console and the
  // public board render "who is this" straight from the tally.
  const costumes = allCostumes().map((c) => ({
    ...c,
    members: membersOf(c.id).map((m) => m.name),
  }));
  return {
    total_votes: db.prepare('SELECT COUNT(*) AS n FROM votes').get().n,
    turnout: db
      .prepare('SELECT COUNT(DISTINCT guest_id) AS n FROM votes')
      .get().n,
    categories: CATEGORIES.map((c) => {
      const scored = rows
        .filter((r) => r.category === c.key)
        .map((r) => ({
          costume: costumes.find((x) => x.id === r.costume_id) || null,
          votes: r.n,
        }))
        .filter((r) => r.costume)
        .sort((a, b) => b.votes - a.votes || a.costume.name.localeCompare(b.costume.name));
      return { ...c, results: scored };
    }),
  };
}

export function isVotingOpen() {
  const close = getSetting('voting_closes_at');
  if (!close) return { open: true, closesAt: null };
  const t = new Date(close).getTime();
  if (Number.isNaN(t)) return { open: true, closesAt: null };
  return { open: Date.now() < t, closesAt: new Date(t).toISOString() };
}
