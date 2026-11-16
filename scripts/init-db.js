require('dotenv').config();
process.env.TZ = process.env.TZ || 'Africa/Addis_Ababa';

const { initDatabase, getPool } = require('../config/db');
const { ensureBaselineCatalog } = require('../services/seedService');
const logger = require('../config/logger');

async function main() {
  try {
    await initDatabase();
    await ensureBaselineCatalog();
    logger.info('Database schema and baseline catalog initialized successfully.');
    await getPool().end();
    process.exit(0);
  } catch (err) {
    logger.error('Database initialization failed', { error: err.message });
    process.exit(1);
  }
}

main();
