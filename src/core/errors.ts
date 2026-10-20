export type ErrorKind = 'auth' | 'retryable' | 'permanent' | 'ambiguous' | 'limit' | 'cancelled';

export class SfError extends Error {
  constructor(
    message: string,
    public kind: ErrorKind,
    public status = 0,
    public errorCode = '',
    public fields: string[] = [],
  ) {
    super(message);
    this.name = 'SfError';
  }
}

export class CancelledError extends SfError {
  constructor() {
    super('Cancelled by user', 'cancelled');
  }
}

export interface CancelToken {
  cancelled: boolean;
}

export function checkCancel(token?: CancelToken): void {
  if (token?.cancelled) throw new CancelledError();
}

/** Record-level error codes that mean the record was not written and the write can be retried. */
export const RETRYABLE_RECORD_CODES = new Set(['UNABLE_TO_LOCK_ROW', 'SERVER_UNAVAILABLE']);

/** Removes anything that looks like a session id or bearer token from a message before display. */
export function sanitize(message: string): string {
  return message
    .replace(/00D[a-zA-Z0-9]{12,15}![A-Za-z0-9._\-]{20,}/g, '[session]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}
