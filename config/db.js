const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const mysql = require('mysql2/promise');
const logger = require('./logger');

let pool = null;
let lastInitError = null;

function sanitizeErrorText(msg) {
  return String(msg || '')
    .replace(/(mysql|mariadb):\/\/[^@/\s]+@/gi, '$1://***:***@')
    .replace(/(password|pwd)=([^&\s;]+)/gi, '$1=***');
}

function resolveSslOption(urlSslMode) {
  const rawInput = String(process.env.DB_SSL || urlSslMode || '').trim();
  const rawSsl = rawInput.toLowerCase();
  const rawCa = (process.env.DB_SSL_CA || '').trim();

  if (!rawSsl && !rawCa) {
    return undefined;
  }
  if (rawSsl === 'false' || rawSsl === '0' || rawSsl === 'disable' || rawSsl === 'disabled') {
    return undefined;
  }
  if (rawInput.startsWith('{')) {
    try {
      const parsedSsl = JSON.parse(rawInput);
      if (parsedSsl && typeof parsedSsl === 'object') {
        return { minVersion: 'TLSv1.2', ...parsedSsl };
      }
    } catch {
      // fall through to standard SSL option handling
    }
  }

  const sslObj = {
    minVersion: 'TLSv1.2',
    rejectUnauthorized:
      rawSsl !== 'skip-verify' &&
      rawSsl !== 'no-verify' &&
      rawSsl !== 'allow-self-signed' &&
      rawSsl !== 'insecure',
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
    execSync('which mariadbd || which mysqld', { stdio: 'ignore' });
  } catch {
    try {
      logger.info('Local MariaDB binary not found; attempting automatic package installation...');
      execSync(
        'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" mariadb-server',
        { stdio: 'ignore' }
      );
    } catch (installErr) {
      logger.warn('Could not auto-install local MariaDB server', { error: installErr.message });
    }
  }

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

function isAccessDeniedError(err) {
  return Boolean(
    err &&
      (err.errno === 1045 ||
        err.errno === 1044 ||
        err.errno === 1698 ||
        err.code === 'ER_ACCESS_DENIED_ERROR' ||
        err.code === 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR' ||
        err.code === 'ER_DBACCESS_DENIED_ERROR' ||
        err.sqlState === '28000')
  );
}

function escapeSqlLiteral(val) {
  return String(val ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function escapeSqlIdentifier(val) {
  return String(val ?? '').replace(/`/g, '``');
}

function ensureLocalMysqlUserAndDb(cfg) {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return false;
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') return false;

  const dbIdent = escapeSqlIdentifier(cfg.database);
  const sqlLines = [
    `CREATE DATABASE IF NOT EXISTS \`${dbIdent}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
  ];

  if (cfg.user && cfg.user !== 'root') {
    const uLit = escapeSqlLiteral(cfg.user);
    const pLit = escapeSqlLiteral(cfg.password);
    for (const hostSpec of ['localhost', '127.0.0.1', '%']) {
      sqlLines.push(`CREATE USER IF NOT EXISTS '${uLit}'@'${hostSpec}' IDENTIFIED BY '${pLit}';`);
      sqlLines.push(`ALTER USER '${uLit}'@'${hostSpec}' IDENTIFIED BY '${pLit}';`);
      sqlLines.push(`GRANT ALL PRIVILEGES ON \`${dbIdent}\`.* TO '${uLit}'@'${hostSpec}';`);
    }
  }
  sqlLines.push('FLUSH PRIVILEGES;');
  const sql = sqlLines.join('\n');

  for (const bin of ['mariadb', 'mysql']) {
    const res = spawnSync(bin, ['-u', 'root'], {
      input: sql,
      encoding: 'utf8',
    });
    if (res.status === 0) {
      logger.info('Bootstrapped local MariaDB database and user privileges', {
        database: cfg.database,
        user: cfg.user,
      });
      return true;
    }
  }
  return false;
}

async function applySchemaAndUpgrades(conn, database) {
  const [[tablesRow]] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('users', 'settings', 'notifications', 'audit_logs')`,
    [database]
  );

  if (Number(tablesRow.cnt) < 4) {
    const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    const filteredSql = schemaSql
      .replace(/CREATE\s+DATABASE[\s\S]*?;/gi, '')
      .replace(/USE\s+`?[^`;]+`?\s*;/gi, '');

    await conn.query(filteredSql);
  }

  // Only run incremental column/enum upgrades if a newer column or enum is missing
  const [[upgradeMarker]] = await conn.query(
    `SELECT
       (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'type' AND COLUMN_TYPE LIKE '%STUDENT_MESSAGE%') AS hasSmsEnum,
       (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'students' AND COLUMN_NAME = 'nationalIdNumber') AS hasStudentNid,
       (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'registration_applications' AND COLUMN_NAME = 'nationalIdNumber') AS hasAppNid,
       (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'channelStatus' AND COLUMN_TYPE LIKE '%EMAIL_NOT_CONFIGURED%') AS hasEmailChannelEnum`,
    [database, database, database, database]
  );
  if (
    Number(upgradeMarker.hasSmsEnum) === 0 ||
    Number(upgradeMarker.hasStudentNid) === 0 ||
    Number(upgradeMarker.hasAppNid) === 0 ||
    Number(upgradeMarker.hasEmailChannelEnum) === 0 ||
    Number(tablesRow.cnt) < 4
  ) {
    await ensureSchemaUpgrades(conn, database);
  }
}

function isSecureTransportError(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  return (
    (err && (err.errno === 3159 || err.code === 'ER_SECURE_TRANSPORT_REQUIRED')) ||
    msg.includes('secure transport') ||
    msg.includes('connections using insecure transport')
  );
}

async function initDatabase() {
  if (pool) {
    return pool;
  }

  try {
    const cfg = getDbConfig();
    const isLocalHost = cfg.host === '127.0.0.1' || cfg.host === 'localhost';
    if ((process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) && isLocalHost) {
      const err = new Error(
        'No external MySQL database is configured for Vercel. Set DATABASE_URL (or DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL) in Vercel Project Settings → Environment Variables.'
      );
      err.code = 'MISSING_VERCEL_DB_CONFIG';
      throw err;
    }

    if (!cfg.user) {
      throw new Error('DB_USER (or DATABASE_URL) is not configured in environment variables.');
    }

    ensureLocalMariaDbRunning(cfg.host);

    const skipSchemaSync = String(process.env.DB_SKIP_SCHEMA_SYNC || '').toLowerCase() === 'true';

  if (!skipSchemaSync) {
    const buildConnOpts = (withDatabase) => ({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      ...(withDatabase ? { database: cfg.database } : {}),
      multipleStatements: true,
      connectTimeout: 10000,
      timezone: '+03:00',
      ...(cfg.ssl ? { ssl: cfg.ssl } : {}),
    });

    let localBootstrapped = false;
    const connectWithAutoSsl = async (withDatabase) => {
      try {
        return await mysql.createConnection(buildConnOpts(withDatabase));
      } catch (err) {
        if (isLocalHost && !localBootstrapped && isAccessDeniedError(err)) {
          localBootstrapped = true;
          if (ensureLocalMysqlUserAndDb(cfg)) {
            return await mysql.createConnection(buildConnOpts(withDatabase));
          }
        }
        if (!cfg.ssl && !isLocalHost && isSecureTransportError(err)) {
          cfg.ssl = { minVersion: 'TLSv1.2', rejectUnauthorized: true };
          logger.info('Remote cloud MySQL requires TLS; retrying connection with SSL enabled', { host: cfg.host });
          return await mysql.createConnection(buildConnOpts(withDatabase));
        }
        throw err;
      }
    };

    const preferDirect = Boolean(
      cfg.database && (process.env.DATABASE_URL || process.env.MYSQL_URL || process.env.VERCEL)
    );

    if (preferDirect) {
      let directConn = null;
      try {
        directConn = await connectWithAutoSsl(true);
        await applySchemaAndUpgrades(directConn, cfg.database);
        logger.info('MySQL schema verified on target database', { database: cfg.database, host: cfg.host });
      } catch (directErr) {
        if (directConn) {
          await directConn.end().catch(() => {});
          directConn = null;
        }
        if (directErr && directErr.code === 'ER_BAD_DB_ERROR') {
          const bootstrapConn = await connectWithAutoSsl(false);
          try {
            await bootstrapConn.query(
              `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
            );
            await bootstrapConn.query(`USE \`${cfg.database}\``);
            await applySchemaAndUpgrades(bootstrapConn, cfg.database);
            logger.info('MySQL database created and schema verified', { database: cfg.database, host: cfg.host });
          } finally {
            await bootstrapConn.end().catch(() => {});
          }
        } else {
          throw directErr;
        }
      } finally {
        if (directConn) {
          await directConn.end().catch(() => {});
        }
      }
    } else {
      let bootstrapConn = null;
      try {
        bootstrapConn = await connectWithAutoSsl(false);
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
        const directConn = await connectWithAutoSsl(true);
        try {
          await applySchemaAndUpgrades(directConn, cfg.database);
          logger.info('MySQL schema verified on pre-provisioned database', { database: cfg.database, host: cfg.host });
        } finally {
          await directConn.end().catch(() => {});
        }
      } finally {
        if (bootstrapConn) {
          await bootstrapConn.end().catch(() => {});
        }
      }
    }
  }

  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const poolBaseConfig = {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: cfg.connectionLimit,
    maxIdle: isServerless ? Math.min(2, cfg.connectionLimit) : cfg.connectionLimit,
    idleTimeout: isServerless ? 25000 : 60000,
    queueLimit: 0,
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    dateStrings: ['DATE'],
    decimalNumbers: true,
    timezone: '+03:00',
  };

  // 2. Create connection pool bound to target database
  pool = mysql.createPool({
    ...poolBaseConfig,
    ...(cfg.ssl ? { ssl: cfg.ssl } : {}),
  });

  // Verify pool connectivity (and auto-enable TLS if skipped schema sync on remote host)
  try {
    const conn = await pool.getConnection();
    try {
      await conn.ping();
    } finally {
      conn.release();
    }
  } catch (poolErr) {
    if (!cfg.ssl && !isLocalHost && isSecureTransportError(poolErr)) {
      await pool.end().catch(() => {});
      cfg.ssl = { minVersion: 'TLSv1.2', rejectUnauthorized: true };
      pool = mysql.createPool({
        ...poolBaseConfig,
        ssl: cfg.ssl,
      });
      const retryConn = await pool.getConnection();
      try {
        await retryConn.ping();
      } finally {
        retryConn.release();
      }
    } else {
      await pool.end().catch(() => {});
      pool = null;
      throw poolErr;
    }
  }

    lastInitError = null;
    return pool;
  } catch (initErr) {
    lastInitError = {
      code: initErr?.code || 'DB_INIT_ERROR',
      message: sanitizeErrorText(initErr?.message || 'Database initialization failed.'),
    };
    throw initErr;
  }
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
    return {
      connected: false,
      code: lastInitError?.code || err?.code || 'DB_UNAVAILABLE',
      error: lastInitError?.message || sanitizeErrorText(err?.message),
    };
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
  await addColumnIfMissing(conn, dbName, 'students', 'nationalIdNumber', "nationalIdNumber VARCHAR(60) DEFAULT '' AFTER emergencyContactRelation");
  await addColumnIfMissing(conn, dbName, 'students', 'documentsNote', 'documentsNote TEXT AFTER nationalIdNumber');
  await addColumnIfMissing(conn, dbName, 'students', 'registeredByUserId', 'registeredByUserId CHAR(36) NULL AFTER notes');
  await addColumnIfMissing(conn, dbName, 'students', 'approvedByUserId', 'approvedByUserId CHAR(36) NULL AFTER registeredByUserId');
  await addColumnIfMissing(conn, dbName, 'students', 'approvedAt', 'approvedAt DATETIME NULL AFTER approvedByUserId');

  await addColumnIfMissing(conn, dbName, 'registration_applications', 'nationalIdNumber', "nationalIdNumber VARCHAR(60) DEFAULT '' AFTER emergencyContactRelation");

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
      'PAYMENT_APPROVED', 'PAYMENT_REJECTED', 'STUDENT_MESSAGE'
    ) NOT NULL,
    MODIFY COLUMN channelStatus ENUM(
      'IN_APP_ONLY', 'WHATSAPP_NOT_CONFIGURED', 'SMS_NOT_CONFIGURED',
      'EMAIL_NOT_CONFIGURED', 'PARTIAL', 'SENT', 'FAILED'
    ) NOT NULL DEFAULT 'IN_APP_ONLY'
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
