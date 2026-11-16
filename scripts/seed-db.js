require('dotenv').config();
process.env.TZ = process.env.TZ || 'Africa/Addis_Ababa';

const { initDatabase, getPool } = require('../config/db');
const { seedRealisticEthiopianData } = require('../services/seedService');
const { runReminderCheck } = require('../services/reminderService');
const logger = require('../config/logger');

async function main() {
  try {
    await initDatabase();
    const res = await seedRealisticEthiopianData();
    const rem = await runReminderCheck();
    logger.info('Database seed completed', { ...res, ...rem });
    await getPool().end();
    process.exit(0);
  } catch (err) {
    logger.error('Database seed failed', { error: err.message });
    process.exit(1);
  }
}

main();
