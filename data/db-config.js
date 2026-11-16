/**
 * Secure Database Configuration Wrapper
 * Reads all connection and authentication settings from environment variables (.env).
 * Hardcoded database passwords and static admin credentials have been removed.
 */
require('dotenv').config();

const { initDatabase, getPool, withTransaction, checkDbHealth, getDbConfig } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');

const DB_NAME = getDbConfig().database;

module.exports = {
  initDatabase,
  getPool,
  withTransaction,
  checkDbHealth,
  DB_NAME,
  requireDBAuth: [authenticate, requireRole('admin')],
};
