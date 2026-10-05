const $ = (id) => document.getElementById(id);
const EMOJI = { single: '🧍', couple: '💞', group: '👥' };

let TOKEN = sessionStorage.getItem('cv_token') || '';
let state = null;
let expandedCategory = null;
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

function render() {
  const { guest, categories, costumes, votes, voting } = state;

  $('who').innerHTML = `Voting as <b>${esc(guest.name)}</b>` +
    (state.myCostume ? ` · costume: <b>${esc(state.myCostume.name)}</b>` : '');

  // Guests must be registered before they can be given a ballot.
  if (guest.costume_id == null) {
    $('body').innerHTML = `<div class="card">
      <h2>You're not registered yet</h2>
      <p class="sub">Find the host — they need to take your photo and add you to your costume before you can vote.</p></div>`;
    return;
  }

  if (!voting.open) {
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

  $('body').innerHTML = `
    <p class="sub" style="margin:-4px 0 14px">
      ${state.remaining === 0
        ? 'All three votes cast. You can still change them until voting closes.'
        : `You have <b>${state.remaining}</b> vote${state.remaining === 1 ? '' : 's'} left. Tap a costume to cast it — tapping again clears it.`}
    </p>
    <div class="ballot">
      ${categories.map((cat) => {
        const chosen = votes[cat.key];
        const collapsed = cat.key !== expandedCategory;
        return `<section class="cat ${collapsed ? 'collapsed' : ''}" data-cat="${cat.key}">
          <h2>${EMOJI[cat.key === 'beautiful' ? 'single' : cat.key === 'scary' ? 'group' : 'couple']}
              ${esc(cat.label)}
            ${chosen ? '<span class="badge ok">voted</span>' : '<span class="badge">not voted</span>'}
          </h2>
          <div class="grid">
            ${votable.map((c) => card(c, chosen?.costume_id === c.id)).join('')}
          </div>
          ${chosen ? `<p class="sub" style="margin-top:10px">
            Your pick: <b>${esc(byId.get(chosen.costume_id)?.name || '—')}</b>
            <button class="small" data-undo="${cat.key}">Clear</button></p>` : ''}
        </section>`;
      }).join('')}
    </div>
    <div class="card" style="margin-top:16px">
      <h3>Your own costume</h3>
      ${thumbCard(state.myCostume, true)}
      <p class="sub" style="margin-top:10px">You can't vote for this one — that's the one rule.</p>
    </div>`;

  $('doneCard').classList.toggle('hidden', state.remaining > 0);

  // If a category is expanded, ensure its section is not collapsed
  if (expandedCategory) {
    const expandedEl = document.querySelector('.cat[data-cat="' + expandedCategory + '"]');
    if (expandedEl) expandedEl.classList.remove('collapsed');
  }
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

function card(c, isChosen) {
  // The preview is what every ballot loads; photo_hd is only read on tap.
  return `<button class="pick" data-cat-card="${c.id}" data-vote="${c.id}" aria-pressed="${isChosen}">
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

async function vote(category, costumeId) {
  try {
    const out = await api('/api/vote', {
      method: 'POST',
      body: { token: TOKEN, category, costume_id: costumeId },
    });
    state.ballot = out.ballot;
    state.costumes = out.ballot.costumes;
    state.votes = out.ballot.votes;
    state.remaining = out.remaining;
    state.myCostume = state.costumes.find((c) => c.id === state.guest.costume_id) || null;
    // The cast vote — its section folds back shut.
    expandedCategory = null;
    render();
  } catch (e) {
    alertBox(e.message);
    if (e.res?.status === 403) load();
  }
}

document.addEventListener('click', (e) => {
  // Tap the category header to enlarge that category's section.
  const head = e.target.closest('.cat h2');
  if (head) {
    e.preventDefault();
    const section = head.closest('.cat');
    expandedCategory = section.dataset.cat;
    render();
    return;
  }
  // A tap on the photo itself enlarges it rather than voting, so the zoom
  // affordance can't cause a mis-vote on a crowded dance floor.
  const zoom = e.target.closest('.thumb.zoomable');
  if (zoom && zoom.dataset.hd) {
    e.preventDefault();
    e.stopPropagation();
    window.costumeLightbox?.open(zoom.dataset.hd, zoom.dataset.caption || zoom.alt);
    return;
  }
  const voteBtn = e.target.closest('[data-vote]');
  if (voteBtn) {
    const category = voteBtn.closest('[data-cat]').dataset.cat;
    const id = Number(voteBtn.dataset.vote);
    return vote(category, id);
  }
});

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