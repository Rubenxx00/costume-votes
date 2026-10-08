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
    document.title = `${s.event_name || 'Costume Party'} · Vota`;
    const box = $('status');
    box.classList.remove('hidden');
    if (s.voting.open) {
      box.innerHTML = s.voting.closesAt
        ? `<h3>Votazioni aperte</h3><p class="sub">Chiudono tra <span class="countdown" data-close="${s.voting.closesAt}"></span></p>`
        : `<h3>Votazioni aperte</h3><p class="sub">L'host chiuderà le votazioni dalla console admin.</p>`;
      tick();
    } else if (s.voting.reason === 'not-opened') {
      box.innerHTML = `<h3>Le votazioni non sono ancora iniziate</h3>
        <p class="sub">Tieniti pronto :)</p>`;
    } else if (s.voting.reason === 'closed-by-host') {
      box.innerHTML = `<h3>Le votazioni sono chiuse</h3>
        <p class="sub">Grazie per aver votato — i risultati sono sul proiettore, oppure <a href="/results">apri la bacheca</a>.</p>`;
    } else {
      box.innerHTML = `<h3>Le votazioni si sono chiuse</h3>
        <p class="sub">Guarda il proiettore per i risultati — oppure <a href="/results">apri la bacheca dei risultati</a>.</p>`;
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
  if (token.length < 6) return msg('Digita il codice di 8 caratteri della tua card.');
  // Preserve the readable form: K7F2-9QX4
  const pretty = token.length === 8 ? `${token.slice(0, 4)}-${token.slice(4)}` : token;
  sessionStorage.setItem('cv_token', pretty);
  location.href = '/vote';
}

$('go').addEventListener('click', submit);
$('token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit();
});
// Token input lives inside a collapsed <details> — don't auto-focus a hidden field.

// Returning from /vote? — send them straight back to their ballot.
// Stored tokens are only as trustworthy as this device, so the ballot itself
// re-verifies with the server and falls back here on a bad token.
if (sessionStorage.getItem('cv_token')) location.replace('/vote');

poll();
setInterval(poll, 30000);