const $ = (id) => document.getElementById(id);
const CAT_EMOJI = { beautiful: '👑', scary: '💀', original: '🎨' };
const EMOJI = { single: '🧍', couple: '💞', group: '👥' };

let TOKEN = sessionStorage.getItem('cv_token') || '';
let state = null;
let expandedCategory = null;
// Staged picks, held client-side until the guest hits the submit ("Vote") bar.
// category -> costume_id. Nothing reaches the server until they commit.
let pending = {};
let submitting = false;

// If opened via link with ?token=..., grab it before anything else.
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) {
  TOKEN = String(urlToken).toUpperCase().replace(/[^A-Z0-9]/g, '');
  sessionStorage.setItem('cv_token', TOKEN);
  // Clean URL so refresh/reload doesn't duplicate; keep user's bookmark untouched via replace.
  history.replaceState(null, '', location.pathname + location.hash);
}

function alertBox(text, kind = 'err') {
  const el = $('alert');
  el.className = `msg ${kind}`;
  el.textContent = text;
  if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 2500);
  else el.classList.remove('hidden');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { data, res });
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showCastBar() {
  $('castbar').classList.remove('hidden');
  document.body.classList.add('has-castbar');
}
function hideCastBar() {
  $('castbar').classList.add('hidden');
  document.body.classList.remove('has-castbar');
}

function render() {
  const { guest, categories, costumes, votes, voting } = state;

  $('who').innerHTML = `Voting as <b>${esc(guest.name)}</b>` +
    (state.myCostume ? ` · costume: <b>${esc(state.myCostume.name)}</b>` : '');

  // Guests must be registered before they can be given a ballot.
  if (guest.costume_id == null) {
    hideCastBar();
    $('body').innerHTML = `<div class="card">
      <h2>You're not registered yet</h2>
      <p class="sub">Find the host — they need to take your photo and add you to your costume before you can vote.</p></div>`;
    return;
  }

  if (!voting.open) {
    hideCastBar();
    const notStarted = voting.reason === 'not-opened';
    const heading = notStarted ? 'Voting hasn\'t started yet' : 'Voting is closed';
    const body = notStarted
      ? 'The host is still registering costumes. This page will work as soon as they open voting — just reload.'
      : voting.reason === 'deadline-passed'
        ? 'The deadline has passed. <a href="/results">See the results</a>.'
        : 'The host has closed voting. <a href="/results">See the results</a>.';
    $('body').innerHTML = `<div class="card"><h2>${heading}</h2>
      <p class="sub">${body}</p></div>`;
    $('doneCard').classList.add('hidden');
    return;
  }

  // Grids load the preview only. Strip the HD URL from anything that isn't
  // meant to be tapped, so no stray request can pull the big file.
  const votable = costumes.filter((c) => !c.isOwn);
  const byId = new Map(costumes.map((c) => [c.id, c]));
  const editable = categories.filter((cat) => !votes[cat.key]);

  // Default view: open the first category that still needs a vote, so the
  // guest lands on something to do rather than three shut headers.
  if (!expandedCategory && editable.length) expandedCategory = editable[0].key;

  const pendingCount = editable.filter((cat) => pending[cat.key]).length;

  $('body').innerHTML = `
    <p class="sub intro">
      ${state.remaining === 0
        ? 'All <b>3</b> votes are in. Nice one 🎉 — you can still flick through the costumes.'
        : `Pick a costume in each category — tap one to select it, tap again to deselect. When you're ready, hit <b>Submit</b>. Your votes are final.`}
    </p>
    <div class="ballot">
      ${categories.map((cat) => section(cat, votes, votable, byId)).join('')}
    </div>
    <div class="card" style="margin-top:16px">
      <h3>Your own costume</h3>
      ${thumbCard(state.myCostume, true)}
      <p class="sub" style="margin-top:10px">You can't vote for this one — that's the one rule.</p>
    </div>`;

  $('doneCard').classList.toggle('hidden', state.remaining > 0);

  // Submit bar: spells out exactly how many picks are queued.
  showCastBar();
  $('castBtn').disabled = pendingCount === 0 || submitting;
  if (pendingCount) {
    $('castHint').textContent = `${pendingCount} pick${pendingCount > 1 ? 's' : ''} ready — not submitted yet`;
    $('castBtn').textContent = `Submit ${pendingCount} vote${pendingCount > 1 ? 's' : ''}`;
  } else {
    $('castHint').textContent = state.remaining ? 'Tap a costume to add your first pick.' : 'All votes are in.';
    $('castBtn').textContent = 'Submit';
  }
}

function section(cat, votes, votable, byId) {
  const voted = votes[cat.key];
  const picked = pending[cat.key];
  const locked = !!voted;                       // a submitted vote can't be changed
  const selectedId = voted?.costume_id ?? picked;
  const collapsed = cat.key !== expandedCategory;

  const badge = locked
    ? '<span class="badge ok">voted</span>'
    : picked
      ? '<span class="badge pick">pick set</span>'
      : '<span class="badge">not voted</span>';

  return `<section class="cat ${collapsed ? 'collapsed' : ''}" data-cat="${cat.key}">
    <h2>
      <span class="chev" aria-hidden="true"></span>
      <span class="ttl">${CAT_EMOJI[cat.key] || '🎃'} ${esc(cat.label)}</span>
      ${badge}
    </h2>
    <div class="grid">
      ${votable.map((c) => pickCard(c, c.id === selectedId, locked)).join('')}
    </div>
    ${locked
      ? `<p class="pickline">Your pick: <b>${esc(byId.get(voted.costume_id)?.name || '—')}</b> <span class="final">(final)</span></p>`
      : picked
        ? `<p class="pickline">Selected: <b>${esc(byId.get(picked)?.name || '—')}</b></p>`
        : ''}
  </section>`;
}

function pickCard(c, isChosen, locked) {
  return `<button class="pick ${locked ? 'locked' : ''}" data-vote="${c.id}" aria-pressed="${isChosen}" ${locked ? 'disabled' : ''}>
    ${c.photo
      ? `<img class="thumb zoomable" src="${esc(c.photo)}" alt="${esc(c.name)}" loading="lazy"
              data-hd="${esc(c.photo_hd || c.photo)}" data-caption="${esc(c.name)}">`
      : `<span class="noimg">${EMOJI[c.kind] || '🎭'}</span>`}
    <span class="body">
      <span class="nm">${esc(c.name)}</span>
      <span class="mem">${esc(c.members.join(', '))}</span>
    </span>
  </button>`;
}

function thumbCard(c, isOwn) {
  return `<div class="row" style="align-items:center;gap:12px">
    ${c?.photo
      ? `<img src="${esc(c.photo)}" alt="" loading="lazy" class="zoomable"
              data-hd="${esc(c.photo_hd || c.photo)}" data-caption="${esc(c.name)}"
              style="width:74px;height:74px;object-fit:cover;border-radius:12px">`
      : `<div class="noimg" style="width:74px;height:74px;border-radius:12px">${EMOJI[c?.kind] || '🎭'}</div>`}
    <div style="flex:1;min-width:0">
      <div class="nm"><b>${esc(c?.name || '—')}</b></div>
      <div class="mem">${esc(c?.members?.join(', ') || '')}</div>
    </div>
    ${isOwn ? '<span class="chip self">you</span>' : ''}
  </div>`;
}

async function load() {
  if (!TOKEN) return (location.href = '/');
  try {
    state = await api(`/api/me?token=${encodeURIComponent(TOKEN)}`);
    $('event').textContent = state.event_name || 'Costume Party';
    state.myCostume = state.costumes.find((c) => c.id === state.guest.costume_id) || null;
    renderClose();
    render();
  } catch (e) {
    sessionStorage.removeItem('cv_token');
    hideCastBar();
    $('who').textContent = '';
    $('body').innerHTML = '';
    alertBox(e.message);
    $('alert').innerHTML += ' <a href="/">Try again</a>';
  }
}

function renderClose() {
  const v = state.voting;
  $('closeLine').innerHTML = v.closesAt && v.open
    ? `Closes in <span class="countdown" data-close="${v.closesAt}"></span>`
    : '';
  tick();
}

function tick() {
  const el = document.querySelector('[data-close]');
  if (!el) return;
  const end = new Date(el.dataset.close).getTime();
  const update = () => {
    const s = Math.max(0, Math.floor((end - Date.now()) / 1000));
    el.textContent = `${String(Math.floor(s / 3600)).padStart(2, '0')}:` +
      `${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:` +
      `${String(s % 60).padStart(2, '0')}`;
    if (s === 0) load();
  };
  update();
  clearInterval(window.__tick);
  window.__tick = setInterval(update, 1000);
}

/** Slide a section open/closed. Tapping the header again folds it shut. */
function toggleCategory(key) {
  expandedCategory = expandedCategory === key ? null : key;
  render();
}

/** Commit every staged pick at once. Votes are final the moment this lands. */
async function submitVote() {
  if (submitting) return;
  // Snapshot only the categories that are still un-voted AND currently picked.
  const picks = state.categories
    .filter((cat) => !state.votes[cat.key] && pending[cat.key] != null)
    .map((cat) => ({ category: cat.key, costume_id: pending[cat.key] }));
  if (!picks.length) return;

  submitting = true;
  render();

  try {
    for (const p of picks) {
      try {
        await api('/api/vote', {
          method: 'POST',
          body: { token: TOKEN, category: p.category, costume_id: p.costume_id },
        });
      } catch (e) {
        // Already submitted (a fetch raced) or re-vote on a locked-in category:
        // fall through and let the refreshed state reconcile rather than fail.
        if (e.res?.status !== 409 && e.res?.status !== 403) throw e;
      }
    }
    // Re-read the server's ballot so the UI reflects the committed votes, then
    // drop the staged picks.
    state = await api(`/api/me?token=${encodeURIComponent(TOKEN)}`);
    state.myCostume = state.costumes.find((c) => c.id === state.guest.costume_id) || null;
    pending = {};
    submitting = false;
    renderClose();
    render();
  } catch (e) {
    submitting = false;
    render();
    alertBox(e.message);
  }
}

document.addEventListener('click', (e) => {
  // Tap the category header (or its arrow) to open/close that section.
  const head = e.target.closest('.cat h2');
  if (head) {
    const section = head.closest('.cat');
    toggleCategory(section.dataset.cat);
    return;
  }
  // A tap on the photo itself enlarges it rather than picking it, so the zoom
  // affordance can't cause a mis-pick on a crowded dance floor.
  const zoom = e.target.closest('.thumb.zoomable');
  if (zoom && zoom.dataset.hd) {
    e.preventDefault();
    e.stopPropagation();
    window.costumeLightbox?.open(zoom.dataset.hd, zoom.dataset.caption || zoom.alt);
    return;
  }
  // Tap a costume to stage (or un-stage) a pick — nothing is sent yet.
  const pick = e.target.closest('[data-vote]');
  if (pick) {
    const category = pick.closest('.cat').dataset.cat;
    const id = Number(pick.dataset.vote);
    pending[category] = pending[category] === id ? null : id;
    render();
  }
});

$('castBtn').addEventListener('click', submitVote);

$('signout').addEventListener('click', () => {
  sessionStorage.removeItem('cv_token');
  location.href = '/';
});

// Keep the ballot honest: re-check the timer and roster periodically.
setInterval(async () => {
  try {
    const s = await api('/api/status');
    if (!s.voting.open) return load();
  } catch { /* ignore */ }
}, 20000);

load();
