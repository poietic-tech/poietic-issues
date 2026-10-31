/** One JSON line per record on stdout (info) or stderr (warn, error), for `kubectl logs`. */
export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function jsonLogger(write: (line: string, level: string) => void = defaultWrite): Logger {
  const at =
    (level: string) =>
    (event: string, fields: Record<string, unknown> = {}) =>
      write(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }), level);
  return { info: at('info'), warn: at('warn'), error: at('error') };
}

function defaultWrite(line: string, level: string): void {
  (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`);
}

/** A logger that drops everything, for tests. */
export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** An error's message, with its cause, for a log field. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` (cause: ${error.cause.message})` : '';
  return `${error.name}: ${error.message}${cause}`;
}
