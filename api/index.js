const { app, ensureInitialized } = require('../server');

function sanitizeDbError(err) {
  const msg = String((err && err.message) || 'Unknown database connection error');
  return msg
    .replace(/(mysql|mariadb):\/\/[^@/\s]+@/gi, '$1://***:***@')
    .replace(/(password|pwd)=([^&\s;]+)/gi, '$1=***');
}

function normalizeVercelUrl(req) {
  const rawUrl = String(req.url || '/');
  const qIdx = rawUrl.indexOf('?');
  const pathOnly = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const search = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '';
  const params = new URLSearchParams(search);
  const rewrittenPath = params.get('__path');

  if (rewrittenPath !== null) {
    params.delete('__path');
    const cleanTargetPath = pathOnly.startsWith('/api/index')
      ? `/api/${String(rewrittenPath).replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/api'
      : pathOnly;
    const qs = params.toString();
    req.url = qs ? `${cleanTargetPath}?${qs}` : cleanTargetPath;
    return;
  }

  if (pathOnly === '/api/index' || pathOnly === '/api/index.js') {
    const qs = params.toString();
    req.url = qs ? `/api?${qs}` : '/api';
  }
}

module.exports = async (req, res) => {
  normalizeVercelUrl(req);

  try {
    await ensureInitialized();
  } catch (err) {
    if (!String(req.url || '').startsWith('/api/health')) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(
        JSON.stringify({
          error:
            'Database service unavailable. Verify DATABASE_URL (or DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL) in Vercel Environment Variables.',
          code: (err && err.code) || 'DB_INIT_ERROR',
          detail: sanitizeDbError(err),
        })
      );
    }
  }

  return app(req, res);
};
