/** Minimal cookie parser + res.cookie helpers (avoids an extra dependency). */

export function cookies(req, res, next) {
  const header = req.headers.cookie || '';
  req.cookies = Object.create(null);
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      req.cookies[k] = decodeURIComponent(v);
    } catch {
      req.cookies[k] = v;
    }
  }
  res.cookie = (name, value, opts = {}) => {
    const bits = [`${name}=${encodeURIComponent(value)}`];
    if (opts.maxAge) bits.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    if (opts.httpOnly) bits.push('HttpOnly');
    if (opts.sameSite) bits.push(`SameSite=${capitalize(opts.sameSite)}`);
    // Always default to Path=/ : the admin session must also authenticate the
    // HTML page at /admin, not just /api/admin/*. Relying on the browser's
    // default path (the request URL) scopes it to /api/admin and breaks /admin.
    bits.push(`Path=${opts.path || '/'}`);
    if (opts.secure) bits.push('Secure');
    const prev = res.getHeader('Set-Cookie');
    const line = bits.join('; ');
    res.setHeader('Set-Cookie', prev ? [].concat(prev, line) : [line]);
    return res;
  };
  res.clearCookie = (name, opts = {}) =>
    res.cookie(name, '', { ...opts, maxAge: 0, path: '/' });
  next();
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);