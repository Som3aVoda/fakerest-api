'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

let database = { movies: [] };
let writeQueue = Promise.resolve();

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(body));
}

function normalizeDatabase(value) {
  if (!value || !Array.isArray(value.movies)) value = { movies: [] };
  const seen = new Set();
  let nextId = value.movies.reduce((max, movie) => {
    const n = Number(movie && movie.id);
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0) + 1;

  for (const movie of value.movies) {
    if (!movie || typeof movie !== 'object') continue;
    let id = String(movie.id ?? '').trim();
    if (!id || seen.has(id)) {
      if (id && !movie.legacy_id) movie.legacy_id = id;
      while (seen.has(String(nextId))) nextId += 1;
      id = String(nextId++);
      movie.id = id;
    }
    seen.add(id);
    // Keep legacy fields intact; new fields are optional and can be added by the admin.
  }
  value.movies = value.movies.filter(movie => movie && typeof movie === 'object');
  return value;
}

async function persist() {
  writeQueue = writeQueue.then(async () => {
    const dir = path.dirname(DB_FILE);
    await fs.promises.mkdir(dir, { recursive: true });
    const temp = `${DB_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(database, null, 2) + '\n', 'utf8');
    await fs.promises.rename(temp, DB_FILE);
  });
  return writeQueue;
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('Request body is too large.');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw new Error('Request body must be valid JSON.'); }
}

function cleanMovie(input, existing = {}) {
  const movie = { ...existing, ...input };
  movie.title = String(movie.title || '').trim();
  if (!movie.title) throw new Error('A movie title is required.');
  for (const field of ['img', 'desc', 'cast', 'url', 'type', 'rel', 'media_type', 'franchise_id']) {
    if (movie[field] !== undefined && movie[field] !== null) movie[field] = String(movie[field]).trim();
  }
  if (Array.isArray(movie.related_ids)) {
    movie.related_ids = [...new Set(movie.related_ids.map(String).map(v => v.trim()).filter(Boolean))];
  } else if (typeof movie.related_ids === 'string') {
    movie.related_ids = [...new Set(movie.related_ids.split(',').map(v => v.trim()).filter(Boolean))];
  } else if (!Array.isArray(existing.related_ids)) {
    movie.related_ids = [];
  }
  if (movie.release_year !== undefined && movie.release_year !== '') {
    const year = Number(movie.release_year);
    if (!Number.isInteger(year) || year < 1888 || year > 2200) throw new Error('Release year must be between 1888 and 2200.');
    movie.release_year = year;
  } else delete movie.release_year;
  for (const field of ['season_number', 'episode_number']) {
    if (movie[field] !== undefined && movie[field] !== '') {
      const number = Number(movie[field]);
      if (!Number.isInteger(number) || number < 1) throw new Error(`${field.replace('_', ' ')} must be a positive number.`);
      movie[field] = number;
    } else delete movie[field];
  }
  return movie;
}

function groupKey(movie) {
  return String(movie.franchise_id || movie.rel || '').trim();
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/health' && req.method === 'GET') {
    return send(res, 200, { status: 'ok', movies: database.movies.length });
  }

  const match = pathname.match(/^\/movies(?:\/([^/]+))?$/);
  if (!match) return send(res, 404, { error: 'Route not found.' });
  const id = match[1] ? decodeURIComponent(match[1]) : null;

  if (req.method === 'GET' && !id) {
    let movies = [...database.movies];
    const q = (url.searchParams.get('q') || '').toLocaleLowerCase();
    const type = (url.searchParams.get('type') || '').toLocaleLowerCase();
    const group = url.searchParams.get('group');
    if (q) movies = movies.filter(m => [m.title, m.desc, m.cast, m.type].some(v => String(v || '').toLocaleLowerCase().includes(q)));
    if (type) movies = movies.filter(m => String(m.type || m.media_type || '').toLocaleLowerCase().includes(type));
    if (group) movies = movies.filter(m => groupKey(m) === group || (m.related_ids || []).includes(group));
    return send(res, 200, movies);
  }

  if (req.method === 'GET' && id) {
    const movie = database.movies.find(m => String(m.id) === id);
    return movie ? send(res, 200, movie) : send(res, 404, { error: 'Movie not found.' });
  }

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (!ADMIN_API_TOKEN || req.headers['x-admin-token'] !== ADMIN_API_TOKEN) {
      return send(res, 401, { error: 'Admin authorization required.' });
    }
  }

  try {
    if (req.method === 'POST' && !id) {
      const payload = await readBody(req);
      const maxId = database.movies.reduce((max, m) => Math.max(max, Number(m.id) || 0), 0);
      const movie = cleanMovie({ ...payload, id: String(maxId + 1) });
      database.movies.push(movie);
      await persist();
      return send(res, 201, movie);
    }

    if (['PUT', 'PATCH'].includes(req.method) && id) {
      const index = database.movies.findIndex(m => String(m.id) === id);
      if (index < 0) return send(res, 404, { error: 'Movie not found.' });
      const payload = await readBody(req);
      const movie = cleanMovie({ ...payload, id }, database.movies[index]);
      database.movies[index] = movie;
      await persist();
      return send(res, 200, movie);
    }

    if (req.method === 'DELETE' && id) {
      const index = database.movies.findIndex(m => String(m.id) === id);
      if (index < 0) return send(res, 404, { error: 'Movie not found.' });
      const [deleted] = database.movies.splice(index, 1);
      // Remove references to the deleted record to avoid dangling manual relationships.
      for (const movie of database.movies) {
        movie.related_ids = (movie.related_ids || []).filter(value => String(value) !== id);
      }
      await persist();
      return send(res, 200, { deleted: true, movie: deleted });
    }
  } catch (error) {
    return send(res, 400, { error: error.message || 'Invalid request.' });
  }

  return send(res, 405, { error: 'Method not allowed.' });
}

(async () => {
  try {
    const raw = await fs.promises.readFile(DB_FILE, 'utf8');
    database = normalizeDatabase(JSON.parse(raw));
    await persist(); // Writes normalized unique IDs back while retaining every record.
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // When using a mounted persistent disk, seed it from the bundled database once.
    try {
      const seed = await fs.promises.readFile(path.join(__dirname, 'db.json'), 'utf8');
      database = normalizeDatabase(JSON.parse(seed));
    } catch {
      database = { movies: [] };
    }
    await persist();
  }
  http.createServer((req, res) => handle(req, res).catch(() => send(res, 500, { error: 'Internal server error.' })))
    .listen(PORT, () => console.log(`TVHOME API listening on ${PORT}; ${database.movies.length} movies loaded.`));
})();
