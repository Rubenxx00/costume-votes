const $ = (id) => document.getElementById(id);
const msg = (text, kind = 'err') => {
  const el = $('msg');
  el.className = `msg ${kind}`;
  el.textContent = text;
};

function normalize(t) {
  return String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

async function poll() {
  try {
    const s = await (await fetch('/api/status')).json();
    $('event').textContent = s.event_name || 'Costume Party';
    document.title = `${s.event_name || 'Costume Party'} · Vote`;
    const box = $('status');
    box.classList.remove('hidden');
    if (s.voting.open) {
      box.innerHTML = s.voting.closesAt
        ? `<h3>Voting is open</h3><p class="sub">Closes <span class="countdown" data-close="${s.voting.closesAt}"></span></p>`
        : `<h3>Voting is open</h3><p class="sub">The host will close voting from the admin console.</p>`;
      tick();
    } else if (s.voting.reason === 'not-opened') {
      box.innerHTML = `<h3>Voting hasn't started yet</h3>
        <p class="sub">The host is still getting everyone registered — keep your token handy.</p>`;
    } else if (s.voting.reason === 'closed-by-host') {
      box.innerHTML = `<h3>Voting is closed</h3>
        <p class="sub">Thanks for voting — the results are on the projector, or <a href="/results">open the board</a>.</p>`;
    } else {
      box.innerHTML = `<h3>Voting has closed</h3>
        <p class="sub">Check the projector for the results — or <a href="/results">open the results board</a>.</p>`;
    }
  } catch {
    /* offline at the venue: stay quiet, the host can still hand out tokens */
  }
}

function tick() {
  const el = document.querySelector('[data-close]');
  if (!el) return;
  const end = new Date(el.dataset.close).getTime();
  const update = () => {
    const s = Math.max(0, Math.floor((end - Date.now()) / 1000));
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    el.textContent = `${h}:${m}:${sec}`;
    if (s === 0) location.reload();
  };
  update();
  setInterval(update, 1000);
}

function submit() {
  const token = normalize($('token').value);
  if (token.length < 6) return msg('Type the 8-character code from your card.');
  // Preserve the readable form: K7F2-9QX4
  const pretty = token.length === 8 ? `${token.slice(0, 4)}-${token.slice(4)}` : token;
  sessionStorage.setItem('cv_token', pretty);
  location.href = '/vote';
}

$('go').addEventListener('click', submit);
$('token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit();
});
$('token').focus();

// Returning from /vote? — send them straight back to their ballot.
// Stored tokens are only as trustworthy as this device, so the ballot itself
// re-verifies with the server and falls back here on a bad token.
if (sessionStorage.getItem('cv_token')) location.replace('/vote');

poll();
setInterval(poll, 30000);