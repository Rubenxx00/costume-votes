# 🎃 Costume Votes

A self-hosted voting platform for a home costume party. Guests are onboarded
with a photo, grouped into **solo / couple / group costumes**, and vote with a
one-time token in three categories. Nobody can vote for their own costume.

Built for ~50 people on a laptop or a small box, reachable over the venue WiFi
or through an HTTPS tunnel.

- Node.js + Express 5 + SQLite (built-in `node:sqlite` — no native compile step)
- Only two dependencies: Express and sharp (image resizing)
- Photos stored on disk in two resolutions — see below
- A costume is a name (optional, defaults to the guest names), a photo, and its
  members — nothing else to fill in
- Server-enforced rules: own-costume block, one vote per category, hard close time

---

## Quick start

```bash
npm install
ADMIN_PASSWORD='choose-something' npm start
```

It prints the admin URL, your LAN IP, and where guests should go:

```
  Guests / landing   http://localhost:3000/
  (LAN)              http://192.168.1.202:3000/
  Admin console      http://localhost:3000/admin
```

If you don't pass `ADMIN_PASSWORD`, a random one is generated and printed **once**
on first boot. Save it — it's hashed in the database and not recoverable.

### Photos

The admin uploads the camera original untouched; **sharp** derives two sizes:

| | size | loaded when |
|---|---|---|
| `photo` | 400px, q72 | every grid — roster, ballot, results board |
| `photo_hd` | 1600px, q85 | only when someone taps a photo to enlarge it |

So a 50-costume ballot pulls tens of KB rather than tens of MB, and the HD
files cost nothing until someone actually looks. Tap-to-enlarge works on the
guest ballot, the admin roster, the costume list and the results board; Esc or a
tap outside dismisses it.

Both resolutions are always written together, so a costume can never end up
with an HD file but no preview (which would render blank in every grid).
Replacing a photo rewrites the pair and deletes the files it replaced.

Tunables live in `PHOTO_SIZES` in `src/config.js`.

### As the host, at the party

1. **Roster** — paste the guest list (one name per line) or upload a CSV.
2. **Onboard costumes** — as guests arrive: autocomplete their name(s), snap a
   photo, save. (The photo is optional — you can add one later.) Takes ~10 seconds each. The costume type is worked out from the
   headcount — 1 guest is a solo, 2 a couple, 3+ a group — so there's nothing to
   pick and nothing to get wrong. The form resets after every save, ready for
   the next guest.
3. **Tokens** — generate, download the CSV, cut it up, hand one card per guest.
4. **Open voting** — the big button above the tabs. Voting starts closed, so
   loading names and taking photos can't be interrupted by early votes. Press it
   when everyone is registered; press it again (or let a deadline pass) to close.
5. **Results** — `/results` is the projector-friendly board, public once voting closes.

### As a guest

Scan/open the link, type the 8-character code from their card, pick one costume
per category. Votes can be changed until the timer runs out.

---

## Deploying

`deploy/ORACLE.md` covers running this on Oracle Cloud Free Tier (Ampere ARM)
behind a Cloudflare Tunnel — instance sizing, systemd unit, the named-tunnel
setup, and the free-tier idle-reclaim gotcha. `deploy/costume-votes.service` and
`deploy/costume-votes.env.example` are ready to install.

The tunnel is the only supported production path: no inbound ports are opened in
the Oracle security list, and `cloudflared` terminates TLS and renews the
certificate itself.

## Public access over HTTPS (tunnel)

For guests on mobile data rather than venue WiFi, tunnel it. Quick test, no
account:

```bash
cloudflared tunnel --url http://localhost:3000
```

That prints a temporary `https://<random>.trycloudflare.com` — fine for testing,
but the hostname changes on restart, so don't put it on the guest cards. For a
real address, create a named tunnel in the Cloudflare dashboard and point a
hostname at `http://localhost:3000`; `cloudflared` then handles TLS and renews
the certificate itself.

Tell the app which URL guests will use:

```bash
PUBLIC_BASE_URL=https://votes.example.com ADMIN_PASSWORD='…' npm start
```

The app decides the session cookie's `Secure` flag per request, so it works on
both the HTTPS tunnel and a plain `http://<vm-ip>:3000` console — no
configuration needed. Set `ADMIN_SECRET` only if something in front rewrites
the protocol headers and you need to force the flag.

> **Before exposing it to the internet:** this is a single-admin app with a
> password, sized for one party, not hardened for the open web. Change the admin
> password, and keep the tunnel closed once guests are done. Anyone holding a
> valid token can cast that guest's three votes.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite database + uploaded photos |
| `ADMIN_PASSWORD` | random on first boot | Initial admin password |
| `ADMIN_SECRET` | random, stored in DB | Session signing key; only needed to force `Secure` |
| `PUBLIC_BASE_URL` | — | Shown at boot for guests |
| `FORCE_SECURE_COOKIE` | — | `1` forces `Secure` if a proxy rewrites protocol headers |

## Data layout

```
data/
  party.db          SQLite (guests, costumes, votes, settings)
  uploads/          costume photos, one file per costume
```

Back up `data/` and you have the whole party. Deleting it resets everything —
guests, costumes, tokens, votes and photos all live there and nowhere else.

---

## Rules the server enforces

- The costume type is derived from the member count server-side
  (`deriveKind`), so a client can't create a 3-person "solo". A guest list with
  0 members, or an id that doesn't exist, is rejected.
- One vote per category per guest (`UNIQUE(guest_id, category)`).
- Re-voting a category overwrites the previous pick; guests can undo freely
  until the deadline.
- **A guest cannot vote for any costume they are a member of** — checked against
  every member of the target costume, not just the primary guest, so editing a
  couple/group later can't sneak a self-vote in.
- A guest who hasn't been onboarded can't vote at all (they'd have nothing to
  protect themselves from).
- **Voting is closed until the host opens it.** Setup happens while guests are
  still arriving and photos are being taken; an unreached or half-configured
  database must never hand out live voting, so an absent setting means closed.
  Opening and closing are both explicit, and a deadline is optional.
- Setting a deadline also opens the gate, since choosing a closing time is an
  intent to vote. Once voting has been opened that fact is remembered — so a
  guest arriving after the host closes it reads "voting is closed", never
  "hasn't started yet" (which would leave them waiting forever).
- After the closing time, or a manual close, all vote writes are refused — a
  stale open tab on a phone can't keep voting.
- Public results are 403 until voting closes, so nobody can watch the tally live
  and pile votes onto one costume. Admin sees live results regardless.
- When a costume drops below its minimum (1 for solo, 2 for couple/group) it's
  deleted along with its votes, so the ballot never shows an empty entry.

---

## Tests

```bash
bash test/run.sh          # boots a throwaway server on a clean DB, tears it down
```

102 assertions covering auth, CSV quirks, kind derivation, token generation,
every voting rule, the voting gate (closed by default, manual open/close, the
distinct closed states), results hiding, and the two-resolution photo pipeline
(both files written, replaced and cleared together; replaced files actually
deleted from disk).

To eyeball the UI with realistic data:

```bash
DATA_DIR=/tmp/demo PORT=4400 ADMIN_PASSWORD=demo1234 npm start &
node test/seed.js http://localhost:4400 demo1234   # 10 guests, 4 costumes, votes cast
```

---

## API sketch

| Method | Path | Who | Notes |
|---|---|---|---|
| `GET` | `/api/status` | anyone | Voting state (`open`, `closesAt`, `reason`) + event name |
| `GET` | `/api/me?token=` | guest | Their ballot: costumes, own costume, current votes |
| `POST` | `/api/vote` | guest | `{token, category, costume_id}`, `undo:"1"` to clear |
| `GET` | `/api/results` | anyone | 403 until voting closes |
| `POST` | `/api/admin/login` | admin | Sets the session cookie |
| `GET` | `/api/admin/overview` | admin | Everything the console renders from |
| `POST` | `/api/admin/guests/import` | admin | `{csv}` — raw CSV text |
| `GET` | `/api/admin/guests/search?q=` | admin | Autocomplete |
| `POST` | `/api/admin/costumes` | admin | Onboard: `{guest_ids, name, photo}` — kind inferred, both sizes derived |
| `POST` | `/api/admin/tokens/generate` | admin | Issue missing tokens |
| `GET` | `/api/admin/tokens.csv` | admin | Print/download sheet |
| `POST` | `/api/admin/settings` | admin | `{voting_open, closes_at, event_name}` |

---

## Adapting it

**Categories** — edit `CATEGORIES` in `src/db.js`. The `votes.category` CHECK
constraint and the UI both read from it, so adding a fourth needs a migration
(drop and recreate `votes`; it's throwaway data).

**Costume types** — edit `deriveKind()` in `src/db.js`. It maps headcount to a
type and is the only place that mapping exists: the browser mirrors it for the
live label, the server owns the truth. `KINDS` next to it supplies the labels and
the per-kind minimums that drive the auto-delete rule.

**Photo sizes** — `PHOTO_SIZES` in `src/config.js` sets the preview (400px/q72)
and HD (1600px/q85) dimensions. Raising the preview to ~600 helps on a
projector; raising HD past 1600 only costs bandwidth.

**Token format** — `randomToken()` in `src/db.js`. The alphabet omits
`0/O/1/I/L/U/V` so codes survive being read aloud across a noisy room.