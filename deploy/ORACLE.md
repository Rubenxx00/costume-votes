# Deploying to Oracle Cloud Free Tier behind Cloudflare

Short version: this fits the free tier easily, and the pairing is a good one —
`cloudflared` dials *out* to Cloudflare, so you never open an inbound port.

Measured needs for a 50-person party: ~100 MB RAM steady, a few minutes of CPU
for photo resizing, well under 1 GB of disk. The Always Free ARM Ampere A1
shape (4 OCPU / 24 GB) is roughly 20× more than this needs.

---

## 1. The instance

Create an **Ampere A1** VM in the free tier. This app needs **Node ≥ 22.5** for
the built-in `node:sqlite`; a preinstalled Node is usually older. Verified
working on **Oracle Linux 9.8 (aarch64)**, which is the image used below:

```bash
# RHEL family — Oracle Linux, Alma, Rocky, Amazon Linux
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
sudo dnf install -y nodejs git

# Debian family — Ubuntu
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

node -v          # must be >= 22.5
```

`sharp` ships prebuilt `linux-arm64` binaries, so `npm install` needs no
compiler on the ARM shape — confirmed, zero build steps.

## 2. The app

```bash
git clone https://github.com/Rubenxx00/costume-votes.git
cd costume-votes
sudo ./deploy/install.sh              # add --from-git to clone straight to /opt
```

The installer creates a dedicated `costume-votes` system account, syncs the
code to `/opt/costume-votes`, runs `npm ci --omit=dev`, writes
`/etc/costume-votes.env` with a generated admin password (printed **once**),
installs the unit, starts it, and fails loudly with the journal if the service
does not come up. Re-running it upgrades the code and leaves the password and
database alone.

<details>
<summary>Doing it by hand instead</summary>

```bash
sudo useradd --system --home-dir /opt/costume-votes --shell /sbin/nologin costume-votes
sudo mkdir -p /opt/costume-votes && sudo chown root:root /opt/costume-votes
# copy the repo here, then:
cd /opt/costume-votes
sudo npm ci --omit=dev

sudo install -d -o costume-votes -g costume-votes -m 750 /opt/costume-votes/data
sudo install -m 600 deploy/costume-votes.env.example /etc/costume-votes.env
sudo editor /etc/costume-votes.env      # set ADMIN_PASSWORD

sudo cp deploy/costume-votes.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now costume-votes
sudo journalctl -u costume-votes -f     # shows the LAN/admin URLs
```

Two things in that unit file are load-bearing, and both used to be wrong:

- **`User=` / `Group=`** must name an account that exists on the host. This is
  why the installer creates `costume-votes` rather than reusing a login user —
  the file previously said `ubuntu`, which exists only on Ubuntu images, and
  systemd fails the unit with `status=217/USER` everywhere else.
- **`RestrictAddressFamilies` must include `AF_NETLINK`.** `os.networkInterfaces()`
  goes through `getifaddrs()`, which is a netlink socket. Without it Node throws
  `uv_interface_addresses returned Unknown system error 97` (EAFNOSUPPORT) at
  boot, the process dies, and the unit restart-loops with nothing on port 3000.

</details>

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
#      path       ← LEAVE THIS EMPTY
```

**Leave the `Path` field empty.** It is a route prefix, not part of your service
URL: cloudflared matches it against the request path, which always starts with
`/`. A path of `v1` (or any value without a leading `/`) therefore matches no
request at all, everything falls through to the implicit
`{"service":"http_status:404"}`, and the hostname returns **404 for every URL
including the one you typed** — while the tunnel itself reports healthy. If you
see a blanket 404, check the connector's own view of the rule:

```bash
sudo journalctl -u cloudflared -n 20 | grep -i ingress
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

**Change the admin password before the party.** `ADMIN_PASSWORD` in
`/etc/costume-votes.env` is honoured on **first boot only** — `ensureAdminPassword()`
skips it once a password exists in the database, so editing the file later does
nothing. Change it at **Admin → Settings → Admin password**. If you've lost it,
there is no recovery: reset the `admin_password` row in
`/opt/costume-votes/data/party.db` and restart.

Changing the password alone leaves already-issued session cookies valid, because
the cookie signing key is independent of it. Tick **“Sign out other devices”**
when changing it if the reason is that the old one leaked.

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
| `ADMIN_PASSWORD` | Admin password, applied on first boot only — change it later at Admin → Settings |
| `PORT` | HTTP port (default 3000) |
| `DATA_DIR` | Database + uploads (default `./data`) |
| `PUBLIC_BASE_URL` | Printed at boot for guests |
| `ADMIN_SECRET` | Optional; forces the session cookie `Secure` |
| `FORCE_SECURE_COOKIE` | Force `Secure` if a proxy rewrites protocol headers |