/**
 * BaalLogger.js — The Voice of the Storm
 */

const ANSI = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
  bgRed:   '\x1b[41m',
};

const PHASE_COLORS = {
  gaze:    ANSI.cyan,
  storm:   ANSI.blue,
  cloud:   ANSI.white,
  declare: ANSI.yellow,
  anat:    ANSI.red,
  vault:   ANSI.gray,
  system:  ANSI.bold,
};

const PHASE_SYMBOLS = {
  gaze:    '👁 ',
  storm:   '⚡',
  cloud:   '☁ ',
  declare: '⚔ ',
  anat:    '🛡 ',
  vault:   '🗄 ',
  system:  '⚙ ',
};

const LEVEL = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

export class BaalLogger {
  #name      = 'BAAL';
  #level     = LEVEL.INFO;
  #jsonMode  = false;
  #component = null;

  constructor({ name = 'BAAL', level = process.env.LOG_LEVEL ?? 'INFO', component = null } = {}) {
    this.#name      = name;
    this.#level     = LEVEL[level.toUpperCase()] ?? LEVEL.INFO;
    this.#component = component;
    this.#jsonMode  = process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production';
  }

  gaze(message, context = {})    { this.#log('INFO',  'gaze',    message, context); }
  storm(message, context = {})   { this.#log('INFO',  'storm',   message, context); }
  cloud(message, context = {})   { this.#log('INFO',  'cloud',   message, context); }
  declare(message, context = {}) { this.#log('INFO',  'declare', message, context); }
  anat(message, context = {})    { this.#log('WARN',  'anat',    message, context); }
  vault(message, context = {})   { this.#log('DEBUG', 'vault',   message, context); }
  debug(message, context = {})   { this.#log('DEBUG', 'system',  message, context); }
  info(message, context = {})    { this.#log('INFO',  'system',  message, context); }
  warn(message, context = {})    { this.#log('WARN',  'system',  message, context); }
  error(message, context = {})   { this.#log('ERROR', 'system',  message, context); }

  #log(levelStr, phase, message, context) {
    const levelNum = LEVEL[levelStr] ?? LEVEL.INFO;
    if (levelNum < this.#level) return;
    const entry = {
      ts: new Date().toISOString(), level: levelStr, phase,
      name: this.#name, component: this.#component, message,
      ...this.#flattenContext(context),
    };
    if (this.#jsonMode) {
      const line = JSON.stringify(entry);
      levelNum >= LEVEL.ERROR ? process.stderr.write(line + '\n') : process.stdout.write(line + '\n');
    } else {
      this.#prettyPrint(entry, levelNum, phase);
    }
  }

  #prettyPrint(entry, levelNum, phase) {
    const color      = PHASE_COLORS[phase] ?? ANSI.white;
    const symbol     = PHASE_SYMBOLS[phase] ?? '  ';
    const timestamp  = entry.ts.substring(11, 23);
    const levelTag   = this.#levelTag(levelNum);
    const contextStr = this.#formatContext(entry);
    const line = [
      ANSI.dim + timestamp + ANSI.reset,
      levelTag,
      color + symbol + ANSI.bold + `[${phase.toUpperCase()}]` + ANSI.reset,
      ANSI.dim + `[${entry.name}]` + ANSI.reset,
      entry.message,
      contextStr ? ANSI.dim + contextStr + ANSI.reset : '',
    ].filter(Boolean).join(' ');
    levelNum >= LEVEL.ERROR ? process.stderr.write(line + '\n') : process.stdout.write(line + '\n');
  }

  #levelTag(levelNum) {
    switch (levelNum) {
      case LEVEL.DEBUG: return ANSI.gray   + '[DEBUG]' + ANSI.reset;
      case LEVEL.INFO:  return ANSI.cyan   + '[INFO] ' + ANSI.reset;
      case LEVEL.WARN:  return ANSI.yellow + '[WARN] ' + ANSI.reset;
      case LEVEL.ERROR: return ANSI.bgRed  + ANSI.white + '[ERROR]' + ANSI.reset;
      default:          return '[?????]';
    }
  }

  #flattenContext(context) {
    if (!context || typeof context !== 'object') return {};
    const flat = {};
    for (const [k, v] of Object.entries(context)) {
      flat[k] = v instanceof Error ? { message: v.message, stack: v.stack } : v;
    }
    return flat;
  }

  #formatContext(entry) {
    const skip = new Set(['ts', 'level', 'phase', 'name', 'component', 'message']);
    return Object.entries(entry)
      .filter(([k]) => !skip.has(k) && entry[k] != null)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' ');
  }
}
