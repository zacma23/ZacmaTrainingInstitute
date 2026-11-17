import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Reuse the existing Express application (routes, middleware, services) unchanged.
process.env.TZ = process.env.TZ || 'Africa/Addis_Ababa';
const { app, ensureInitialized } = require('../../server.js');

function sanitizeDbError(err) {
  return String((err && err.message) || 'Unknown database connection error').replace(
    /postgres:\/\/[^@]+@/gi,
    'postgres://***:***@'
  );
}

const server = createServer(async (req, res) => {
  try {
    await ensureInitialized();
  } catch (err) {
    if (!String(req.url || '').startsWith('/api/health')) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: 'Database service unavailable. Verify the Netlify Database connection for this site.',
          code: (err && err.code) || 'DB_INIT_ERROR',
          detail: sanitizeDbError(err),
        })
      );
      return;
    }
  }
  app(req, res);
});

export default server;
