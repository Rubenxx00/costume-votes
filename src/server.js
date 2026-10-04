import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { PORT, VIEWS_DIR, PUBLIC_DIR, UPLOAD_DIR, DATA_DIR, ADMIN_SECRET, ADMIN_PASSWORD, PUBLIC_BASE_URL } from './config.js';
import { cookies } from './cookies.js';
import { ensureAdminPassword, isAdmin, requireAdminPage } from './auth.js';
import { getSetting, setSetting, isVotingOpen, CATEGORIES } from './db.js';
import { router as adminRouter } from './routes/admin.js';
import { router as guestRouter } from './routes/guest.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');
// Behind a Cloudflare/ngrok tunnel the client IP arrives in X-Forwarded-For.
app.set('trust proxy', true);

app.use(cookies);
app.use(express.json({ limit: '20mb' }));  // photo upload carries preview + HD

// Small hardening: deny obvious scanners, allow the tunnel + local networks.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// Every upload gets a uuid filename and is never edited in place, so it can be
// cached hard — a returning guest re-validates zero bytes of photos.
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '30d',
  immutable: true,
  index: false,
}));
app.use(express.static(PUBLIC_DIR, { index: false }));

app.use('/api/admin', adminRouter);
app.use('/api', guestRouter);

/* ------------------------------------------------------------------ pages */

app.get('/', (req, res) => res.sendFile(path.join(VIEWS_DIR, 'landing.html')));

app.get('/vote', (req, res) => res.sendFile(path.join(VIEWS_DIR, 'vote.html')));
app.get('/results', (req, res) => res.sendFile(path.join(VIEWS_DIR, 'results.html')));

app.get('/admin/login', (req, res) =>
  isAdmin(req) ? res.redirect('/admin') : res.sendFile(path.join(VIEWS_DIR, 'login.html'))
);
app.get('/admin', requireAdminPage, (req, res) => res.sendFile(path.join(VIEWS_DIR, 'admin.html')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(VIEWS_DIR, '404.html'));
});

app.use((err, req, res, _next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/')) res.status(500).json({ error: 'Server error' });
  else res.status(500).send('Server error');
});

/* ------------------------------------------------------------------- boot */

const generated = ensureAdminPassword();
const voting = isVotingOpen();

app.listen(PORT, () => {
  const nets = localAddresses();
  console.log('\n  🎃 Costume Votes is running\n');
  console.log(`  Guests / landing   http://localhost:${PORT}/`);
  for (const ip of nets) console.log(`  (LAN)              http://${ip}:${PORT}/`);
  console.log(`\n  Admin console      http://localhost:${PORT}/admin`);
  if (PUBLIC_BASE_URL) console.log(`  Public (tunnel)    ${PUBLIC_BASE_URL}/`);
  if (ADMIN_SECRET) console.log('  Admin secret loaded; admin cookies are Secure.');
  if (generated) {
    console.log('\n  ┌───────────────────────────────────────────────┐');
    console.log('  │  FIRST-RUN ADMIN PASSWORD (shown once)         │');
    console.log(`  │  ${generated.padEnd(45)} │`);
    console.log('  │  Save it now, then change it in Admin → Settings│');
    console.log('  └───────────────────────────────────────────────┘');
  }
  if (!getSetting('event_name')) setSetting('event_name', 'Costume Party');
  console.log(`\n  Event: ${getSetting('event_name')} · categories: ${CATEGORIES.map((c) => c.label).join(', ')}`);
  console.log(`  Voting: ${describeVoting(voting)}\n`);
});

/**
 * `closesAt` is null whenever no deadline was ever set, and `new Date(null)` is
 * the epoch — so a naive template prints "CLOSED at 1/1/1970" on every boot of
 * a fresh install. Branch on the reason instead.
 */
function describeVoting(voting) {
  if (voting.open) {
    return `OPEN${voting.closesAt ? ` until ${new Date(voting.closesAt).toLocaleString()}` : ''}`;
  }
  if (voting.reason === 'deadline-passed' && voting.closesAt) {
    return `CLOSED — deadline passed at ${new Date(voting.closesAt).toLocaleString()}`;
  }
  if (voting.reason === 'closed-by-host') return 'CLOSED by host';
  return 'CLOSED (not opened yet)';
}

/**
 * The LAN hint is a nicety, not a requirement: it only decorates the boot
 * banner. It must never be able to take the server down.
 *
 * It used to. Under a systemd sandbox that omits AF_NETLINK from
 * RestrictAddressFamilies, getifaddrs() fails and Node throws
 * `uv_interface_addresses returned Unknown system error 97` (EAFNOSUPPORT) —
 * which killed the process and left the unit restart-looping with voting
 * unreachable.
 */
function localAddresses() {
  try {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
    return out;
  } catch (err) {
    console.warn(`  (could not enumerate network interfaces: ${err.message})`);
    return [];
  }
}