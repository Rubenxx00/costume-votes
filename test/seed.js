/**
 * Seeds a demo party on a running server so the UI can be eyeballed:
 *   node test/seed.js [baseUrl] [adminPassword]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://localhost:4400';
const PW = process.argv[3] || 'demo1234';
const HERE = path.dirname(fileURLToPath(import.meta.url));

let cookie = '';
async function call(p, o = {}) {
  const r = await fetch(BASE + p, {
    ...o,
    headers: { 'Content-Type': 'application/json', cookie, ...(o.headers || {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* html */ }
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${t.slice(0, 200)}`);
  return j;
}

// A 2x2 JPEG generated inline so the demo has no binary fixture in git.
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

const NAMES = ['Alice Rossi', 'Bob Neri', 'Carla Neri', 'Dan Klein', 'Eve Adams',
  'Frank Miller', 'Grace Lee', 'Heidi Cruz', 'Ivan Petrov', 'Julia Conti'];

await call('/api/admin/login', { method: 'POST', body: { password: PW } });
await call('/api/admin/guests/import', { method: 'POST', body: { csv: NAMES.join('\n') } });
await call('/api/admin/settings', { method: 'POST', body: { event_name: 'Halloween Costume Party' } });

const ov = await call('/api/admin/overview');
const g = Object.fromEntries(ov.guests.map((x) => [x.name, x.id]));
// One upload; the server derives the preview and HD pair from it.
const photo = `data:image/jpeg;base64,${TINY_JPEG}`;

// No type is sent: the server derives solo/couple/group from the headcount.
const cast = [
  [['Alice Rossi'], 'The Red Queen'],
  [['Bob Neri', 'Carla Neri'], 'Romeo & Juliet'],
  [['Dan Klein', 'Eve Adams', 'Frank Miller', 'Heidi Cruz', 'Ivan Petrov'], 'The Scooby Gang'],
  [['Grace Lee', 'Ivan Petrov'], 'The Penguins'],
];
for (const [members, name] of cast) {
  await call('/api/admin/costumes', {
    method: 'POST',
    body: { guest_ids: members.map((m) => g[m]), name, photo },
  });
}

await call('/api/admin/tokens/generate', { method: 'POST', body: {} });

// A spread of votes so the results board has something to show.
const { guests } = await call('/api/admin/overview');
const costumes = (await call('/api/admin/costumes')).costumes;
let i = 0;
for (const guest of guests) {
  if (i % 4 === 3) continue;                       // some guests abstain
  for (const cat of ['beautiful', 'scary', 'original']) {
    const options = costumes.filter((c) => c.id !== guest.costume_id);
    const pick = options[(i * 7 + cat.length) % options.length];
    await call('/api/vote', {
      method: 'POST',
      body: { token: guest.token, category: cat, costume_id: pick.id },
    });
  }
  i++;
}

const tokens = Object.fromEntries(guests.map((x) => [x.name, x.token]));
fs.writeFileSync(path.join(HERE, 'demo-tokens.json'), JSON.stringify(tokens, null, 2));
console.log('seeded. tokens →', path.join(HERE, 'demo-tokens.json'));
for (const [n, t] of Object.entries(tokens)) console.log(`  ${n.padEnd(14)} ${t.slice(0, 4)}-${t.slice(4)}`);