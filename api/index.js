const { app, ensureInitialized } = require('../server');

module.exports = async (req, res) => {
  try {
    await ensureInitialized();
  } catch (err) {
    if (!String(req.url || '').startsWith('/api/health')) {
      return res.status(503).json({
        error:
          'Database service unavailable. Verify DATABASE_URL (or DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL) in Vercel Environment Variables.',
        detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
      });
    }
  }

  return app(req, res);
};
