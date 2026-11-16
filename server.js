require('dotenv').config();

// Enforce Ethiopian timezone for all Node date operations
process.env.TZ = process.env.TZ || 'Africa/Addis_Ababa';

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cron = require('node-cron');

const logger = require('./config/logger');
const { initDatabase, checkDbHealth } = require('./config/db');
const { apiLimiter, isJwtConfigured } = require('./middleware/auth');
const { ensureBaselineCatalog } = require('./services/seedService');
const { runReminderCheck } = require('./services/reminderService');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const courseRoutes = require('./routes/courses');
const studentRoutes = require('./routes/students');
const applicationRoutes = require('./routes/applications');
const paymentSubmissionRoutes = require('./routes/paymentSubmissions');
const installmentRoutes = require('./routes/installments');
const transactionRoutes = require('./routes/transactions');
const receiptRoutes = require('./routes/receipts');
const attendanceRoutes = require('./routes/attendance');
const notificationRoutes = require('./routes/notifications');
const reportRoutes = require('./routes/reports');
const userRoutes = require('./routes/users');
const settingsRoutes = require('./routes/settings');
const chatRoutes = require('./routes/chat');
const aiRoutes = require('./routes/ai');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

app.set('trust proxy', 1);

// Security & Performance Middleware
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    frameguard: false,
  })
);
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '8mb' }));

// Health check (unauthenticated for load balancer / uptime probes)
app.get('/api/health', async (req, res) => {
  const db = await checkDbHealth();
  const jwtOk = isJwtConfigured();
  res.status(db.connected && jwtOk ? 200 : 503).json({
    status: db.connected && jwtOk ? 'ok' : 'degraded',
    timezone: process.env.TZ,
    jwtConfigured: jwtOk,
    database: db,
  });
});

// Serve local UMD bundles from node_modules (zero external CDN dependency)
app.get('/vendor/chart.umd.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/chart.js/dist/chart.umd.min.js'));
});
app.get('/vendor/lucide.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/lucide/dist/umd/lucide.min.js'));
});
app.get('/vendor/jspdf.umd.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/jspdf/dist/jspdf.umd.min.js'));
});

// Rate-limited REST API routes
app.use('/api', apiLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/payment-submissions', paymentSubmissionRoutes);
app.use('/api/installments', installmentRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/receipts', receiptRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/admin', userRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api', courseRoutes);

// Vercel Cron / External Scheduler endpoint for automated reminder checks
app.get('/api/cron/reminders', async (req, res) => {
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  if (cronSecret) {
    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized cron invocation.' });
    }
  }
  try {
    await ensureInitialized();
    const result = await runReminderCheck();
    return res.json({ ok: true, result });
  } catch (err) {
    logger.error('Cron reminder check failed', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Static Frontend
app.use(express.static(path.join(__dirname, 'public')));

// SPA Fallback for non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found.' });
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global Error Handler
app.use((err, req, res, _next) => {
  logger.error('Unhandled Express error', {
    method: req.method,
    path: req.path,
    error: err.message,
  });
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error.' : err.message,
  });
});

let initPromise = null;

async function ensureInitialized() {
  if (!initPromise) {
    initPromise = (async () => {
      await initDatabase();
      await ensureBaselineCatalog();
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

async function bootstrap() {
  try {
    await ensureInitialized();
    await runReminderCheck();

    // Run automated payment reminder check every hour in Africa/Addis_Ababa timezone (non-serverless only)
    if (!process.env.VERCEL) {
      cron.schedule(
        '0 * * * *',
        () => {
          runReminderCheck().catch((err) =>
            logger.error('Scheduled reminder check failed', { error: err.message })
          );
        },
        { timezone: 'Africa/Addis_Ababa' }
      );
    }

    app.listen(PORT, HOST, () => {
      logger.info(`BirrLedger Student Fee Management System listening on http://${HOST}:${PORT}`, {
        timezone: process.env.TZ,
        env: process.env.NODE_ENV || 'development',
      });
    });
  } catch (err) {
    logger.error('Fatal startup error', { error: err.message });
    process.exit(1);
  }
}

if (require.main === module) {
  bootstrap();
}

module.exports = {
  app,
  ensureInitialized,
  bootstrap,
};
