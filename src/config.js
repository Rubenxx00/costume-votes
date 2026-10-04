import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const VIEWS_DIR = path.join(ROOT, 'views');
export const PUBLIC_DIR = path.join(ROOT, 'public');

export const PORT = Number(process.env.PORT || 3000);

// Set once on first boot (or via env) — used to sign the admin session cookie.
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
export const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
export const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

/**
 * Two resolutions of every costume photo. The preview is what a 50-card
 * ballot loads; the HD version is fetched only when someone taps to enlarge.
 *
 * Sized for phones: 400px fills a ballot tile at 2x, and 1600px is a
 * full-screen portrait at 2x without wasting bandwidth on camera originals.
 */
export const PHOTO_SIZES = {
  preview: { max: 400, quality: 72 },
  hd: { max: 1600, quality: 85 },
};

/** Uploads are re-encoded to JPEG, so anything decodable is fair game. */
export const PHOTO_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;