const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const levelName = (process.env.LOG_LEVEL || 'info').toLowerCase();
const CURRENT_LEVEL = LEVELS[levelName] ?? LEVELS.info;

function shouldLog(level) {
  return LEVELS[level] >= CURRENT_LEVEL;
}

function log(level, args) {
  if (!shouldLog(level)) return;
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  const method = level === 'warn' ? console.warn : level === 'error' ? console.error : console.log;

  if (args.length === 0) {
    method(prefix);
    return;
  }

  if (typeof args[0] === 'string') {
    method(`${prefix} ${args[0]}`, ...args.slice(1));
    return;
  }

  method(prefix, ...args);
}

const logger = {
  debug: (...args) => log('debug', args),
  info: (...args) => log('info', args),
  warn: (...args) => log('warn', args),
  error: (...args) => log('error', args),
};

export default logger;
