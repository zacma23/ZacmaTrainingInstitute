const { getDatabase } = require('@netlify/database');
const logger = require('./logger');

// Postgres (Netlify Database) adapter that preserves the previous mysql2-style
// call surface used across routes/services: pool.query -> [rows, fields],
// conn.beginTransaction/commit/rollback/release, `?` placeholders, and
// array expansion for `IN (?)` clauses.

let database = null;
let initPromise = null;

// Postgres OID type ids that need mysql2-parity coercion
const PG_DATE = 1082;
const PG_NUMERIC = 1700;
const PG_INT8 = 20;

function formatDateValue(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function coerceRowValues(rows, fields) {
  if (!rows || !fields || fields.length === 0) return rows;
  const coerces = fields.map((f) => {
    const id = f.dataTypeID;
    if (id === PG_DATE) return (v) => (v instanceof Date ? formatDateValue(v) : v);
    if (id === PG_NUMERIC || id === PG_INT8) return (v) => (typeof v === 'string' && v !== '' ? Number(v) : v);
    return null;
  });
  if (!coerces.some(Boolean)) return rows;
  for (const row of rows) {
    if (!row) continue;
    fields.forEach((f, i) => {
      if (coerces[i] && row[f.name] !== null && row[f.name] !== undefined) {
        row[f.name] = coerces[i](row[f.name]);
      }
    });
  }
  return rows;
}

function translateSql(sql, values) {
  const params = [];
  const literals = [];
  const idents = [];

  // Protect single-quoted string literals (including doubled '' escapes)
  let out = String(sql).replace(/'(?:[^'\\]|\\.|'')*'/g, (m) => {
    literals.push(m);
    return `\u0000L${literals.length - 1}\u0000`;
  });

  // Protect existing double-quoted identifiers
  out = out.replace(/"(?:[^"]|"")*"/g, (m) => {
    idents.push(m);
    return `\u0000D${idents.length - 1}\u0000`;
  });

  // MySQL backtick identifiers -> Postgres double quotes
  out = out.replace(/`([^`]+)`/g, '"$1"');

  // MySQL LIKE is case-insensitive under utf8mb4_unicode_ci; ILIKE matches that
  out = out.replace(/\bLIKE\b/g, 'ILIKE');

  // Replace `?` placeholders with $n, expanding arrays for IN (?) support
  let vi = 0;
  out = out.replace(/\?/g, () => {
    const val = values ? values[vi++] : undefined;
    if (Array.isArray(val)) {
      const marks = val.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return marks.length > 0 ? marks.join(', ') : 'NULL';
    }
    params.push(val);
    return `$${params.length}`;
  });

  // Quote mixed-case identifiers so camelCase columns/aliases keep their case
  out = out.replace(/[A-Za-z_][A-Za-z0-9_$]*/g, (tok) => {
    if (/[A-Z]/.test(tok) && /[a-z]/.test(tok)) return `"${tok}"`;
    return tok;
  });

  // Restore protected literals and identifiers
  out = out.replace(/\u0000L(\d+)\u0000/g, (_, i) => literals[Number(i)]);
  out = out.replace(/\u0000D(\d+)\u0000/g, (_, i) => idents[Number(i)]);

  return { text: out, values: params };
}

async function runQuery(client, sql, values) {
  const isReadQuery = /^\s*(SELECT|WITH|SHOW|TABLE|VALUES)\b/i.test(String(sql));
  const hasReturning = /\bRETURNING\b/i.test(String(sql));
  const { text, values: params } = translateSql(sql, values);
  const result = await client.query(text, params);
  const rows = coerceRowValues(result.rows || [], result.fields);
  if (isReadQuery || hasReturning) {
    return [rows, result.fields];
  }
  return [{ affectedRows: result.rowCount || 0, insertId: null, rows }, undefined];
}

function wrapClient(client) {
  return {
    query: (sql, values) => runQuery(client, sql, values),
    beginTransaction: async () => {
      await client.query('BEGIN');
    },
    commit: async () => {
      await client.query('COMMIT');
    },
    rollback: async () => {
      await client.query('ROLLBACK');
    },
    release: () => {},
    connection: client,
  };
}

function getPool() {
  if (!database) {
    throw new Error('Database pool is not initialized yet. Call initDatabase() first.');
  }
  const rawPool = database.pool;
  return {
    query: (sql, values) => runQuery(rawPool, sql, values),
    getConnection: async () => wrapClient(await rawPool.connect()),
    end: async () => {
      await rawPool.end().catch(() => {});
      database = null;
      initPromise = null;
    },
    pool: rawPool,
  };
}

async function initDatabase() {
  if (database) {
    return getPool();
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    const db = getDatabase();
    const probe = await db.pool.query('SELECT current_database() AS "dbName", version() AS version');
    database = db;
    logger.info('Netlify Database connection verified', {
      database: probe.rows[0] ? probe.rows[0].dbName : 'unknown',
    });
    return getPool();
  })().catch((err) => {
    initPromise = null;
    throw err;
  });

  return initPromise;
}

async function withTransaction(callback) {
  const rawPool = getPool().pool;
  const client = await rawPool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(wrapClient(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('Transaction rollback failed', { error: rollbackErr.message });
    }
    throw err;
  } finally {
    client.release();
  }
}

async function checkDbHealth() {
  try {
    const res = await getPool().query('SELECT 1 AS ok, version() AS version, current_database() AS "dbName"');
    const row = res[0][0] || {};
    return { connected: true, version: String(row.version || '').split(' ')[0] || 'postgres', database: row.dbName };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

module.exports = {
  initDatabase,
  getPool,
  withTransaction,
  checkDbHealth,
};
