# Deploying to Oracle Cloud Free Tier behind Cloudflare

Short version: this fits the free tier easily, and the pairing is a good one —
`cloudflared` dials *out* to Cloudflare, so you never open an inbound port.

Measured needs for a 50-person party: ~100 MB RAM steady, a few minutes of CPU
for photo resizing, well under 1 GB of disk. The Always Free ARM Ampere A1
shape (4 OCPU / 24 GB) is roughly 20× more than this needs.

---

## 1. The instance

Create an **Ampere A1** VM in the free tier. On Ubuntu 24.04 a preinstalled Node
may be too old — this app needs **Node ≥ 22.5** for the built-in `node:sqlite`.
Either pick the Oracle Linux 8 image with the Node 22+ preinstall option, or
install it on Ubuntu:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v          # must be >= 22.5
```

`sharp` ships prebuilt `linux-arm64` binaries, so `npm install` needs no
compiler on the ARM shape.

## 2. The app

```bash
sudo mkdir -p /opt/costume-votes && sudo chown $USER /opt/costume-votes
# copy the repo here, then:
cd /opt/costume-votes
npm ci --omit=dev

sudo install -d -o $USER -g $USER /opt/costume-votes/data
sudo install -m 600 deploy/costume-votes.env.example /etc/costume-votes.env
sudo editor /etc/costume-votes.env      # set ADMIN_PASSWORD

sudo cp deploy/costume-votes.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now costume-votes
sudo journalctl -u costume-votes -f     # shows the LAN/admin URLs
```

## 3. The tunnel (Cloudflare Tunnel)

`cloudflared` is the whole point of this setup: it makes the app reachable at a
public HTTPS address **without opening any inbound port**, because it dials out
to Cloudflare and Cloudflare calls back down that connection.

```bash
# 1. Dashboard: Zero Trust → Networks → Tunnels → Create tunnel → Cloudflared
# 2. Copy the install command it shows, which looks like:
sudo cloudflared service install eyJhIjoiXXXXX...

# 3. In the same wizard, add a public hostname:
#      subdomain  votes
#      domain     example.com
#      service    http://localhost:3000
```

That's the whole deployment. No Oracle security-list change, no nginx, no
certificate to renew — `cloudflared` provisions and renews the origin
certificate itself, and the hop to your app stays on loopback over plain HTTP.

Verify from your laptop, not the VM:

```bash
curl -I https://votes.example.com/          # 200
curl -I https://votes.example.com/admin      # 302 → /admin/login
```

### Without a domain

For a quick test, no account or dashboard needed:

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a temporary `https://<random>.trycloudflare.com` with a valid
certificate. **The hostname changes on every restart**, so never print it on the
guest cards — use it to test, then set up the named tunnel above.

## 4. Firewall

Leave **every** inbound port closed in the Oracle security list, including 3000.
Nothing outside needs to reach the VM: `cloudflared` maintains the connection
outbound and Cloudflare routes guest traffic down it.

That means the app is unreachable by IP, by port scan, or by anyone guessing
the address — the tunnel is the only way in. To test on the VM's own console,
use `curl http://localhost:3000` rather than opening a port.

---

## Night-of checklist

```bash
sudo systemctl is-active costume-votes      # active
sudo systemctl is-active cloudflared        # active  ← the tunnel is its own service
curl -s https://votes.example.com/api/status   # "open":false until you press Open voting
```

If guests can't reach the page, it is almost always the tunnel, not the app:

```bash
sudo systemctl status cloudflared
sudo journalctl -u cloudflared -n 50
```

The app logs its own LAN/admin URLs at boot, and `PUBLIC_BASE_URL` in
`/etc/costume-votes.env` is what it prints for guests — set it to the tunnel
hostname so you copy the right URL onto the cards.

## Things that will bite

**The free tier can stop your VM.** Oracle's Always Free policy lets them reclaim
idle compute — a VM averaging under 10% CPU *and* under 20% network for a week
gets reclaimed with 30 days' notice on the block volume. For a party app that
sits idle for 364 days a year, this is the single biggest risk to the
deployment. Options: check for reclaim emails, keep a local backup of `data/`,
or accept the risk and rebuild. See "Backups" below.

**Backups are on you.** One VM, one disk, no redundancy. Before the party:

```bash
sudo systemctl stop costume-votes
sudo tar czf ~/costume-votes-$(date +%F).tar.gz -C /opt costume-votes/data
sudo systemctl start costume-votes
```

**Restart loses nothing** — the database and photos live in `data/`, and the
admin session is a signed cookie, so a restart just sends you back to the login
screen.

**Don't hand out `/admin` while setting up.** The console is a single shared
password with no rate limiting. It's behind the tunnel, but anyone who finds the
URL can still try guesses. If you want it tighter, add a Cloudflare Zero Trust
Access policy on the `admin` path so only your identity gets through — or a WAF
rate-limit rule.

**Mind HSTS if you also test over HTTP.** Once a browser has seen an HSTS policy
for a hostname it refuses to fall back to plain HTTP for it, so don't expect
`http://votes.example.com` to work in the same browser afterwards. Use a private
window for any LAN/HTTP checks.

**A phone on mobile data is the realistic case.** That's exactly what the
preview/HD split handles: the ballot pulls tens of KB of thumbnails, not tens of
MB of camera originals.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Admin password, applied on first boot only |
| `PORT` | HTTP port (default 3000) |
| `DATA_DIR` | Database + uploads (default `./data`) |
| `PUBLIC_BASE_URL` | Printed at boot for guests |
| `ADMIN_SECRET` | Optional; forces the session cookie `Secure` |
| `FORCE_SECURE_COOKIE` | Force `Secure` if a proxy rewrites protocol headers |