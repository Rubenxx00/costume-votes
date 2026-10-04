import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { UPLOAD_DIR, PHOTO_SIZES, PHOTO_MAX_UPLOAD_BYTES } from '../config.js';
import { requireAdminApi, checkPassword, issueSession, clearSession } from '../auth.js';
import {
  db, newToken, newPhotoName, CATEGORIES, KINDS, deriveKind,
  getSetting, setSetting, isVotingOpen,
  allCostumes, allGuests, membersOf, guestById, costumeById, tally,
} from '../db.js';

export const router = express.Router();

/* ------------------------------------------------------------------ auth */

router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || !checkPassword(password)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  issueSession(res);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

router.use(requireAdminApi);

/* -------------------------------------------------------------- overview */

router.get('/overview', (req, res) => {
  const votesByGuest = new Map(
    db.prepare('SELECT guest_id, COUNT(*) AS n FROM votes GROUP BY guest_id').all()
      .map((r) => [r.guest_id, r.n])
  );
  const guests = allGuests().map((g) => ({ ...g, votes: votesByGuest.get(g.id) || 0 }));
  const costumes = allCostumes().map((c) => ({ ...c, members: membersOf(c.id) }));
  res.json({
    guests,
    costumes,
    event_name: getSetting('event_name') || 'Costume Party',
    categories: CATEGORIES,
    kinds: Object.entries(KINDS).map(([key, v]) => ({ key, ...v })),
    voting: isVotingOpen(),
    stats: {
      guests: guests.length,
      onboarded: guests.filter((g) => g.onboarded).length,
      costumes: costumes.length,
      tokens: guests.filter((g) => g.token).length,
      voted: db.prepare('SELECT COUNT(DISTINCT guest_id) AS n FROM votes').get().n,
    },
  });
});

/* ------------------------------------------------------ guest name import */

/**
 * Accepts either a multipart-free JSON body {csv} or a raw text/csv body.
 * Tolerates: BOM, CRLF, quoted names, a "name" header row, a trailing
 * email/surname column, blank lines and duplicates.
 */
router.post('/guests/import', express.text({ type: ['text/csv', 'text/plain'], limit: '256kb' }),
  (req, res) => {
    let raw = typeof req.body === 'string' ? req.body : req.body?.csv || '';
    raw = raw.replace(/^\uFEFF/, '');

    const names = [];
    const skipped = [];
    const seen = new Set();

    for (const line of raw.split(/\r?\n/)) {
      const first = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)[0]; // first CSV field
      const name = first.replace(/^"|"$/g, '').replace(/\s+/g, ' ').trim();
      if (!name) continue;
      if (/^(name|nombre|full ?name|guest|ospite)$/i.test(name)) continue; // header row
      const key = name.toLowerCase();
      if (seen.has(key)) { skipped.push({ name, reason: 'duplicate' }); continue; }
      seen.add(key);
      names.push({ name, name_key: key });
    }

    if (!names.length) return res.status(400).json({ error: 'No usable names found' });

    const insert = db.prepare(
      'INSERT OR IGNORE INTO guests (name, name_key) VALUES (?, ?)'
    );
    const existing = new Set(allGuests().map((g) => g.name_key));
    const added = [];
    for (const g of names) {
      if (existing.has(g.name_key)) { skipped.push({ name: g.name, reason: 'already in list' }); continue; }
      insert.run(g.name, g.name_key);
      added.push(g.name);
    }

    res.json({ added, skipped, total: allGuests().length });
  }
);

/** Free-text autocomplete for the onboarding form. */
router.get('/guests/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const sql = `
    SELECT id, name, costume_id, onboarded FROM guests
    WHERE (? = '' OR name_key LIKE ?)
    ORDER BY (costume_id IS NULL) DESC, name COLLATE NOCASE
    LIMIT 12`;
  res.json({ guests: db.prepare(sql).all(q, `%${q}%`) });
});

router.get('/guests', (req, res) => res.json({ guests: allGuests() }));

router.post('/guests/:id/delete', (req, res) => {
  db.prepare('DELETE FROM guests WHERE id = ?').run(req.params.id);
  res.json({ ok: true, guests: allGuests() });
});

/* --------------------------------------------------- costumes + onboarding */

/**
 * Onboard one or more guests as a single costume.
 * body: { name, guest_ids: [], photo: dataURL|null, photo_hd: dataURL|null }
 *
 * The type is derived from the headcount — 1 guest is a solo, 2 a couple, 3+ a
 * group. A client-supplied `kind` is ignored on purpose: the host never chooses
 * it, and letting it through would let a 3-person "solo" exist in the database.
 */
router.post('/costumes', async (req, res) => {
  const { name, guest_ids = [], photo = null } = req.body || {};
  const ids = [...new Set(guest_ids.map(Number).filter(Number.isInteger))];

  const kind = deriveKind(ids.length);
  if (!kind)
    return res.status(400).json({ error: 'Pick at least one guest to onboard' });

  // Every id must be a real guest; a typo would otherwise create a costume
  // with fewer members than the headcount implies.
  const found = ids.length
    ? db.prepare(`SELECT id FROM guests WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : [];
  if (found.length !== ids.length)
    return res.status(400).json({ error: 'One or more guests no longer exist' });

  const finalName = String(name || '').trim() ||
    (kind === 'single'
      ? db.prepare('SELECT name FROM guests WHERE id = ?').get(ids[0])?.name
      : ids.map((id) => db.prepare('SELECT name FROM guests WHERE id = ?').get(id)?.name)
          .filter(Boolean).join(' & '));
  if (!finalName) return res.status(400).json({ error: 'Costume needs a name' });

  // One upload in, both resolutions out. A costume either has the pair or
  // neither — a preview-less costume would render blank in every grid.
  let pair = null;
  if (photo) {
    const source = dataUrlToBuffer(photo);
    if (!source) return res.status(400).json({ error: 'Photo must be a base64 image data URL' });
    try {
      pair = await writePhotoPair(source);
    } catch (e) {
      return res.status(e.status || 400).json({ error: `Photo rejected: ${e.message}` });
    }
  }
  const photoPath = pair?.preview ?? null;
  const photoHdPath = pair?.hd ?? null;

  const tx = async () => {
    const info = db.prepare(
      'INSERT INTO costumes (name, kind, photo, photo_hd) VALUES (?, ?, ?, ?)'
    ).run(finalName, kind, photoPath, photoHdPath);
    const costumeId = Number(info.lastInsertRowid);
    // Moving a guest means they leave whatever costume they were in.
    const claim = db.prepare('UPDATE guests SET costume_id = ?, onboarded = 1 WHERE id = ?');
    for (const id of ids) claim.run(costumeId, id);
    // Any costume left with fewer members than its kind allows is dropped,
    // so the ballot never shows an empty solo/couple entry.
    const stale = db.prepare(
      `SELECT id, kind, photo, photo_hd FROM costumes
        WHERE id != ?
          AND (SELECT COUNT(*) FROM guests WHERE costume_id = costumes.id)
              < CASE kind WHEN 'single' THEN 1 ELSE 2 END`
    ).all(costumeId);
    for (const row of stale) {
      db.prepare('DELETE FROM votes WHERE costume_id = ?').run(row.id);
      db.prepare('DELETE FROM costumes WHERE id = ?').run(row.id);
      removePhoto(row.photo);
      removePhoto(row.photo_hd);
    }
    return costumeId;
  };

  let costumeId;
  try {
    costumeId = await tx();
  } catch (e) {
    // The rows are gone, so the files we just wrote are orphaned.
    if (pair) { removePhoto(pair.preview); removePhoto(pair.hd); }
    return res.status(400).json({ error: `Could not save costume: ${e.message}` });
  }
  res.json({ ok: true, costume: { ...costumeById(costumeId), members: membersOf(costumeId) } });
});

router.get('/costumes', (req, res) =>
  res.json({ costumes: allCostumes().map((c) => ({ ...c, members: membersOf(c.id) })) })
);

/** Correct a mistake at the party: unhook guests and/or delete a costume. */
router.post('/costumes/:id/update', async (req, res) => {
  const id = Number(req.params.id);
  if (!costumeById(id)) return res.status(404).json({ error: 'No such costume' });
  const { name, photo, detach } = req.body || {};

  // Pull members out of the costume (used by the admin "Detach" button).
  if (Array.isArray(detach) && detach.length) {
    const stmt = db.prepare(
      `UPDATE guests SET costume_id = NULL, onboarded = 0
        WHERE id = ? AND costume_id = ?`
    );
    for (const gid of detach) stmt.run(Number(gid), id);
  }

  // `null` clears the photo, a data URL replaces it, absent leaves it alone.
  // Replacing rewrites both resolutions from the new original, so the pair can
  // never drift out of sync — and the old files go only after the swap sticks.
  const current = costumeById(id);
  if (photo !== undefined && photo !== null) {
    const source = dataUrlToBuffer(photo);
    if (!source) return res.status(400).json({ error: 'Photo must be a base64 image data URL' });
    let pair;
    try {
      pair = await writePhotoPair(source);
    } catch (e) {
      return res.status(e.status || 400).json({ error: `Photo rejected: ${e.message}` });
    }
    db.prepare('UPDATE costumes SET photo = ?, photo_hd = ? WHERE id = ?')
      .run(pair.preview, pair.hd, id);
    removePhoto(current.photo);
    removePhoto(current.photo_hd);
  } else if (photo === null) {
    db.prepare('UPDATE costumes SET photo = NULL, photo_hd = NULL WHERE id = ?').run(id);
    removePhoto(current.photo);
    removePhoto(current.photo_hd);
  }
  db.prepare('UPDATE costumes SET name = COALESCE(NULLIF(?, \'\'), name) WHERE id = ?')
    .run(String(name || '').trim(), id);
  res.json({ ok: true, costume: costumeById(id) });
});

router.post('/costumes/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const costume = costumeById(id);
  if (!costume) return res.status(404).json({ error: 'No such costume' });
  db.prepare('UPDATE guests SET costume_id = NULL, onboarded = 0 WHERE costume_id = ?').run(id);
  db.prepare('DELETE FROM costumes WHERE id = ?').run(id);
  db.prepare('DELETE FROM votes WHERE costume_id = ?').run(id);
  // Both resolutions, or the uploads directory grows forever.
  removePhoto(costume.photo);
  removePhoto(costume.photo_hd);
  res.json({ ok: true });
});

/* ----------------------------------------------------------------- tokens */

router.post('/tokens/generate', (req, res) => {
  const { regenerate = false } = req.body || {};
  const guests = allGuests().filter((g) => regenerate || !g.token);
  if (!guests.length) return res.json({ issued: 0, message: 'Every guest already has a token' });

  const upd = db.prepare('UPDATE guests SET token = ? WHERE id = ?');
  for (const g of guests) upd.run(newToken(), g.id);
  res.json({ issued: guests.length });
});

router.get('/tokens.csv', (req, res) => {
  const rows = allGuests();
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const csv = ['token,name,costume,status']
    .concat(
      rows.map((g) => {
        const c = g.costume_id ? costumeById(g.costume_id) : null;
        const voted = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE guest_id = ?').get(g.id).n;
        const status = !g.onboarded ? 'not onboarded' : voted === 3 ? 'voted' : voted ? `partial (${voted}/3)` : 'not voted';
        return [g.token || '', g.name, c ? c.name : '', status].map(esc).join(',');
      })
    )
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="costume-vote-tokens.csv"');
  res.send(csv + '\n');
});

/* --------------------------------------------------------------- voting */

router.post('/settings', (req, res) => {
  const { closes_at, event_name } = req.body || {};
  if (closes_at !== undefined) {
    if (closes_at === null || closes_at === '') setSetting('voting_closes_at', '');
    else {
      const d = new Date(closes_at);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Bad close time' });
      setSetting('voting_closes_at', d.toISOString());
    }
  }
  if (event_name !== undefined) setSetting('event_name', String(event_name).trim());
  res.json({ ok: true, voting: isVotingOpen(), event_name: getSetting('event_name') });
});

router.get('/results', (req, res) => res.json({ ...tally(), voting: isVotingOpen() }));

router.post('/votes/reset', (req, res) => {
  db.prepare('DELETE FROM votes').run();
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- photos */

/** Deletes an uploaded file, tolerating a path that's already gone. */
function removePhoto(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  fs.rmSync(path.join(UPLOAD_DIR, path.basename(url)), { force: true });
}

/**
 * Decodes one upload into the preview and HD pair, writing both to disk.
 *
 * sharp does the resizing, so the browser uploads the camera original untouched
 * — no base64 round-trip, no client-side canvas code, and HEIC from an iPhone
 * converts to something every browser can actually display.
 *
 * Returns { preview, hd } as /uploads/ URLs.
 */
async function writePhotoPair(source) {
  const buf = Buffer.isBuffer(source) ? source : Buffer.from(source);
  if (!buf.length) throw Object.assign(new Error('empty image'), { status: 400 });
  if (buf.length > PHOTO_MAX_UPLOAD_BYTES)
    throw Object.assign(
      new Error(`photo is larger than ${Math.round(PHOTO_MAX_UPLOAD_BYTES / 1048576)} MB`),
      { status: 400 });

  // Metadata first: it validates the bytes and tells us the true dimensions.
  let meta;
  try {
    meta = await sharp(buf, { limitInputPixels: 268402689 }).metadata();
  } catch {
    throw Object.assign(new Error('that file is not a readable image'), { status: 400 });
  }
  if (!meta.width || !meta.height)
    throw Object.assign(new Error('that file is not a readable image'), { status: 400 });

  // Animated formats would balloon as JPEG; keep only the first frame.
  const still = { animated: false };

  const render = async ({ max, quality }) => {
    const name = newPhotoName('jpg');
    await sharp(buf, { ...still, limitInputPixels: 268402689 })
      .rotate()                                   // honour EXIF orientation
      .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, progressive: true, mozjpeg: true })
      .toFile(path.join(UPLOAD_DIR, name));
    return `/uploads/${name}`;
  };

  const [preview, hd] = await Promise.all([
    render(PHOTO_SIZES.preview),
    render(PHOTO_SIZES.hd),
  ]);
  return { preview, hd };
}

/** Reads a data URL back to bytes (kept for API clients and tests). */
function dataUrlToBuffer(dataUrl) {
  const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl));
  if (!m) return null;
  return Buffer.from(m[1], 'base64');
}