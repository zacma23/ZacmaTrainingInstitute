const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const appLogPath = path.join(logsDir, 'app.log');
const errorLogPath = path.join(logsDir, 'error.log');

function formatEntry(level, message, meta) {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] [${level}] ${message}`;
  if (meta && Object.keys(meta).length > 0) {
    try {
      return `${base} ${JSON.stringify(meta)}\n`;
    } catch {
      return `${base}\n`;
    }
  }
  return `${base}\n`;
}

function appendSafe(filePath, line) {
  try {
    fs.appendFileSync(filePath, line, 'utf8');
  } catch {
    // Ignore file write errors if read-only in constrained environments
  }
}

const logger = {
  info(message, meta = {}) {
    const line = formatEntry('INFO', message, meta);
    process.stdout.write(line);
    appendSafe(appLogPath, line);
  },
  warn(message, meta = {}) {
    const line = formatEntry('WARN', message, meta);
    process.stdout.write(line);
    appendSafe(appLogPath, line);
  },
  error(message, meta = {}) {
    const line = formatEntry('ERROR', message, meta);
    process.stderr.write(line);
    appendSafe(appLogPath, line);
    appendSafe(errorLogPath, line);
  },
};

module.exports = logger;
