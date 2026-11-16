const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const mysql = require('mysql2/promise');
const logger = require('./logger');

let pool = null;

function resolveSslOption(urlSslMode) {
  const rawSsl = String(process.env.DB_SSL || urlSslMode || '').trim().toLowerCase();
  const rawCa = (process.env.DB_SSL_CA || '').trim();

  if (!rawSsl && !rawCa) {
    return undefined;
  }
  if (rawSsl === 'false' || rawSsl === '0' || rawSsl === 'disable' || rawSsl === 'disabled') {
    return undefined;
  }

  const sslObj = {
    minVersion: 'TLSv1.2',
    rejectUnauthorized: rawSsl !== 'skip-verify' && rawSsl !== 'no-verify' && rawSsl !== 'allow-self-signed',
  };

  if (rawCa) {
    if (rawCa.includes('BEGIN CERTIFICATE')) {
      sslObj.ca = rawCa.replace(/\\n/g, '\n');
    } else {
      try {
        sslObj.ca = Buffer.from(rawCa, 'base64').toString('utf8');
      } catch {
        sslObj.ca = rawCa;
      }
    }
  }

  return sslObj;
}

function getDbConfig() {
  const rawUrl = (process.env.DATABASE_URL || process.env.MYSQL_URL || '').trim();
  const defaultLimit = process.env.VERCEL ? '3' : '10';

  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const urlSsl = parsed.searchParams.get('ssl-mode') || parsed.searchParams.get('sslmode') || parsed.searchParams.get('ssl') || '';
      const dbName = parsed.pathname ? decodeURIComponent(parsed.pathname.replace(/^\//, '')) : '';
      return {
        host: parsed.hostname || '127.0.0.1',
        port: parseInt(parsed.port || '3306', 10),
        user: decodeURIComponent(parsed.username || 'root'),
        password: decodeURIComponent(parsed.password || ''),
        database: dbName || process.env.DB_NAME || 'sfmt_ethiopia',
        connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || defaultLimit, 10),
        ssl: resolveSslOption(urlSsl),
      };
    } catch (err) {
      logger.warn('Failed to parse DATABASE_URL/MYSQL_URL; falling back to DB_* variables', { error: err.message });
    }
  }

  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'sfmt_ethiopia',
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || defaultLimit, 10),
    ssl: resolveSslOption(''),
  };
}

function ensureLocalMariaDbRunning(host) {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  if (host !== '127.0.0.1' && host !== 'localhost') return;
  try {
    execSync('pgrep -x mariadbd || pgrep -x mysqld', { stdio: 'ignore' });
  } catch {
    try {
      logger.info('Local MariaDB/MySQL daemon not running; attempting service start...');
      execSync('service mariadb start || service mysql start', { stdio: 'ignore' });
    } catch (err) {
      logger.warn('Could not auto-start local MariaDB service', { error: err.message });
    }
  }
}

async function applySchemaAndUpgrades(conn, database) {
  const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const filteredSql = schemaSql
    .replace(/CREATE\s+DATABASE[\s\S]*?;/gi, '')
    .replace(/USE\s+`?[^`;]+`?\s*;/gi, '');

  await conn.query(filteredSql);
  await ensureSchemaUpgrades(conn, database);
}

async function initDatabase() {
  if (pool) {
    return pool;
  }

  const cfg = getDbConfig();
  if (!cfg.user) {
    throw new Error('DB_USER (or DATABASE_URL) is not configured in environment variables.');
  }

  ensureLocalMariaDbRunning(cfg.host);

  const skipSchemaSync = String(process.env.DB_SKIP_SCHEMA_SYNC || '').toLowerCase() === 'true';

  if (!skipSchemaSync) {
    const baseConnOpts = {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      multipleStatements: true,
      timezone: '+03:00',
      ...(cfg.ssl ? { ssl: cfg.ssl } : {}),
    };

    // 1. Try connecting at server level to create the database if needed;
    //    if managed cloud MySQL denies server-level CREATE DATABASE, connect directly to cfg.database.
    let bootstrapConn = null;
    try {
      bootstrapConn = await mysql.createConnection(baseConnOpts);
      await bootstrapConn.query(
        `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
      await bootstrapConn.query(`USE \`${cfg.database}\``);
      await applySchemaAndUpgrades(bootstrapConn, cfg.database);
      logger.info('MySQL database and schema verified', { database: cfg.database, host: cfg.host });
    } catch (serverLevelErr) {
      if (bootstrapConn) {
        await bootstrapConn.end().catch(() => {});
        bootstrapConn = null;
      }
      logger.warn('Server-level CREATE DATABASE skipped; connecting directly to target database', {
        database: cfg.database,
        reason: serverLevelErr.message,
      });
      const directConn = await mysql.createConnection({
        ...baseConnOpts,
        database: cfg.database,
      });
      try {
        await applySchemaAndUpgrades(directConn, cfg.database);
        logger.info('MySQL schema verified on pre-provisioned database', { database: cfg.database, host: cfg.host });
      } finally {
        await directConn.end();
      }
    } finally {
      if (bootstrapConn) {
        await bootstrapConn.end().catch(() => {});
      }
    }
  }

  // 2. Create connection pool bound to target database
  pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: cfg.connectionLimit,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    dateStrings: ['DATE'],
    decimalNumbers: true,
    timezone: '+03:00',
    ...(cfg.ssl ? { ssl: cfg.ssl } : {}),
  });

  // Verify pool connectivity
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }

  return pool;
}

function getPool() {
  if (!pool) {
    throw new Error('Database pool is not initialized yet. Call initDatabase() first.');
  }
  return pool;
}

async function withTransaction(callback) {
  const currentPool = getPool();
  const conn = await currentPool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await callback(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      logger.error('Transaction rollback failed', { error: rollbackErr.message });
    }
    throw err;
  } finally {
    conn.release();
  }
}

async function checkDbHealth() {
  try {
    const currentPool = getPool();
    const [[row]] = await currentPool.query('SELECT 1 AS ok, VERSION() AS version, DATABASE() AS dbName');
    return { connected: true, version: row.version, database: row.dbName };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

async function addColumnIfMissing(conn, dbName, tableName, colName, alterSql) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbName, tableName, colName]
  );
  if (Number(row.cnt) === 0) {
    await conn.query(`ALTER TABLE \`${tableName}\` ADD COLUMN ${alterSql}`);
  }
}

async function ensureSchemaUpgrades(conn, dbName) {
  await addColumnIfMissing(conn, dbName, 'users', 'firebaseUid', 'firebaseUid VARCHAR(128) NULL AFTER username');
  await addColumnIfMissing(conn, dbName, 'users', 'roleId', 'roleId CHAR(36) NULL AFTER role');
  await addColumnIfMissing(conn, dbName, 'users', 'createdByUserId', 'createdByUserId CHAR(36) NULL AFTER lastLoginAt');

  await addColumnIfMissing(conn, dbName, 'courses', 'category', "category VARCHAR(100) NOT NULL DEFAULT 'Technology' AFTER name");
  await addColumnIfMissing(conn, dbName, 'courses', 'registrationFee', 'registrationFee DECIMAL(12, 2) NOT NULL DEFAULT 500.00 AFTER durationUnit');
  await addColumnIfMissing(conn, dbName, 'courses', 'startDate', 'startDate DATE NULL AFTER availablePlans');
  await addColumnIfMissing(conn, dbName, 'courses', 'endDate', 'endDate DATE NULL AFTER startDate');
  await addColumnIfMissing(conn, dbName, 'courses', 'maxCapacity', 'maxCapacity INT NOT NULL DEFAULT 30 AFTER endDate');

  await addColumnIfMissing(conn, dbName, 'students', 'emergencyContactName', "emergencyContactName VARCHAR(150) DEFAULT '' AFTER address");
  await addColumnIfMissing(conn, dbName, 'students', 'emergencyContactPhone', "emergencyContactPhone VARCHAR(30) DEFAULT '' AFTER emergencyContactName");
  await addColumnIfMissing(conn, dbName, 'students', 'emergencyContactRelation', "emergencyContactRelation VARCHAR(80) DEFAULT '' AFTER emergencyContactPhone");
  await addColumnIfMissing(conn, dbName, 'students', 'documentsNote', 'documentsNote TEXT AFTER emergencyContactRelation');
  await addColumnIfMissing(conn, dbName, 'students', 'registeredByUserId', 'registeredByUserId CHAR(36) NULL AFTER notes');
  await addColumnIfMissing(conn, dbName, 'students', 'approvedByUserId', 'approvedByUserId CHAR(36) NULL AFTER registeredByUserId');
  await addColumnIfMissing(conn, dbName, 'students', 'approvedAt', 'approvedAt DATETIME NULL AFTER approvedByUserId');

  await addColumnIfMissing(conn, dbName, 'enrollments', 'batchName', "batchName VARCHAR(80) NOT NULL DEFAULT 'Batch A' AFTER paymentPlanId");
  await addColumnIfMissing(conn, dbName, 'enrollments', 'registrationFee', 'registrationFee DECIMAL(12, 2) NOT NULL DEFAULT 0.00 AFTER expectedGraduationDate');

  await addColumnIfMissing(conn, dbName, 'transactions', 'submissionId', 'submissionId CHAR(36) NULL AFTER enrollmentId');
  await addColumnIfMissing(conn, dbName, 'transactions', 'paymentCategory', "paymentCategory ENUM('COURSE_FEE', 'REGISTRATION_FEE', 'COMBINED') NOT NULL DEFAULT 'COURSE_FEE' AFTER submissionId");
  await addColumnIfMissing(conn, dbName, 'transactions', 'registrationAmount', 'registrationAmount DECIMAL(12, 2) NOT NULL DEFAULT 0.00 AFTER paymentCategory');
  await addColumnIfMissing(conn, dbName, 'transactions', 'tuitionAmount', 'tuitionAmount DECIMAL(12, 2) NOT NULL DEFAULT 0.00 AFTER registrationAmount');
  await addColumnIfMissing(conn, dbName, 'transactions', 'approvedByUserId', 'approvedByUserId CHAR(36) NULL AFTER receivedByName');
  await addColumnIfMissing(conn, dbName, 'transactions', 'approvedAt', 'approvedAt DATETIME NULL AFTER approvedByUserId');

  await addColumnIfMissing(conn, dbName, 'receipts', 'approvedByUserId', 'approvedByUserId CHAR(36) NULL AFTER issuedBy');

  await addColumnIfMissing(conn, dbName, 'notifications', 'applicationId', 'applicationId CHAR(36) NULL AFTER installmentId');
  await addColumnIfMissing(conn, dbName, 'notifications', 'paymentSubmissionId', 'paymentSubmissionId CHAR(36) NULL AFTER applicationId');
  await addColumnIfMissing(conn, dbName, 'notifications', 'targetRole', "targetRole ENUM('all', 'admin', 'accountant') NOT NULL DEFAULT 'all' AFTER paymentSubmissionId");
  await addColumnIfMissing(conn, dbName, 'notifications', 'targetUserId', 'targetUserId CHAR(36) NULL AFTER targetRole');

  // Ensure notifications.studentId & enrollmentId allow NULL and notifications.type supports workflow alerts
  await conn.query(`
    ALTER TABLE notifications
    MODIFY COLUMN studentId CHAR(36) NULL,
    MODIFY COLUMN enrollmentId CHAR(36) NULL,
    MODIFY COLUMN type ENUM(
      'DUE_TODAY', 'DUE_SOON', 'OVERDUE', 'UNPAID_INSTALLMENT', 'OUTSTANDING_BALANCE',
      'NEW_REGISTRATION', 'NEW_PAYMENT_SUBMISSION',
      'REGISTRATION_APPROVED', 'REGISTRATION_REJECTED', 'CORRECTION_REQUIRED',
      'PAYMENT_APPROVED', 'PAYMENT_REJECTED'
    ) NOT NULL
  `);

  await addColumnIfMissing(conn, dbName, 'audit_logs', 'previousValue', 'previousValue JSON NULL AFTER entityId');
  await addColumnIfMissing(conn, dbName, 'audit_logs', 'newValue', 'newValue JSON NULL AFTER previousValue');
  await addColumnIfMissing(conn, dbName, 'audit_logs', 'reason', 'reason TEXT AFTER newValue');
}

module.exports = {
  initDatabase,
  getPool,
  withTransaction,
  checkDbHealth,
  getDbConfig,
};
