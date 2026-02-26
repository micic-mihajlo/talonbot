export class Logger {
  constructor(private readonly namespace: string, private readonly level: 'debug' | 'info' | 'warn' | 'error' = 'info') {}

  private shouldLog(level: keyof typeof Logger.levels) {
    return Logger.levels[level] >= Logger.levels[this.level];
  }

  static levels = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  } as const;

  private emit(level: keyof typeof Logger.levels, ...args: unknown[]) {
    if (!this.shouldLog(level)) return;
    const tag = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${this.namespace}]`;
    // eslint-disable-next-line no-console
    (console as any)[level === 'debug' ? 'log' : level](tag, ...args);
  }

  debug(...args: unknown[]) { this.emit('debug', ...args); }
  info(...args: unknown[]) { this.emit('info', ...args); }
  warn(...args: unknown[]) { this.emit('warn', ...args); }
  error(...args: unknown[]) { this.emit('error', ...args); }
}

export const createLogger = (namespace: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info') =>
  new Logger(namespace, level);
