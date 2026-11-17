const { app, ensureInitialized } = require('../server');

function sanitizeDbError(err) {
  const msg = String((err && err.message) || 'Unknown error');
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
    const cleanSubPath = String(rewrittenPath).replace(/^\/+/, '');
    const cleanTargetPath = cleanSubPath ? `/api/${cleanSubPath}`.replace(/\/+$/, '') : '/api';
    const qs = params.toString();
    req.url = qs ? `${cleanTargetPath}?${qs}` : cleanTargetPath;
    return;
  }

  if (pathOnly === '/api/index' || pathOnly === '/api/index.js') {
    const qs = params.toString();
    req.url = qs ? `/api?${qs}` : '/api';
  }
}

function dispatchExpress(req, res) {
  return new Promise((resolve, reject) => {
    if (res.writableEnded) {
      resolve();
      return;
    }

    let settled = false;
    const cleanup = () => {
      res.removeListener('finish', onDone);
      res.removeListener('close', onDone);
      res.removeListener('error', onError);
    };
    const onDone = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    res.once('finish', onDone);
    res.once('close', onDone);
    res.once('error', onError);

    try {
      app(req, res, (err) => {
        if (err) {
          onError(err);
        } else {
          onDone();
        }
      });
    } catch (syncErr) {
      onError(syncErr);
    }
  });
}

module.exports = async (req, res) => {
  normalizeVercelUrl(req);

  // If the serverless runtime already consumed the request stream into req.body,
  // prevent body-parser from hanging or failing while reading an ended stream.
  if (req.readableEnded && req._body === undefined && req.body !== undefined) {
    req._body = true;
  }

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

  try {
    await dispatchExpress(req, res);
  } catch (err) {
    console.error('Vercel Express dispatch failed:', err);
    if (!res.headersSent && !res.writableEnded) {
      res.statusCode = (err && (err.status || err.statusCode)) || 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(
        JSON.stringify({
          error: 'Server request failed.',
          code: (err && err.code) || 'SERVER_DISPATCH_ERROR',
          detail: sanitizeDbError(err),
        })
      );
    }
  }
};
