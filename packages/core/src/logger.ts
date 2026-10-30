import type { LogLevel } from "./config.ts";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured JSON logger. Never logs secret values; callers must pass redacted fields. */
export class Logger {
  constructor(private level: LogLevel = "info", private bindings: Record<string, unknown> = {}) {}

  child(bindings: Record<string, unknown>): Logger {
    return new Logger(this.level, { ...this.bindings, ...bindings });
  }

  private emit(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.bindings,
      ...fields,
    });
    if (level === "error" || level === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  }

  debug(msg: string, f?: Record<string, unknown>) { this.emit("debug", msg, f); }
  info(msg: string, f?: Record<string, unknown>) { this.emit("info", msg, f); }
  warn(msg: string, f?: Record<string, unknown>) { this.emit("warn", msg, f); }
  error(msg: string, f?: Record<string, unknown>) { this.emit("error", msg, f); }
}
