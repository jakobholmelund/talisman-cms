import { formatValidationIssues } from '../types';
import { isEntryNotFound, isRevisionConflict, isSlugConflict } from '../versioning';
import { ConflictError, HookError, ServiceError, ValidationError, constraintErrorFrom, isDatabaseError, type ServiceErrorCode } from '../service/errors';

const CODES: Record<number, ServiceErrorCode> = { 403: 'forbidden', 404: 'not_found', 405: 'unsupported', 409: 'conflict', 413: 'payload_too_large', 428: 'precondition_required' };

/** A client mistake only the HTTP layer sees: a bad body, cursor or path segment. */
export class HttpError extends ServiceError {
  constructor(status: number, message: string) {
    super(CODES[status] ?? 'invalid_input', status, message);
    this.name = 'HttpError';
  }
}

export const INTERNAL_ERROR_MESSAGE = 'The request could not be completed. Check the server logs for details.';

/**
 * The one place a service failure becomes an admin API response. Client mistakes get a 4xx with a
 * message for editors. Other failures are logged and answered with a generic 500, since database
 * errors carry the SQL statement and the submitted values.
 */
export function toErrorResponse(error: unknown, context: string): Response {
  if (error instanceof ValidationError) {
    return Response.json({ ...formatValidationIssues(error.issues), ...error.details }, { status: 400 });
  }
  // A stale write names its code and the record's current version, so a client can reload and retry.
  if (error instanceof ConflictError && error.code === 'stale_record') {
    return Response.json({ error: error.message, code: error.code, version: error.version ?? null }, { status: error.status });
  }
  // A hook failure is answered below, once a database cause has been ruled out.
  if (error instanceof ServiceError && !(error instanceof HookError)) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (isRevisionConflict(error) || isSlugConflict(error)) {
    return Response.json({ error: (error as Error).message }, { status: 409 });
  }
  if (isEntryNotFound(error)) {
    return Response.json({ error: (error as Error).message }, { status: 404 });
  }

  const constraint = constraintErrorFrom(error);
  if (constraint) {
    return Response.json({ error: constraint.message }, { status: constraint.status });
  }

  console.error(`[talisman-cms] ${context}:`, error);
  const message = error instanceof HookError && !isDatabaseError(error) ? error.message : INTERNAL_ERROR_MESSAGE;
  return Response.json({ status: 'error', error: message, message }, { status: 500 });
}
