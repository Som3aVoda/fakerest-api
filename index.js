
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is missing from Render Environment.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

      while (seen.has(String(nextId))) nextId++;

      id = String(nextId++);
      movie.id = id;
    }

    seen.add(id);
  }

  value.movies = value.movies.filter(
    movie => movie && typeof movie === 'object'
  );

  return value;
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS movies (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL
    )
  `);

  const count = await pool.query(
    'SELECT COUNT(*) FROM movies'
  );

  if (Number(count.rows[0].count) === 0) {
    const file = path.join(__dirname, 'db.json');

    if (fs.existsSync(file)) {
      const raw = await fs.promises.readFile(file, 'utf8');
      const database = normalizeDatabase(JSON.parse(raw));

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        for (const movie of database.movies) {
          await client.query(
            `INSERT INTO movies (id, data)
             VALUES ($1, $2)
             ON CONFLICT (id) DO NOTHING`,
            [String(movie.id), JSON.stringify(movie)]
          );
        }

        await client.query('COMMIT');
        console.log(`Imported ${database.movies.length} records from db.json.`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  }

  console.log('PostgreSQL database is ready.');
}

async function readBody(req) {
  let raw = '';

  for await (const chunk of req) {
    raw += chunk;

    if (raw.length > 1000000) {
      throw new Error('Request body is too large.');
    }
  }

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function cleanMovie(input, existing = {}) {
  const movie = { ...existing, ...input };

  movie.title = String(movie.title || '').trim();

  if (!movie.title) {
    throw new Error('A movie title is required.');
  }

  for (const field of [
    'img', 'desc', 'cast', 'url', 'type', 'rel',
    'media_type', 'franchise_id'
  ]) {
    if (movie[field] !== undefined && movie[field] !== null) {
      movie[field] = String(movie[field]).trim();
    }
  }

  if (Array.isArray(movie.related_ids)) {
    movie.related_ids = [
      ...new Set(
        movie.related_ids.map(String).map(v => v.trim()).filter(Boolean)
      )
    ];
  } else if (typeof movie.related_ids === 'string') {
    movie.related_ids = [
      ...new Set(
        movie.related_ids.split(',').map(v => v.trim()).filter(Boolean)
      )
    ];
  } else if (!Array.isArray(existing.related_ids)) {
    movie.related_ids = [];
  }

  if (movie.release_year !== undefined && movie.release_year !== '') {
    const year = Number(movie.release_year);

    if (!Number.isInteger(year) || year < 1888 || year > 2200) {
      throw new Error('Release year must be between 1888 and 2200.');
    }

    movie.release_year = year;
  } else {
    delete movie.release_year;
  }

  for (const field of ['season_number', 'episode_number']) {
    if (movie[field] !== undefined && movie[field] !== '') {
      const number = Number(movie[field]);

      if (!Number.isInteger(number) || number < 1) {
        throw new Error(`${field.replace('_', ' ')} must be a positive number.`);
      }

      movie[field] = number;
    } else {
      delete movie[field];
    }
  }

  return movie;
}

function groupKey(movie) {
  return String(movie.franchise_id || movie.rel || '').trim();
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    return send(res, 204, {});
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/health' && req.method === 'GET') {
    const result = await pool.query('SELECT COUNT(*) FROM movies');

    return send(res, 200, {
      status: 'ok',
      movies: Number(result.rows[0].count),
      database: 'PostgreSQL'
    });
  }

  const match = pathname.match(/^\/movies(?:\/([^/]+))?$/);

  if (!match) {
    return send(res, 404, { error: 'Route not found.' });
  }

  const id = match[1]
    ? decodeURIComponent(match[1])
    : null;

  if (req.method === 'GET' && !id) {
    const result = await pool.query(
      `SELECT data FROM movies
       ORDER BY
       CASE WHEN id ~ '^[0-9]+$' THEN id::numeric END NULLS LAST,
       id`
    );

    let movies = result.rows.map(row => row.data);

    const q = (url.searchParams.get('q') || '').toLocaleLowerCase();
    const type = (url.searchParams.get('type') || '').toLocaleLowerCase();
    const group = url.searchParams.get('group');

    if (q) {
      movies = movies.filter(movie =>
        [movie.title, movie.desc, movie.cast, movie.type]
          .some(value =>
            String(value || '').toLocaleLowerCase().includes(q)
          )
      );
    }

    if (type) {
      movies = movies.filter(movie =>
        String(movie.type || movie.media_type || '')
          .toLocaleLowerCase().includes(type)
      );
    }

    if (group) {
      movies = movies.filter(movie =>
        groupKey(movie) === group ||
        (movie.related_ids || []).includes(group)
      );
    }

    return send(res, 200, movies);
  }

  if (req.method === 'GET' && id) {
    const result = await pool.query(
      'SELECT data FROM movies WHERE id = $1',
      [id]
    );

    return result.rowCount
      ? send(res, 200, result.rows[0].data)
      : send(res, 404, { error: 'Movie not found.' });
  }

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (!ADMIN_API_TOKEN ||
        req.headers['x-admin-token'] !== ADMIN_API_TOKEN) {
      return send(res, 401, {
        error: 'Admin authorization required.'
      });
    }
  }

  try {
    if (req.method === 'POST' && !id) {
      const payload = await readBody(req);

      const result = await pool.query(
        `SELECT id FROM movies
         WHERE id ~ '^[0-9]+$'
         ORDER BY id::numeric DESC
         LIMIT 1`
      );

      const maxId = result.rowCount
        ? Number(result.rows[0].id)
        : 0;

      const movie = cleanMovie({
        ...payload,
        id: String(maxId + 1)
      });

      await pool.query(
        'INSERT INTO movies (id, data) VALUES ($1, $2)',
        [movie.id, JSON.stringify(movie)]
      );

      return send(res, 201, movie);
    }

    if (['PUT', 'PATCH'].includes(req.method) && id) {
      const result = await pool.query(
        'SELECT data FROM movies WHERE id = $1',
        [id]
      );

      if (!result.rowCount) {
        return send(res, 404, { error: 'Movie not found.' });
      }

      const payload = await readBody(req);

      const movie = cleanMovie(
        { ...payload, id },
        result.rows[0].data
      );

      await pool.query(
        'UPDATE movies SET data = $2 WHERE id = $1',
        [id, JSON.stringify(movie)]
      );

      return send(res, 200, movie);
    }

    if (req.method === 'DELETE' && id) {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const result = await client.query(
          'DELETE FROM movies WHERE id = $1 RETURNING data',
          [id]
        );

        if (!result.rowCount) {
          await client.query('ROLLBACK');
          return send(res, 404, { error: 'Movie not found.' });
        }

        await client.query(
          `UPDATE movies
           SET data = jsonb_set(
             data,
             '{related_ids}',
             COALESCE(
               (
                 SELECT jsonb_agg(value)
                 FROM jsonb_array_elements_text(
                   COALESCE(data->'related_ids', '[]'::jsonb)
                 ) AS value
                 WHERE value <> $1
               ),
               '[]'::jsonb
             )
           )
           WHERE data ? 'related_ids'`,
          [id]
        );

        await client.query('COMMIT');

        return send(res, 200, {
          deleted: true,
          movie: result.rows[0].data
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

  } catch (error) {
    console.error(error);

    if (error.code === '23505') {
      return send(res, 409, { error: 'This ID already exists.' });
    }

    return send(res, 400, {
      error: error.message || 'Invalid request.'
    });
  }

  return send(res, 405, { error: 'Method not allowed.' });
}

async function start() {
  await initializeDatabase();

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      console.error('Request error:', error);

      if (!res.headersSent) {
        send(res, 500, { error: 'Internal server error.' });
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`TVHOME PostgreSQL API listening on ${PORT}.`);
  });
}

start().catch(error => {
  console.error('Startup failed:', error);
  process.exit(1);
});
