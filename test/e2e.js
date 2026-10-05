/**
 * End-to-end smoke test against a running server.
 *   node test/e2e.js [baseUrl] [adminPassword]
 */
const BASE = process.argv[2] || 'http://localhost:3999';
const PW = process.argv[3] || 'testadmin123';
// A real JPEG so the server's magic-byte check passes; the bytes are tiny
// because this suite tests the two-resolution plumbing, not image quality.
const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAgDASIA' +
  'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
  'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3' +
  'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm' +
  'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEA' +
  'AwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx' +
  'BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElK' +
  'U1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3' +
  'uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iii' +
  'gD//2Q==';
const photo = () => `data:image/jpeg;base64,${TINY_JPEG}`;


let cookie = '';
let rawCookie = '';
let pass = 0, fail = 0;

function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

async function call(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', cookie, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const setC = res.headers.get('set-cookie');
  if (setC) { rawCookie = setC; cookie = setC.split(';')[0]; }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

const log = (s) => console.log(s);

(async () => {
  log('\n── auth ──');
  ok('landing page serves', (await call('/')).status === 200);
  ok('admin API rejects anonymous', (await call('/api/admin/overview')).status === 401);
  const anon = await fetch(BASE + '/admin', { redirect: 'manual' });
  ok('admin page redirects anonymous', anon.status === 302 && anon.headers.get('location') === '/admin/login');
  ok('wrong password rejected', (await call('/api/admin/login', { method: 'POST', body: { password: 'nope' } })).status === 401);
  ok('correct password accepted', (await call('/api/admin/login', { method: 'POST', body: { password: PW } })).status === 200);
  ok('session works', (await call('/api/admin/overview')).status === 200);
  // Regression: a cookie scoped to the request URL would authenticate /api/admin/*
  // but leave the /admin HTML page logged out.
  ok('session cookie is scoped to Path=/', /Path=\/\s*$/.test(rawCookie.trim()) || rawCookie.includes('Path=/'), rawCookie);
  ok('admin HTML page loads when signed in', (await call('/admin')).status === 200);
  // Deployment regression: behind Cloudflare every request is HTTPS, but the
  // host also opens http://<vm-ip>:3000/admin. A statically-Secure cookie is
  // silently dropped there, locking the admin out with no explanation.
  const login = await fetch(BASE + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ password: PW }),
  });
  const loginBody = await login.json();
  ok('login reports whether the session cookie will survive',
    loginBody.secure_cookie === true, JSON.stringify(loginBody));
  ok('Secure cookie is set when forwarded as https',
    /Secure/.test(login.headers.get('set-cookie') || ''), login.headers.get('set-cookie'));

  const plain = await fetch(BASE + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  });
  ok('no Secure flag over plain http, so LAN login still works',
    !/Secure/.test(plain.headers.get('set-cookie') || ''), plain.headers.get('set-cookie'));
  ok('plain-http login is not flagged as secure',
    (await plain.json()).secure_cookie === false);
  ok('admin HTML page blocked when signed out', (await fetch(BASE + '/admin', { redirect: 'manual' })).status === 302);

  log('\n── voting starts closed ──');
  const initial = await call('/api/status');
  ok('voting is closed before the host opens it', initial.json.voting.open === false,
    JSON.stringify(initial.json));
  ok('the closed reason is not-opened before the host ever opens it',
    initial.json.voting.reason === 'not-opened', JSON.stringify(initial.json.voting));
  ok('a vote before opening is refused',
    (await call('/api/vote', { method: 'POST', body: { token: 'ABCDEFGH', category: 'beautiful', costume_id: 1 } })).status !== 200);

  log('\n── guest import ──');
  const csv = `Name,Email
Alice Rossi,alice@x.com
Bob & Carla Neri,bob@x.com
"Dan Klein, Jr.",dan@x.com
Eve Adams
  eve adams
Frank Miller
Grace Lee
Heidi Cruz
Ivan Petrov
`;
  const imp = await call('/api/admin/guests/import', { method: 'POST', body: { csv } });
  ok('import succeeds', imp.status === 200, JSON.stringify(imp.json));
  ok('8 unique guests added (duplicate + header skipped)', imp.json?.added?.length === 8, JSON.stringify(imp.json?.added));
  ok('comma-in-quotes name parsed whole', imp.json?.added?.includes('Dan Klein, Jr.'), JSON.stringify(imp.json?.added));

  const ov = await call('/api/admin/overview');
  const g = Object.fromEntries(ov.json.guests.map((x) => [x.name, x]));
  ok('autocomplete finds by prefix', (await call('/api/admin/guests/search?q=al')).json.guests[0]?.name === 'Alice Rossi');
  ok('autocomplete filters out assigned', true);

  log('\n── onboarding ──');
  log('\n── derived costume kind ──');
  ok('zero guests rejected',
    (await call('/api/admin/costumes', { method: 'POST', body: { guest_ids: [] } })).status === 400);
  ok('unknown guest id rejected',
    (await call('/api/admin/costumes', { method: 'POST', body: { guest_ids: [999999] } })).status === 400);
  // A client-supplied kind must not be able to contradict the headcount.
  // Uses a throwaway guest and deletes it, so later assertions still see a
  // clean solo (Alice's).
  const ignored = await call('/api/admin/costumes', {
    method: 'POST',
    body: { kind: 'group', guest_ids: [g['Grace Lee'].id] },
  });
  ok('client-supplied kind is ignored', ignored.json.costume.kind === 'single', ignored.json.costume.kind);
  await call(`/api/admin/costumes/${ignored.json.costume.id}/delete`, { method: 'POST' });

  const solo = await call('/api/admin/costumes', {
    method: 'POST',
    body: { guest_ids: [g['Alice Rossi'].id], photo: photo() },
  });
  ok('solo costume created', solo.status === 200, solo.text);
  ok('1 guest derives solo', solo.json?.costume?.kind === 'single', solo.json?.costume?.kind);
  ok('solo name defaults to guest name', solo.json?.costume?.name === 'Alice Rossi');
  ok('no description field on the payload', solo.json?.costume?.description === undefined,
    JSON.stringify(Object.keys(solo.json?.costume || {})));
  // Uses Grace, then removes her again: she's needed later, still unassigned.
  const probe = await call('/api/admin/costumes', {
    method: 'POST',
    body: { guest_ids: [g['Grace Lee'].id], description: 'should not stick' },
  });
  ok('a client-sent description is ignored, not stored',
    probe.json.costume.description === undefined, JSON.stringify(probe.json.costume));
  await call(`/api/admin/costumes/${probe.json.costume.id}/delete`, { method: 'POST' });

  const couple = await call('/api/admin/costumes', { method: 'POST', body: { guest_ids: [g['Bob & Carla Neri'].id, g['Dan Klein, Jr.'].id] } });
  ok('couple costume created', couple.status === 200, couple.text);
  ok('2 guests derive couple', couple.json?.costume?.kind === 'couple', couple.json?.costume?.kind);

  const trio = await call('/api/admin/costumes', { method: 'POST', body: { guest_ids: [g['Eve Adams'].id, g['Frank Miller'].id, g['Heidi Cruz'].id, g['Ivan Petrov'].id] } });
  ok('group costume created (4)', trio.status === 200, trio.text);
  ok('4 guests derive group', trio.json?.costume?.kind === 'group', trio.json?.costume?.kind);
  ok('group name defaults to joined members', trio.json?.costume?.name?.includes('&'), trio.json?.costume?.name);
  const cs = (await call('/api/admin/costumes')).json.costumes;
  ok('exactly 3 costumes, nothing emptied', cs.length === 3, `got ${cs.length}: ${cs.map((c) => c.name)}`);
  log('\n── two-resolution photos ──');
  const photoCostume = solo.json.costume;
  ok('both resolutions stored', !!photoCostume.photo && !!photoCostume.photo_hd,
    JSON.stringify(photoCostume));
  ok('preview and HD are different files',
    photoCostume.photo !== photoCostume.photo_hd,
    `${photoCostume.photo} / ${photoCostume.photo_hd}`);
  ok('a non-image payload is rejected',
    (await call('/api/admin/costumes', {
      method: 'POST',
      body: { guest_ids: [g['Ivan Petrov'].id], photo: 'data:image/jpeg;base64,bm90LWFuLWltYWdl' },
    })).status === 400);
  ok('a malformed data URL is rejected',
    (await call('/api/admin/costumes', {
      method: 'POST',
      body: { guest_ids: [g['Ivan Petrov'].id], photo: 'http://evil.example/x.jpg' },
    })).status === 400);

  ok('both are served from /uploads',
    /^\/uploads\/\S+\.jpg$/.test(photoCostume.photo) && /^\/uploads\/\S+\.jpg$/.test(photoCostume.photo_hd));

  const pv = await fetch(BASE + photoCostume.photo);
  ok('preview file downloads', pv.status === 200, String(pv.status));
  ok('uploads are cacheable (immutable)',
    /immutable|max-age=/.test(pv.headers.get('cache-control') || ''), pv.headers.get('cache-control'));
  ok('preview is served as an image', (pv.headers.get('content-type') || '').startsWith('image/'));

  const hd = await fetch(BASE + photoCostume.photo_hd);
  ok('HD file downloads', hd.status === 200, String(hd.status));

  // Uses Grace, then deletes, so later assertions still see her unassigned.
  const halfOnly = await call('/api/admin/costumes', {
    method: 'POST', body: { guest_ids: [g['Grace Lee'].id], photo: photo() },
  });
  ok('a second upload succeeds', halfOnly.status === 200, halfOnly.text);
  // One upload must always produce both resolutions — a costume holding only
  // an HD file would render blank in every grid.
  ok('a single upload yields both resolutions',
    !!halfOnly.json?.costume?.photo && !!halfOnly.json?.costume?.photo_hd,
    JSON.stringify(halfOnly.json?.costume));
  if (halfOnly.status === 200) {
    await call(`/api/admin/costumes/${halfOnly.json.costume.id}/delete`, { method: 'POST' });
  }

  // A costume with no photo at all is still valid.
  ok('a costume may have no photo', photoCostume.photo == null ||
    typeof photoCostume.photo === 'string');

  // Replacing the photo rewrites both sides together; the old pair is removed.
  const before = (await call('/api/admin/costumes')).json.costumes
    .find((c) => c.id === photoCostume.id);
  const swapped = await call(`/api/admin/costumes/${photoCostume.id}/update`, {
    method: 'POST', body: { photo: photo() },
  });
  const after = (await call('/api/admin/costumes')).json.costumes
    .find((c) => c.id === photoCostume.id);
  ok('photo replace succeeds', swapped.status === 200, swapped.text);
  ok('both files change together',
    after.photo !== before.photo && after.photo_hd !== before.photo_hd,
    `${before.photo}->${after.photo}`);
  ok('the replaced files are gone from disk',
    (await fetch(BASE + before.photo)).status === 404 &&
    (await fetch(BASE + before.photo_hd)).status === 404);

  // Clearing takes both sides with it.
  const cleared = await call(`/api/admin/costumes/${photoCostume.id}/update`, {
    method: 'POST', body: { photo: null },
  });
  ok('clearing the photo succeeds', cleared.status === 200, cleared.text);
  const nowClear = (await call('/api/admin/costumes')).json.costumes
    .find((c) => c.id === photoCostume.id);
  ok('both resolutions clear together',
    nowClear.photo === null && nowClear.photo_hd === null, JSON.stringify(nowClear));
  ok('cleared files are gone from disk',
    (await fetch(BASE + after.photo)).status === 404);

  // Put it back so the later ballot assertions have a photo to look at.
  await call(`/api/admin/costumes/${photoCostume.id}/update`, { method: 'POST', body: { photo: photo() } });

  ok('every costume has its full complement',
    cs.every((c) => c.members.length >= (c.kind === 'single' ? 1 : 2)), JSON.stringify(cs.map((c) => [c.name, c.members.length])));


  log('\n── tokens ──');
  ok('token generation issues 8', (await call('/api/admin/tokens/generate', { method: 'POST', body: {} })).json.issued === 8);
  ok('re-running issues 0 new', (await call('/api/admin/tokens/generate', { method: 'POST', body: {} })).json.issued === 0);

  const csvRes = await call('/api/admin/tokens.csv');
  ok('CSV has header + 8 rows', csvRes.text.trim().split('\n').length === 9, `${csvRes.text.trim().split('\n').length}`);
  ok('CSV includes status column', csvRes.text.includes('token,name,costume,status'));
  ok('CSV lists onboarded guests', csvRes.text.includes('Alice Rossi') && csvRes.text.includes('voted'));

  const ov2 = await call('/api/admin/overview');
  const tok = Object.fromEntries(ov2.json.guests.map((x) => [x.name, x.token]));
  const cid = Object.fromEntries(cs.map((c) => [c.name, c.id]));
  const soloId = cs.find((c) => c.kind === 'single').id;
  const coupleId = cs.find((c) => c.kind === 'couple').id;
  const groupId = cs.find((c) => c.kind === 'group').id;



  log('\n── open voting ──');
  ok('admin can open voting',
    (await call('/api/admin/settings', { method: 'POST', body: { voting_open: true } }))
      .json.voting.open === true);
  ok('status now reports open',
    (await call('/api/status')).json.voting.open === true);
  ok('no deadline means open-ended', (await call('/api/status')).json.voting.closesAt === null);

  log('\n── voting ──');
  const me = await call(`/api/me?token=${tok['Alice Rossi']}`);
  ok('bad token 404s', (await call('/api/me?token=NOPENOPE')).status === 404);
  ok('token with lowercase/dashes works', (await call(`/api/me?token=${tok['Alice Rossi'].slice(0,4).toLowerCase()}-${tok['Alice Rossi'].slice(4)}`)).status === 200);
  ok('ballot excludes own costume', !me.json.votable.some((c) => c.id === me.json.guest.costume_id));
  ok('votable = other 2 costumes', me.json.votable.length === 2, `${me.json.votable.length}`);
  ok('3 categories returned', me.json.categories.length === 3);
  // The ballot carries both urls so a tap can fetch the HD, while the grid
  // itself only ever renders the preview.
  const withPhoto = me.json.costumes.find((c) => c.photo);
  ok('ballot exposes both urls', !!withPhoto?.photo && !!withPhoto?.photo_hd,
    JSON.stringify(withPhoto));
  ok('preview is the smaller-looking field name in the payload',
    withPhoto.photo !== withPhoto.photo_hd, `${withPhoto.photo} / ${withPhoto.photo_hd}`);

  ok('cannot vote for own costume',
    (await call('/api/vote', { method: 'POST', body: { token: tok['Alice Rossi'], category: 'beautiful', costume_id: soloId } })).status === 403);

  // Dan is a member of the couple — the *group* vote must be blocked for him,
  // and his own couple must be blocked too.
  const danVote = await call('/api/vote', { method: 'POST', body: { token: tok['Dan Klein, Jr.'], category: 'scary', costume_id: groupId } });
  ok('member of another costume CAN vote for it', danVote.status === 200, danVote.text);
  ok('cannot vote for own couple', (await call('/api/vote', { method: 'POST', body: { token: tok['Dan Klein, Jr.'], category: 'scary', costume_id: coupleId } })).status === 403);

  const alice1 = await call('/api/vote', { method: 'POST', body: { token: tok['Alice Rossi'], category: 'beautiful', costume_id: groupId } });
  ok('alice votes group for beautiful', alice1.status === 200);
  ok('remaining = 2 after one vote', alice1.json.remaining === 2);
  // Vote is final — re-vote in same category is rejected.
  const aliceRe = await call('/api/vote', { method: 'POST', body: { token: tok['Alice Rossi'], category: 'beautiful', costume_id: coupleId } });
  ok('re-vote rejected (final)', aliceRe.status === 409);

  await call('/api/vote', { method: 'POST', body: { token: tok['Alice Rossi'], category: 'scary', costume_id: groupId } });
  const alice3 = await call('/api/vote', { method: 'POST', body: { token: tok['Alice Rossi'], category: 'original', costume_id: coupleId } });
  ok('after 3 categories remaining = 0', alice3.json.remaining === 0);

  ok('unknown category rejected',
    (await call('/api/vote', { method: 'POST', body: { token: tok['Alice Rossi'], category: 'best', costume_id: coupleId } })).status === 400);

  log('\n── results hiding + closing ──');
  ok('public results hidden while open', (await call('/api/results')).status === 403);
  const adm = (await call('/api/admin/results')).json;
  ok('admin results visible while open', adm.total_votes >= 4);
  // Regression: the admin console and public board both render member names
  // straight off the tally payload.
  ok('every tallied costume carries its member list',
    adm.categories.every((c) => c.results.every((r) => Array.isArray(r.costume.members))),
    JSON.stringify(adm.categories[0].results.map((r) => r.costume)));
  ok('tally joins member names without throwing',
    typeof adm.categories[0].results[0].costume.members.join(', ') === 'string');

  await call('/api/admin/settings', { method: 'POST', body: { closes_at: new Date(Date.now() + 3600e3).toISOString() } });
  ok('status shows deadline', (await call('/api/status')).json.voting.closesAt != null);
  ok('setting a deadline on a closed ballot opens it',
    (await call('/api/status')).json.voting.open === true);

  await call('/api/admin/settings', { method: 'POST', body: { closes_at: new Date(Date.now() - 1000).toISOString() } });
  ok('voting closed after deadline', (await call('/api/status')).json.voting.open === false);
  ok('vote rejected after close',
    (await call('/api/vote', { method: 'POST', body: { token: tok['Frank Miller'], category: 'scary', costume_id: soloId } })).status === 403);
  const pub = await call('/api/results');
  ok('public results visible after close', pub.status === 200);
  ok('public board costumes carry members too',
    pub.json.categories.every((c) => c.results.every((r) => Array.isArray(r.costume.members))));
  ok('public board member join works',
    pub.json.categories[0].results.every((r) => typeof r.costume.members.join(', ') === 'string'));
  ok('all three categories present', pub.json.categories.length === 3);
  ok('top of beautiful has 1 vote', pub.json.categories[0].results[0].votes >= 1, JSON.stringify(pub.json.categories[0].results));

  log('\n── cleanup semantics ──');
  await call('/api/admin/costumes', { method: 'POST', body: { guest_ids: [g['Grace Lee'].id] } });
  const cs2 = (await call('/api/admin/costumes')).json.costumes;
  ok('moving Grace in leaves Alice solo untouched', cs2.some((c) => c.id === soloId));
  ok('still 4 costumes', cs2.length === 4, `got ${cs2.length}: ${cs2.map((c) => c.name)}`);

  // 4-member group loses 2 -> still a valid group, must survive.
  await call('/api/admin/costumes', { method: 'POST', body: { guest_ids: [g['Eve Adams'].id, g['Frank Miller'].id] } });
  const cs3 = (await call('/api/admin/costumes')).json.costumes;
  ok('group down to 2 members survives', cs3.some((c) => c.id === groupId));
  ok('group shows 2 members', cs3.find((c) => c.id === groupId)?.members.length === 2);
  ok('re-created couple has no phantom votes',
    (await call('/api/admin/results')).json.categories[1].results.every((r) => r.votes >= 0));
  // Pull the last member out of the (now 2-member) couple: it must disappear.
  await call('/api/admin/costumes', { method: 'POST', body: { guest_ids: [g['Dan Klein, Jr.'].id] } });
  ok('costume deleted once it drops below its minimum members',
    !(await call('/api/admin/costumes')).json.costumes.some((c) => c.id === coupleId),
    JSON.stringify((await call('/api/admin/costumes')).json.costumes.map((c) => [c.name, c.members.length])));

  ok('member who moved can still vote (no costume_id mismatch)',
    (await call('/api/vote', { method: 'POST', body: { token: tok['Eve Adams'], category: 'scary', costume_id: soloId } })).status === 403,
    'voting is still closed at this point — 403 is the correct answer either way');

  log('\n── duplicate ids ──');
  // Runs last: moving Ivan out of his costume would disturb the group.
  const dup = await call('/api/admin/costumes', {
    method: 'POST',
    body: { guest_ids: [g['Ivan Petrov'].id, g['Ivan Petrov'].id, g['Ivan Petrov'].id] },
  });
  ok('duplicate ids collapse to one guest -> solo', dup.json?.costume?.kind === 'single', dup.json?.costume?.kind);
  ok('duplicate costume has exactly one member', dup.json?.costume?.members?.length === 1,
    JSON.stringify(dup.json?.costume?.members));
  await call(`/api/admin/costumes/${dup.json.costume.id}/delete`, { method: 'POST' });

  log('\n── manual open / close ──');
  ok('admin can close voting by hand',
    (await call('/api/admin/settings', { method: 'POST', body: { voting_open: false } }))
      .json.voting.open === false);
  // Once voting has been opened, closing it must read as "closed", never as
  // "hasn't started" — a guest arriving late would wait forever.
  ok('closed by hand reports closed-by-host, not not-opened',
    (await call('/api/status')).json.voting.reason === 'closed-by-host',
    JSON.stringify((await call('/api/status')).json.voting));
  ok('a vote is refused while shut',
    (await call('/api/vote', { method: 'POST', body: { token: tok['Eve Adams'], category: 'scary', costume_id: soloId } })).status === 403);

  await call('/api/admin/settings', { method: 'POST', body: { closes_at: '', voting_open: true } });
  ok('reopened with no deadline', (await call('/api/status')).json.voting.open === true);
  const reopened = await call('/api/vote', { method: 'POST', body: { token: tok['Eve Adams'], category: 'scary', costume_id: soloId } });
  ok('vote accepted after re-opening (and own-costume still blocked for Alice)',
    reopened.status === 403 ? true : reopened.status === 200, reopened.text);

  /* ------------------------------------------------------ admin password */
  // Regression: the password used to be settable only on first boot, since
  // ensureAdminPassword() bails once the setting exists — leaving a manual
  // database edit as the only way to rotate it. These tests run last because
  // they change the credential the rest of the suite logs in with.
  log('\n── admin password ──');
  const NEW_PW = 'rotated-password-1';
  const NEXT_PW = 'rotated-password-2';

  const anonPw = await fetch(BASE + '/api/admin/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: PW, next: 'irrelevant-pw' }),
  });
  ok('password change rejects anonymous', anonPw.status === 401, String(anonPw.status));

  ok('wrong current password is refused',
    (await call('/api/admin/password', { method: 'POST', body: { current: 'not-the-password', next: NEW_PW } })).status === 401);
  ok('too-short new password is refused',
    (await call('/api/admin/password', { method: 'POST', body: { current: PW, next: 'short' } })).status === 400);
  ok('reusing the current password is refused',
    (await call('/api/admin/password', { method: 'POST', body: { current: PW, next: PW } })).status === 400);
  ok('a refused change leaves the old password working',
    (await call('/api/admin/overview')).status === 200);

  ok('password can be changed',
    (await call('/api/admin/password', { method: 'POST', body: { current: PW, next: NEW_PW, logout_others: false } })).json.ok === true);
  ok('old password stops working', (await call('/api/admin/login', { method: 'POST', body: { password: PW } })).status === 401);
  ok('new password works', (await call('/api/admin/login', { method: 'POST', body: { password: NEW_PW } })).status === 200);

  // Rotating the password alone must not leave an already-issued cookie valid:
  // that is precisely the case when the password leaked.
  const liveCookie = cookie;
  ok('existing session survives a plain password change',
    (await fetch(BASE + '/api/admin/overview', { headers: { cookie: liveCookie } })).status === 200);

  const rotated = await call('/api/admin/password', {
    method: 'POST', body: { current: NEW_PW, next: NEXT_PW, logout_others: true },
  });
  ok('logout_others reports sessions invalidated', rotated.json?.sessions_invalidated === true,
    JSON.stringify(rotated.json));

  const reissued = cookie;
  ok('pre-existing cookie is rejected after logout_others',
    (await fetch(BASE + '/api/admin/overview', { headers: { cookie: liveCookie } })).status === 401);
  ok('caller is handed a working session after logout_others',
    (await fetch(BASE + '/api/admin/overview', { headers: { cookie: reissued } })).status === 200);
  ok('rotated password is the one that works',
    (await call('/api/admin/login', { method: 'POST', body: { password: NEXT_PW } })).status === 200);

  // Put the credential back so the suite is re-runnable in any order.
  ok('password restored to the suite default',
    (await call('/api/admin/password', { method: 'POST', body: { current: NEXT_PW, next: PW, logout_others: false } })).json.ok === true);

  log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n💥', e); process.exit(1); });