// Video Editor Service: the "cloud" editor that the app's VIDEO_EDITOR_API_URL points to.
// Runs on any server that has ffmpeg (Docker image in this folder). Same contract the app already uses:
//   POST /edit   Authorization: Bearer <VIDEO_EDITOR_API_KEY>   body { input_url, edit }  ->  { output_url }
//   POST /render-game   same key   body { game:{title,banner_image}, variant, spec }  ->  { output_url }  (game clips)
//   GET  /files/<id>.mp4   public, so Facebook / Telegram / Discord can fetch the finished video
//   GET  /health
// The edit itself comes from src/lib/app/video.ts (the same code the app uses), so both always agree.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFfmpegArgs, buildGameClipArgs, classifyMediaInput, validateEditSpec } from '../src/lib/app/video.ts';
import { ctaFor } from '../src/lib/app/gameVideo.ts';

const PORT = Number(process.env.PORT) || 8787;
const API_KEY = (process.env.VIDEO_EDITOR_API_KEY ?? '').trim();
// Render sets RENDER_EXTERNAL_URL by itself, so a one-click Render deploy needs no PUBLIC_BASE_URL.
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
const FFMPEG = (process.env.FFMPEG_PATH ?? '').trim() || 'ffmpeg';
const OUT_DIR = (process.env.VIDEO_OUT_DIR ?? '').trim() || join(tmpdir(), 'video-editor-service');
const EDIT_TIMEOUT_MS = Math.min(110_000, Math.max(10_000, Number(process.env.EDIT_TIMEOUT_MS) || 100_000));
const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;
const RETENTION_MS = 24 * 3600 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RENDER_BODY_BYTES = 22 * 1024 * 1024; // a game banner can be sent inline (up to 15 MB)
const MAX_BANNER_BYTES = 15 * 1024 * 1024;
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
// Testing only: lets the input and output use plain http on a local test server. Refused in production.
const ALLOW_HTTP = process.env.ALLOW_HTTP_INPUT === '1';
const FONT_FILES = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf'];

function fail(msg) { console.error(`[video-editor-service] ${msg}`); process.exit(1); }
if (API_KEY.length < 24) fail('VIDEO_EDITOR_API_KEY is missing or too short (use at least 24 random characters).');
if (ALLOW_HTTP && process.env.NODE_ENV === 'production') fail('ALLOW_HTTP_INPUT is for local testing only; remove it in production.');
if (!PUBLIC_BASE) fail('PUBLIC_BASE_URL is missing (the public https address of this service, e.g. https://video.example.com).');
if (!ALLOW_HTTP && !/^https:\/\//i.test(PUBLIC_BASE)) fail('PUBLIC_BASE_URL must start with https://');

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

function authorized(req) {
  const given = Buffer.from(req.headers.authorization ?? '');
  const want = Buffer.from(`Bearer ${API_KEY}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Request body too big.'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

async function findFont() {
  const env = (process.env.VIDEO_FONT_FILE ?? '').trim();
  if (env) return env;
  for (const f of FONT_FILES) { try { await access(f); return f; } catch { /* next */ } }
  return '';
}

function runFfmpeg(args) {
  return new Promise((resolve) => {
    let err = '';
    let timedOut = false;
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, EDIT_TIMEOUT_MS);
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, err: e.message, timedOut: false }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, err, timedOut }); });
  });
}

// One edit at a time: a small server should not run several ffmpeg jobs at once.
let queue = Promise.resolve();
const oneAtATime = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => undefined); return run; };

async function edit(body) {
  const spec = validateEditSpec(body.edit ?? {});
  if (!spec.ok) return { status: 400, error: spec.error };
  if (spec.spec.kind === 'image') return { status: 400, error: 'Game banner clips are rendered on the main server, not here.' };
  const media = classifyMediaInput(body.input_url, '');
  if (!media.ok || media.input.kind !== 'url') return { status: 400, error: 'input_url must be a public http(s) video link.' };
  if (!ALLOW_HTTP && !media.input.value.startsWith('https://')) return { status: 400, error: 'input_url must be https.' };

  await mkdir(OUT_DIR, { recursive: true });
  const id = randomBytes(16).toString('hex');
  const output = join(OUT_DIR, `${id}.mp4`);
  const fontFile = await findFont();
  const warnings = [];

  return oneAtATime(async () => {
    const attempt = (withText) => runFfmpeg(buildFfmpegArgs({
      input: media.input.value, output, spec: spec.spec, withText, fontFile, isUrl: true,
    }).args);
    let r = await attempt(true);
    if (r.code !== 0 && !r.timedOut && spec.spec.overlay_text) {
      // Same fallback as the app: the text filter is the usual missing piece, so edit without it and say so.
      r = await attempt(false);
      if (r.code === 0) warnings.push('Text overlay could not be burned in; the video was edited without it.');
    }
    if (r.timedOut) { await unlink(output).catch(() => undefined); return { status: 504, error: `ffmpeg timed out after ${Math.round(EDIT_TIMEOUT_MS / 1000)}s` }; }
    if (r.code !== 0) { await unlink(output).catch(() => undefined); return { status: 422, error: `ffmpeg failed: ${r.err.trim().split('\n').slice(-3).join(' | ').slice(0, 400) || `exit ${r.code}`}` }; }
    const st = await stat(output).catch(() => null);
    if (!st || st.size < 1024) return { status: 422, error: 'ffmpeg produced no usable output.' };
    if (st.size > MAX_OUTPUT_BYTES) { await unlink(output).catch(() => undefined); return { status: 413, error: 'Edited video is too big.' }; }
    return { status: 200, body: { ok: true, output_url: `${PUBLIC_BASE}/files/${id}.mp4`, warnings } };
  });
}


// Saves a game banner to a temp file: an inline data URL (the app's format) or a public https image link.
async function saveBanner(banner, base) {
  const warnings = [];
  const src = (typeof banner === 'string' ? banner : '').trim();
  if (!src) return { path: null, warnings };
  const fs = await import('node:fs/promises');
  try {
    const data = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(src);
    let buf = null;
    let ext = null;
    if (data) {
      ext = IMAGE_EXT[data[1].toLowerCase()] ?? null;
      buf = Buffer.from(data[2], 'base64');
    } else {
      const media = classifyMediaInput(src, '');
      if (media.ok && media.input.kind === 'url' && (ALLOW_HTTP || media.input.value.startsWith('https://'))) {
        const res = await fetch(media.input.value, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
        ext = IMAGE_EXT[(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()] ?? null;
        if (res.ok && ext) buf = Buffer.from(await res.arrayBuffer());
      }
    }
    if (!ext || !buf) { warnings.push('Banner is not a usable image — used a plain background instead.'); return { path: null, warnings }; }
    if (!buf.length || buf.length > MAX_BANNER_BYTES) { warnings.push('Banner image is empty or too big — used a plain background instead.'); return { path: null, warnings }; }
    const file = `${base}.${ext}`;
    await fs.writeFile(file, buf);
    return { path: file, warnings };
  } catch (e) {
    warnings.push(`Banner could not be loaded (${String(e.message).slice(0, 80)}) — used a plain background instead.`);
    return { path: null, warnings };
  }
}

// Game clip: a short vertical video made from a game's banner (the same clip the app would make locally).
async function renderGame(body) {
  const game = body.game && typeof body.game === 'object' ? body.game : {};
  const title = typeof game.title === 'string' ? game.title.trim().slice(0, 120) : '';
  const spec = validateEditSpec(body.spec ?? {});
  if (!spec.ok) return { status: 400, error: spec.error };
  const variant = Math.max(0, Math.trunc(Number(body.variant) || 0));
  await mkdir(OUT_DIR, { recursive: true });
  const id = randomBytes(16).toString('hex');
  const output = join(OUT_DIR, `${id}.mp4`);
  const fontFile = await findFont();

  return oneAtATime(async () => {
    const banner = await saveBanner(game.banner_image, join(OUT_DIR, `${id}-banner`));
    const warnings = [...banner.warnings];
    try {
      const build = (withText) => buildGameClipArgs({
        ...(banner.path ? { imagePath: banner.path } : {}),
        output,
        durationSec: spec.spec.duration_sec ?? 12,
        title: spec.spec.title_text ?? title,
        ...(spec.spec.overlay_text ? { tagline: spec.spec.overlay_text } : {}),
        cta: ctaFor(variant),
        fontFile,
        withText,
      }).args;
      let r = await runFfmpeg(build(true));
      if (r.code !== 0 && !r.timedOut) {
        r = await runFfmpeg(build(false));
        if (r.code === 0) warnings.push('Text could not be burned in (no drawtext/font support in this ffmpeg) — the video has no title text.');
      }
      if (r.timedOut) { await unlink(output).catch(() => undefined); return { status: 504, error: `ffmpeg timed out after ${Math.round(EDIT_TIMEOUT_MS / 1000)}s` }; }
      if (r.code !== 0) { await unlink(output).catch(() => undefined); return { status: 422, error: `ffmpeg failed: ${r.err.trim().split('\n').slice(-3).join(' | ').slice(0, 400) || `exit ${r.code}`}` }; }
      const st = await stat(output).catch(() => null);
      if (!st || st.size < 1024) return { status: 422, error: 'ffmpeg produced no usable output.' };
      return { status: 200, body: { ok: true, output_url: `${PUBLIC_BASE}/files/${id}.mp4`, warnings } };
    } finally {
      if (banner.path) await unlink(banner.path).catch(() => undefined);
    }
  });
}

const FILE_RE = /^[a-f0-9]{32}\.mp4$/;

async function serveFile(req, res, name) {
  if (!FILE_RE.test(name)) return json(res, 404, { error: 'Not found' });
  const path = join(OUT_DIR, name);
  const st = await stat(path).catch(() => null);
  if (!st) return json(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=86400' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(path).pipe(res);
}

async function cleanup() {
  const now = Date.now();
  for (const f of await readdir(OUT_DIR).catch(() => [])) {
    if (!FILE_RE.test(f)) continue;
    const st = await stat(join(OUT_DIR, f)).catch(() => null);
    if (st && now - st.mtimeMs > RETENTION_MS) await unlink(join(OUT_DIR, f)).catch(() => undefined);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true });
    if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/files/')) return serveFile(req, res, path.slice('/files/'.length));
    if (req.method === 'POST' && path === '/edit') {
      if (!authorized(req)) return json(res, 401, { error: 'Wrong or missing API key.' });
      const body = await readBody(req);
      const r = await edit(body);
      return json(res, r.status, r.body ?? { error: r.error });
    }
    if (req.method === 'POST' && path === '/render-game') {
      if (!authorized(req)) return json(res, 401, { error: 'Wrong or missing API key.' });
      const body = await readBody(req, MAX_RENDER_BODY_BYTES);
      const r = await renderGame(body);
      return json(res, r.status, r.body ?? { error: r.error });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e.status ?? 500;
    if (status === 500) console.error(e);
    return json(res, status, { error: status === 500 ? 'Server error.' : e.message });
  }
});

await mkdir(OUT_DIR, { recursive: true });
setInterval(cleanup, 60 * 60 * 1000).unref();
server.listen(PORT, () => console.log(`[video-editor-service] listening on :${PORT}, outputs in ${OUT_DIR}`));
