const express = require('express');
const { getPool, checkDbHealth } = require('../config/db');
const { authenticate, requireRole, recordAuditLog } = require('../middleware/auth');
const { ETHIOPIAN_REGIONS } = require('../utils/ethiopia');
const { getGatewayStatus } = require('../services/messagingService');
const { migrateLegacyJsonData } = require('../services/legacyMigrationService');
const { runReminderCheck } = require('../services/reminderService');

const router = express.Router();

// Public branding & localization endpoint for login screen
router.get('/public', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      "SELECT settingKey, settingValue FROM settings WHERE settingKey IN ('instituteName', 'instituteShortName', 'currency', 'timezone')"
    );
    const settings = Object.fromEntries(rows.map((r) => [r.settingKey, r.settingValue]));
    res.json({
      instituteName: settings.instituteName || 'Addis Skills & Technology Institute',
      instituteShortName: settings.instituteShortName || 'ASTI Ethiopia',
      currency: settings.currency || 'ETB',
      timezone: settings.timezone || 'Africa/Addis_Ababa',
      regions: ETHIOPIAN_REGIONS,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.use(authenticate);

router.get('/', requireRole('admin'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT settingKey, settingValue, updatedBy, updatedAt FROM settings');
    const settings = Object.fromEntries(rows.map((r) => [r.settingKey, r.settingValue]));
    const dbHealth = await checkDbHealth();
    res.json({
      settings,
      regions: ETHIOPIAN_REGIONS,
      gateway: getGatewayStatus(),
      database: dbHealth,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/', requireRole('admin'), async (req, res) => {
  try {
    const allowedKeys = [
      'instituteName',
      'instituteShortName',
      'institutePhone',
      'instituteEmail',
      'instituteRegion',
      'instituteCity',
      'instituteAddress',
      'reminderDaysBefore',
      'receiptFooterNote',
    ];

    const pool = getPool();
    const updates = req.body || {};

    for (const key of allowedKeys) {
      if (updates[key] !== undefined) {
        await pool.query(
          `INSERT INTO settings (settingKey, settingValue, updatedBy)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE settingValue = VALUES(settingValue), updatedBy = VALUES(updatedBy)`,
          [key, String(updates[key]).trim(), req.user.username]
        );
      }
    }

    await recordAuditLog({
      user: req.user,
      action: 'UPDATE_SETTINGS',
      entityType: 'settings',
      details: { keys: Object.keys(updates).filter((k) => allowedKeys.includes(k)) },
      ipAddress: req.ip,
    });

    res.json({ message: 'Institute settings updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin-only idempotent legacy data migration (data/db.json -> normalized MySQL tables)
router.post('/migrate-legacy', requireRole('admin'), async (req, res) => {
  try {
    const result = await migrateLegacyJsonData(req.user);
    await runReminderCheck();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Legacy migration failed: ' + err.message });
  }
});

module.exports = router;
