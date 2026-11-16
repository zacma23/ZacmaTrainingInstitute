require('dotenv').config();
process.env.TZ = process.env.TZ || 'Africa/Addis_Ababa';

const { initDatabase, getPool } = require('../config/db');
const { ensureBaselineCatalog } = require('../services/seedService');
const { migrateLegacyJsonData } = require('../services/legacyMigrationService');
const { runReminderCheck } = require('../services/reminderService');
const logger = require('../config/logger');

async function main() {
  try {
    await initDatabase();
    await ensureBaselineCatalog();
    const res = await migrateLegacyJsonData(null);
    await runReminderCheck();
    logger.info('CLI legacy migration completed', res);
    await getPool().end();
    process.exit(0);
  } catch (err) {
    logger.error('CLI legacy migration failed', { error: err.message });
    process.exit(1);
  }
}

main();
