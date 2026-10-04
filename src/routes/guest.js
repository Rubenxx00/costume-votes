import express from 'express';
import {
  db, CATEGORIES, guestByToken, costumeById, getSetting,
  membersOf, ballotFor, isVotingOpen,
} from '../db.js';

export const router = express.Router();

const VALID_CATEGORIES = new Set(CATEGORIES.map((c) => c.key));

/** Look up the guest behind a token; 404s (rather than leaking which) on bad tokens. */
function guestFromToken(req, res) {
  // Accept what the guest actually types/reads off the card:
  // "k7f2-9qx4", " k7f29qx4 ", "K7F2 9QX4" all resolve to the same guest.
  const token = String((req.body?.token ?? req.query.token) || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const guest = token ? guestByToken(token) : null;
  if (!guest) {
    res.status(404).json({ error: 'Unknown token — check the code on your card' });
    return null;
  }
  return guest;
}

/** Everything the ballot screen needs: who am I, what can I vote for, what did I pick. */
router.get('/me', (req, res) => {
  const guest = guestFromToken(req, res);
  if (!guest) return;
  const state = isVotingOpen();
  const voted = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE guest_id = ?').get(guest.id).n;
  db.prepare('UPDATE guests SET token_used = 1 WHERE id = ?').run(guest.id);
  res.json({
    ...ballotFor(guest.id),
    event_name: getSetting('event_name') || 'Costume Party',
    categories: CATEGORIES,
    voting: state,
    votes_cast: voted,
    remaining: 3 - voted,
  });
});

/**
 * Cast or change one vote. A guest may hold one vote per category, may never
 * vote for a costume they belong to, and only while voting is open.
 */
router.post('/vote', (req, res) => {
  const { category, costume_id } = req.body || {};
  if (!VALID_CATEGORIES.has(category))
    return res.status(400).json({ error: 'Unknown category' });

  const state = isVotingOpen();
  if (!state.open)
    return res.status(403).json({ error: 'Voting is closed', closesAt: state.closesAt });

  const guest = guestFromToken(req, res);
  if (!guest) return;

  if (guest.costume_id == null)
    return res.status(409).json({ error: 'You have not been registered for a costume yet' });

  // Clearing a vote: no costume is needed, so this runs before costume checks.
  const undo = String(req.body?.undo || '') === '1';
  if (undo) {
    db.prepare('DELETE FROM votes WHERE guest_id = ? AND category = ?').run(guest.id, category);
    const n = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE guest_id = ?').get(guest.id).n;
    return res.json({ ok: true, votes_cast: n, remaining: 3 - n, ballot: ballotFor(guest.id) });
  }

  const costume = costumeById(Number(costume_id));
  if (!costume) return res.status(404).json({ error: 'Unknown costume' });

  if (costume.id === guest.costume_id)
    return res.status(403).json({ error: 'You cannot vote for your own costume' });

  // Membership is authoritative — re-check every member, not just the owner,
  // so late edits to a couple/group can't be voted on by a member.
  if (membersOf(costume.id).some((m) => m.id === guest.id))
    return res.status(403).json({ error: 'You cannot vote for your own costume' });

  db.prepare(
    `INSERT INTO votes (guest_id, costume_id, category) VALUES (?, ?, ?)
     ON CONFLICT (guest_id, category) DO UPDATE SET costume_id = excluded.costume_id, created_at = datetime('now')`
  ).run(guest.id, costume.id, category);

  const votes = db
    .prepare('SELECT COUNT(*) AS n FROM votes WHERE guest_id = ?')
    .get(guest.id).n;
  res.json({ ok: true, votes_cast: votes, remaining: 3 - votes, ballot: ballotFor(guest.id) });
});

/** Lightweight poll so the ballot page can grey out when the timer hits. */
router.get('/status', (req, res) =>
  res.json({
    voting: isVotingOpen(),
    event_name: getSetting('event_name') || 'Costume Party',
  }));

/** Public results board (shown on the projector after voting closes). */
router.get('/results', (req, res) => {
  const state = isVotingOpen();
  if (state.open && !req.query.reveal) {
    return res.status(403).json({ error: 'Results are hidden until voting closes' });
  }
  const costumes = new Map(
    costumesList().map((c) => [c.id, { ...c, members: membersOf(c.id).map((m) => m.name) }])
  );
  const rows = db.prepare('SELECT category, costume_id, COUNT(*) AS n FROM votes GROUP BY category, costume_id').all();
  res.json({
    voting: state,
    event_name: getSetting('event_name') || 'Costume Party',
    turnout: db.prepare('SELECT COUNT(DISTINCT guest_id) AS n FROM votes').get().n,
    total_votes: rows.reduce((a, r) => a + r.n, 0),
    categories: CATEGORIES.map((c) => ({
      ...c,
      results: rows
        .filter((r) => r.category === c.key)
        .map((r) => ({ costume: costumes.get(r.costume_id) || null, votes: r.n }))
        .filter((r) => r.costume)
        .sort((a, b) => b.votes - a.votes || a.costume.name.localeCompare(b.costume.name)),
    })),
  });
});

function costumesList() {
  return db.prepare('SELECT * FROM costumes ORDER BY id').all();
}