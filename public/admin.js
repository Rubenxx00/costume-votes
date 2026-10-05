const $ = (id) => document.getElementById(id);
const EMOJI = { single: '🧍', couple: '💞', group: '👥' };

let S = null;            // server state
let selected = [];       // guest ids staged for the costume being built
let photoData = null;    // the original, as a data URL; resized server-side
let photoHd = null;      // unused by the client now — kept for the payload shape
let photoName = '';
let filter = '';

/* ------------------------------------------------------------------ utils */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) { location.href = '/admin/login'; throw new Error('unauthorised'); }
    throw Object.assign(new Error(data.error || 'Request failed'), { data, res });
  }
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function flash(text, kind = 'ok') {
  const el = $('msg');
  el.className = `msg ${kind}`;
  el.textContent = text;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (kind === 'ok') setTimeout(() => { if (el.textContent === text) el.className = 'msg'; }, 3500);
}

/* ------------------------------------------------------------------ load */

async function load() {
  const [overview, results] = await Promise.all([
    api('/api/admin/overview'),
    api('/api/admin/results'),
  ]);
  S = overview;
  S.tally = results;
  S.voteCounts = computeVoteCounts(results);
  paintHeader();
  paintStats();
  paintGuests();
  paintCostumes();
  paintTokens();
  paintResults();
  paintSettings();
}

/** Votes per costume, summed across the three categories. */
function computeVoteCounts(tally) {
  const out = new Map();
  for (const cat of tally.categories)
    for (const r of cat.results) out.set(r.costume.id, (out.get(r.costume.id) || 0) + r.votes);
  return out;
}

function paintHeader() {
  $('event').textContent = S.event_name || 'Costume Party';
  const v = S.voting;
  const badge = $('votingBadge');
  if (v.open) {
    badge.className = 'badge ok';
    badge.textContent = v.closesAt
      ? `voting open · closes ${new Date(v.closesAt).toLocaleTimeString()}`
      : 'voting open · no deadline';
  } else {
    badge.className = 'badge off';
    badge.textContent = v.reason === 'deadline-passed' ? 'closed · deadline passed' : 'voting closed';
  }
  document.title = `Admin · ${S.event_name || 'Costume Party'}`;
  paintGate();
}

/**
 * The prominent open/close control. Kept above the tabs because this is the one
 * action the host performs live, in front of the room.
 */
function paintGate() {
  const v = S.voting;
  const btn = $('toggleVoting');
  if (v.open) {
    btn.textContent = 'Close voting now';
    btn.className = 'danger';
    $('gateTitle').textContent = 'Voting is open';
    $('gateSub').textContent = v.closesAt
      ? `Guests can vote until ${new Date(v.closesAt).toLocaleString()}.`
      : 'Guests can vote. It stays open until you close it.';
  } else {
    btn.textContent = 'Open voting';
    btn.className = 'primary';
    $('gateTitle').textContent = v.reason === 'deadline-passed'
      ? 'Voting is closed'
      : 'Voting is closed';
    $('gateSub').textContent = v.reason === 'deadline-passed'
      ? 'The deadline has passed. Re-open to let late guests vote, or show the results.'
      : `Finish the roster and photos, then open voting. ${S.stats.onboarded} of ${S.stats.guests} guests onboarded so far.`;
  }
}

function paintStats() {
  const st = S.stats;
  $('stats').innerHTML = [
    ['Guests', st.guests],
    ['Onboarded', `${st.onboarded}/${st.guests}`],
    ['Costumes', st.costumes],
    ['Voters', st.voted],
  ].map(([k, v]) => `<div class="stat"><b>${esc(v)}</b><span>${k}</span></div>`).join('');
}

/* --------------------------------------------------------------- roster */

function costumeOf(guestId) {
  return S.costumes.find((c) => c.id === guestId);
}

function paintGuests() {
  const rows = S.guests
    .filter((g) => !filter || g.name.toLowerCase().includes(filter))
    .map((g) => {
      const c = S.costumes.find((x) => x.id === g.costume_id);
      return `<tr>
        <td><b>${esc(g.name)}</b></td>
        <td>${c ? `<span class="badge kind">${EMOJI[c.kind]} ${esc(c.name)}</span>` : '<span class="badge">—</span>'}</td>
        <td>${c?.photo ? `<img src="${esc(c.photo)}" alt="" loading="lazy" class="zoomable"
              data-hd="${esc(c.photo_hd || c.photo)}" data-caption="${esc(c.name)}">` : '<span class="sub">no photo</span>'}</td>
        <td class="mono">${g.token ? esc(g.token) : '<span class="sub">—</span>'}</td>
        <td style="text-align:right;white-space:nowrap">
          ${g.costume_id
            ? `<button class="small" data-unguest="${g.id}">Detach</button>`
            : `<button class="small" data-prefill="${g.id}">Onboard</button>`}
          <button class="small danger" data-delguest="${g.id}">✕</button>
        </td>
      </tr>`;
    }).join('');
  $('guestRows').innerHTML = rows ||
    `<tr><td colspan="5" class="empty">No guests yet — paste names above and hit “Add guests”.</td></tr>`;
}

$('guestFilter').addEventListener('input', (e) => { filter = e.target.value.trim().toLowerCase(); paintGuests(); });

/* --------------------------------------------------------------- import */

$('pickFile').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  $('csv').value = await f.text();
  flash(`Loaded ${f.name} into the box — check it, then “Add guests”.`, 'info');
});
$('clearCsv').addEventListener('click', () => { $('csv').value = ''; });

$('import').addEventListener('click', async () => {
  const csv = $('csv').value.trim();
  if (!csv) return flash('Paste some names first.', 'err');
  try {
    const out = await api('/api/admin/guests/import', { method: 'POST', body: { csv } });
    $('csv').value = '';
    await load();
    const skipped = out.skipped.length
      ? ` · skipped ${out.skipped.length} (${out.skipped.slice(0, 4).map((s) => s.name).join(', ')}${out.skipped.length > 4 ? '…' : ''})`
      : '';
    $('importReport').innerHTML = `<div class="msg ok">Added ${out.added.length}: ${esc(out.added.join(', '))}${skipped}</div>`;
  } catch (e) { flash(e.message, 'err'); }
});

document.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-delguest]');
  if (del) {
    const g = S.guests.find((x) => x.id === Number(del.dataset.delguest));
    if (!confirm(`Remove ${g?.name} from the guest list? Their votes go too.`)) return;
    await api(`/api/admin/guests/${g.id}/delete`, { method: 'POST' });
    await load();
    return flash(`${g.name} removed.`);
  }
  const un = e.target.closest('[data-unguest]');
  if (un) {
    const id = Number(un.dataset.unguest);
    const c = S.costumes.find((x) => x.id === S.guests.find((g) => g.id === id)?.costume_id);
    if (!confirm(`Detach this guest from “${c?.name}”?`)) return;
    await api(`/api/admin/costumes/${c.id}/update`, { method: 'POST', body: { detach: [id] } });
    await load();
    return flash('Detached.');
  }
  const pre = e.target.closest('[data-prefill]');
  if (pre) {
    resetForm();
    selected = [Number(pre.dataset.prefill)];
    goTab('onboard');
    paintChips();
    $('ac').focus();
    return;
  }
});

/* -------------------------------------------------------------- onboard */

const KIND_LABEL = { single: 'solo', couple: 'couple', group: 'group' };

/** Mirrors the server's deriveKind(): 1 solo, 2 couple, 3+ group. */
function kindFor(n) {
  return n === 1 ? 'single' : n === 2 ? 'couple' : n > 2 ? 'group' : null;
}

/** What the costume will be saved as, given the guests picked so far. */
function describeSelection() {
  const n = selected.length;
  if (n === 0) return 'start typing a name…';
  if (n === 1) {
    const name = S.guests.find((g) => g.id === selected[0])?.name || 'this guest';
    return `1 guest (${name}) → saved as a solo`;
  }
  return `${n} guests → saved as a ${KIND_LABEL[kindFor(n)]}`;
}

$('ac').addEventListener('input', async (e) => {
  const q = e.target.value.trim();
  const list = $('acList');
  if (q.length < 1) return list.classList.remove('show');
  const { guests } = await api(`/api/admin/guests/search?q=${encodeURIComponent(q)}`);
  const avail = guests.filter((g) => !selected.includes(g.id));
  list.innerHTML = avail.length
    ? avail.map((g) => {
        const c = S.costumes.find((x) => x.id === g.costume_id);
        return `<div class="ac-item" data-pick="${g.id}">
          <span>${esc(g.name)}</span>
          <small>${c ? 'in ' + esc(c.name) : 'free'}</small>
        </div>`;
      }).join('')
    : `<div class="ac-item"><small>No match</small></div>`;
  list.classList.add('show');
});

document.addEventListener('click', (e) => {
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    selected.push(Number(pick.dataset.pick));
    $('ac').value = '';
    $('acList').classList.remove('show');
    paintChips();
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.autocomplete')) $('acList')?.classList.remove('show');
});

function paintChips() {
  $('acHint').textContent = `— ${describeSelection()}`;
  $('chips').innerHTML = selected
    .map((id) => {
      const g = S.guests.find((x) => x.id === id);
      const c = S.costumes.find((x) => x.id === g?.costume_id);
      return `<span class="chip ${c ? 'self' : ''}">${esc(g?.name || id)}${c ? ' · already in ' + esc(c.name) : ''}
        <button data-unpick="${id}" title="remove">✕</button></span>`;
    }).join('');
}

document.addEventListener('click', (e) => {
  const u = e.target.closest('[data-unpick]');
  if (!u) return;
  selected = selected.filter((x) => x !== Number(u.dataset.unpick));
  paintChips();
});

/* photo ------------------------------------------------------------------ */

$('drop').addEventListener('click', () => $('photoInput').click());
$('preview').querySelector('#retake').addEventListener('click', () => {
  photoData = null;
  $('preview').classList.add('hidden');
  $('photoInput').click();
});

['dragenter', 'dragover'].forEach((ev) =>
  $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  $('drop').addEventListener(ev, () => $('drop').classList.remove('over')));
$('drop').addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files?.[0];
  if (f) handlePhoto(f);
});

$('photoInput').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) handlePhoto(f);
});

/**
 * The original goes to the server untouched; sharp derives the preview and HD
 * sizes there. Resizing in the browser meant shipping base64 through the JSON
 * body and duplicating image logic in two places, so this stays a plain
 * read-and-send.
 *
 * The preview shown here is a local object URL purely so the host can see what
 * they picked — it is never uploaded and never stored.
 */
const MAX_UPLOAD_MB = 25;

function handlePhoto(file) {
  if (!file.type.startsWith('image/')) return flash('That file is not an image.', 'err');
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    return flash(`That photo is ${(file.size / 1048576).toFixed(1)} MB — pick something under ${MAX_UPLOAD_MB} MB.`, 'err');
  }
  const reader = new FileReader();
  reader.onload = () => {
    // Validate it decodes before spending an upload on a corrupt file.
    const probe = new Image();
    probe.onload = () => {
      photoData = reader.result;
      photoHd = null;                 // derived server-side
      photoName = file.name || 'photo';
      $('previewImg').src = URL.createObjectURL(file);
      $('preview').classList.remove('hidden');
      const mp = (probe.width * probe.height / 1e6).toFixed(1);
      $('previewNote').textContent =
        `${file.name} · ${probe.width}×${probe.height} (${mp} MP) · ${(file.size / 1048576).toFixed(1)} MB`;
    };
    probe.onerror = () => flash('Could not read that image.', 'err');
    probe.src = reader.result;
  };
  reader.readAsDataURL(file);
}

/**
 * Clears every field of the onboarding form. Used by the Clear button, after a
 * successful save, and when the host jumps in from the roster.
 *
 * The file input's own value must be reset too: pick the same photo twice and
 * Chrome fires no `change` event, so the second costume silently gets no image.
 */
function resetForm() {
  selected = [];
  photoData = null;
  photoHd = null;
  photoName = '';
  $('cname').value = '';
  $('ac').value = '';
  $('acList').classList.remove('show');
  $('photoInput').value = '';
  // Release the local preview blob rather than leaking it per costume.
  const img = $('previewImg');
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  img.removeAttribute('src');
  $('previewNote').textContent = '';
  $('preview').classList.add('hidden');
  $('drop').classList.remove('over');
  paintChips();
}

$('clearForm').addEventListener('click', () => {
  resetForm();
  $('ac').focus();
});

$('saveCostume').addEventListener('click', async () => {
  // No type to pick and nothing to get wrong: the headcount decides.
  const ids = [...selected];
  if (!ids.length) return flash('Pick at least one guest first.', 'err');
  const kind = kindFor(ids.length);

  const names = ids.map((id) => S.guests.find((g) => g.id === id)?.name).filter(Boolean);
  const movers = ids.filter((id) => S.guests.find((g) => g.id === id)?.costume_id);
  if (movers.length && !confirm(
    `${movers.map((id) => S.guests.find((g) => g.id === id).name).join(', ')} already belong to a costume.\n` +
    'Move them to this one? Their old costume will be left without them.')) return;

  const btn = $('saveCostume');
  btn.disabled = true;
  try {
    await api('/api/admin/costumes', {
      method: 'POST',
      body: {
        name: $('cname').value.trim(),
        guest_ids: ids,
        photo: photoData,     // the original; sharp makes both sizes
      },
    });
    // Reset before the reload so a failed load can't leave stale input behind.
    resetForm();
    await load();
    flash(`Saved — ${names.join(', ')} onboarded as a ${KIND_LABEL[kind]}.`);
    $('ac').focus();   // next guest is already walking up
  } catch (e) {
    flash(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------- costumes */

function paintCostumes() {
  $('cCount').textContent = S.costumes.length;
  $('costumeRows').innerHTML = S.costumes.map((c) => {
    const n = S.voteCounts.get(c.id) || 0;
    return `<tr>
      <td>${c.photo ? `<img src="${esc(c.photo)}" alt="" loading="lazy" class="zoomable"
              data-hd="${esc(c.photo_hd || c.photo)}" data-caption="${esc(c.name)}">` : `<div class="noimg" style="width:56px;height:56px;border-radius:10px;display:grid;place-items:center">${EMOJI[c.kind]}</div>`}</td>
      <td><b>${esc(c.name)}</b></td>
      <td><span class="badge kind">${EMOJI[c.kind]}${c.kind === 'group' ? ` ${c.members.length}` : ''}</span></td>
      <td>${esc(c.members.map((m) => m.name).join(', ') || '—')}</td>
      <td><span class="badge">${n}</span></td>
      <td style="text-align:right"><button class="small danger" data-delcostume="${c.id}">Delete</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="6" class="empty">Nothing onboarded yet.</td></tr>`;
}

document.addEventListener('click', async (e) => {
  const d = e.target.closest('[data-delcostume]');
  if (!d) return;
  const c = S.costumes.find((x) => x.id === Number(d.dataset.delcostume));
  if (!confirm(`Delete “${c.name}”?\n\nIts members go back to the un-onboarded list and votes for it are deleted.`)) return;
  await api(`/api/admin/costumes/${c.id}/delete`, { method: 'POST' });
  await load();
  flash('Costume deleted.');
});

/* --------------------------------------------------------------- tokens */

$('genTokens').addEventListener('click', async () => {
  const out = await api('/api/admin/tokens/generate', { method: 'POST', body: {} });
  await load();
  flash(out.issued ? `Issued ${out.issued} token(s).` : out.message, out.issued ? 'ok' : 'info');
});

function paintTokens() {
  $('tokenRows').innerHTML = S.guests.map((g) => {
    const c = S.costumes.find((x) => x.id === g.costume_id);
    return `<tr>
      <td class="mono"><b>${g.token ? esc(g.token.slice(0, 4) + '-' + g.token.slice(4)) : '<span class="sub">—</span>'}</b></td>
      <td>${esc(g.name)}${g.onboarded ? '' : ' <span class="badge">not onboarded</span>'}</td>
      <td>${c ? esc(c.name) : '<span class="sub">—</span>'}</td>
      <td><span>${esc(g.votes ?? 0)}/3</span></td>
      <td style="text-align:right">${g.token ? `<button class="small" data-copy="${esc(g.token)}">Copy</button>` : ''}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" class="empty">No guests loaded yet.</td></tr>`;
}

document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-copy]');
  if (!c) return;
  const token = c.dataset.copy;
  try {
    await navigator.clipboard.writeText(`${token.slice(0, 4)}-${token.slice(4)}`);
    flash(`Copied ${token.slice(0, 4)}-${token.slice(4)}`);
  } catch {
    flash(`Token: ${token.slice(0, 4)}-${token.slice(4)}`, 'info');
  }
});

/* -------------------------------------------------------------- results */

function paintResults() {
  const box = $('adminResults');
  const t = S.tally;
  $('turnout').textContent = `${t.turnout} of ${S.stats.onboarded} onboarded guests have voted · ${t.total_votes} votes cast`;
  box.innerHTML = t.categories.map((cat) => `
    <h3 style="margin-top:16px">${esc(cat.label)}</h3>
    <div class="podium">
      ${cat.results.map((r, i) => `
        <div class="rank ${i === 0 ? 'first' : ''}">
          <span class="n">${i + 1}</span>
          ${r.costume.photo ? `<img src="${esc(r.costume.photo)}" alt="" loading="lazy" data-hd="${esc(r.costume.photo_hd || r.costume.photo)}" class="zoomable">` : ''}
          <span class="who"><b>${esc(r.costume.name)}</b>
            <small>${esc(r.costume.members.join(', '))}</small></span>
          <span class="bar"><i style="width:${cat.results[0].votes ? (r.votes / cat.results[0].votes) * 100 : 0}%"></i></span>
          <b>${r.votes}</b>
        </div>`).join('') || '<p class="empty">No votes in this category yet.</p>'}
    </div>`).join('');
}

$('resetVotes').addEventListener('click', async () => {
  if (!confirm('Delete every vote cast so far? This cannot be undone.')) return;
  await api('/api/admin/votes/reset', { method: 'POST' });
  await load();
  flash('All votes deleted.');
});

/* ------------------------------------------------------------- settings */

function paintSettings() {
  const closes = S.voting.closesAt ? new Date(S.voting.closesAt) : null;
  if (closes && !Number.isNaN(closes.getTime())) {
    const pad = (n) => String(n).padStart(2, '0');
    $('closesAt').value =
      `${closes.getFullYear()}-${pad(closes.getMonth() + 1)}-${pad(closes.getDate())}` +
      `T${pad(closes.getHours())}:${pad(closes.getMinutes())}`;
  } else {
    $('closesAt').value = '';
  }
  $('eventName').value = S.event_name || '';
}

async function saveSettings(patch) {
  await api('/api/admin/settings', { method: 'POST', body: patch });
  await load();
}

$('toggleVoting').addEventListener('click', async () => {
  const opening = !S.voting.open;
  const btn = $('toggleVoting');
  btn.disabled = true;
  try {
    await saveSettings({ voting_open: opening });
    flash(opening ? 'Voting is open — guests can vote now.' : 'Voting closed. Results are public.', 'ok');
  } catch (e) {
    flash(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('saveClose').addEventListener('click', () => {
  const v = $('closesAt').value;
  saveSettings({ closes_at: v ? new Date(v).toISOString() : '', voting_open: true })
    .then(() => flash(v
      ? `Close time saved — voting closes at ${new Date(v).toLocaleString()}.`
      : 'Deadline cleared — voting is open until you close it by hand.', 'ok'))
    .catch((e) => flash(e.message, 'err'));
});

for (const [id, ms, label] of [['closeIn1h', 3600e3, '1 hour'], ['closeIn30m', 1800e3, '30 minutes']]) {
  $(id).addEventListener('click', () => {
    saveSettings({ closes_at: new Date(Date.now() + ms).toISOString(), voting_open: true })
      .then(() => flash(`Voting is open and will close in ${label}.`, 'ok'))
      .catch((e) => flash(e.message, 'err'));
  });
}
$('saveEvent').addEventListener('click', () => {
  saveSettings({ event_name: $('eventName').value })
    .then(() => flash('Event name saved.'))
    .catch((e) => flash(e.message, 'err'));
});

$('savePassword').addEventListener('click', async () => {
  const current = $('pwCurrent').value;
  const next = $('pwNext').value;
  const confirm = $('pwConfirm').value;
  const logoutOthers = $('pwLogoutOthers').checked;

  // Validate locally so a typo in the repeat field never reaches the server —
  // the server can't tell a typo from a deliberate change.
  if (next.length < 8) return flash('New password must be at least 8 characters.', 'err');
  if (next !== confirm) return flash('The two new passwords do not match.', 'err');
  if (!current) return flash('Enter your current password.', 'err');

  const btn = $('savePassword');
  btn.disabled = true;
  try {
    const out = await api('/api/admin/password', {
      method: 'POST',
      body: { current, next, logout_others: logoutOthers },
    });
    for (const id of ['pwCurrent', 'pwNext', 'pwConfirm']) $(id).value = '';
    flash(out.sessions_invalidated
      ? 'Password changed and all other devices signed out.'
      : 'Password changed.', 'ok');
  } catch (e) {
    flash(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

/* ----------------------------------------------------------------- tabs */

function goTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-panel]').forEach((p) =>
    p.classList.toggle('hidden', p.dataset.panel !== name));
  history.replaceState(null, '', `#${name}`);
}

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) goTab(b.dataset.tab);
});

$('refresh').addEventListener('click', () => load().then(() => flash('Refreshed.')));
$('logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' });
  location.href = '/admin/login';
});

/* ----------------------------------------------------------------- boot */

load()
  .then(() => {
    goTab(location.hash.slice(1) || 'roster');
    paintChips();
  })
  .catch((e) => {
    // A silent failure here looks like "no data", which is the worst possible
    // thing to show the host mid-party. Say so.
    if (e.message !== 'unauthorised') flash(`Could not load the console: ${e.message}`, 'err');
  });
setInterval(() => {
  if (document.hidden) return;
  load().catch((e) => {
    if (e.message !== 'unauthorised') flash(`Refresh failed: ${e.message}`, 'err');
  });
}, 15000);