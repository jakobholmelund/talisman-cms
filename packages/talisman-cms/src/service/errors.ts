import { formatValidationIssues, type FieldValidationIssue } from '../types';

export type ServiceErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  | 'payload_too_large'
  | 'precondition_required'
  | 'conflict'
  | 'unsupported'
  | 'hook_failed';

/**
 * A failure the caller can act on, with the status the admin API answers. The SDK throws the same
 * classes, so server code matches them by class or `code`. Anything else the service throws is an
 * internal failure, which the admin API logs and answers with a generic 500.
 */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly status: number;

  constructor(code: ServiceErrorCode, status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ServiceError';
    this.code = code;
    this.status = status;
  }
}

/** Input that failed validation; `issues` name the fields, as the admin API's `fieldErrors` do. */
export class ValidationError extends ServiceError {
  readonly issues: FieldValidationIssue[];
  /** Extra members of the admin API's error body, such as zod's `flatten()` output for globals. */
  readonly details?: Record<string, unknown>;

  constructor(issues: FieldValidationIssue[], details?: Record<string, unknown>) {
    super('invalid_input', 400, formatValidationIssues(issues).error);
    this.name = 'ValidationError';
    this.issues = issues;
    this.details = details;
  }
}

/** Input the operation cannot use at all (not an object, invalid JSON), with no field to point at. */
export class InvalidInputError extends ServiceError {
  constructor(message: string) {
    super('invalid_input', 400, message);
    this.name = 'InvalidInputError';
  }
}

export class AccessDeniedError extends ServiceError {
  constructor(message = 'Collection access denied') {
    super('forbidden', 403, message);
    this.name = 'AccessDeniedError';
  }
}

export class NotFoundError extends ServiceError {
  constructor(message: string) {
    super('not_found', 404, message);
    this.name = 'NotFoundError';
  }
}

export class PayloadTooLargeError extends ServiceError {
  constructor(message = 'The request body is too large.') {
    super('payload_too_large', 413, message);
    this.name = 'PayloadTooLargeError';
  }
}

/** A write on a record that has revisions arrived without the revision the caller loaded. */
export class PreconditionRequiredError extends ServiceError {
  constructor(message = 'expectedRevisionId is required') {
    super('precondition_required', 428, message);
    this.name = 'PreconditionRequiredError';
  }
}

export const NATIVE_RECORD_CONFLICT_MESSAGE = 'This record changed since it was opened. Reload it before saving.';

/** A native row changed since the caller loaded it (its `updatedAt` no longer matches). */
export class NativeRecordConflictError extends ServiceError {
  constructor() {
    super('conflict', 409, NATIVE_RECORD_CONFLICT_MESSAGE);
    this.name = 'NativeRecordConflictError';
  }
}

/** An operation the collection does not support, such as publishing a native record. */
export class UnsupportedOperationError extends ServiceError {
  constructor(message: string) {
    super('unsupported', 400, message);
    this.name = 'UnsupportedOperationError';
  }
}

/** A database constraint refused the write; the message names the columns, never the statement. */
export class ConstraintError extends ServiceError {
  constructor(status: 400 | 409 | 413, message: string, options?: ErrorOptions) {
    super(status === 409 ? 'conflict' : status === 413 ? 'payload_too_large' : 'invalid_input', status, message, options);
    this.name = 'ConstraintError';
  }
}

export type HookPhase = 'beforeValidate' | 'beforeChange' | 'afterChange' | 'beforeDelete' | 'afterDelete';

/**
 * Wraps an error thrown by a collection hook, whose message is written for editors. `committed`
 * says whether the write had already been stored when the hook failed (the after* phases).
 */
export class HookError extends ServiceError {
  readonly phase: HookPhase;
  readonly committed: boolean;

  constructor(cause: unknown, phase: HookPhase) {
    super('hook_failed', 500, cause instanceof Error ? cause.message : 'A collection hook failed', { cause });
    this.name = 'HookError';
    this.phase = phase;
    this.committed = phase === 'afterChange' || phase === 'afterDelete';
  }
}

export function isServiceError(error: unknown): error is ServiceError {
  return error instanceof ServiceError;
}

/** Drizzle reports a failed statement as "Failed query: <sql> params: <values>"; D1 adds its own prefix. */
export function isDatabaseError(error: unknown): boolean {
  for (let current: any = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    const message = typeof current.message === 'string' ? current.message : '';
    if (current.name === 'DrizzleQueryError' || message.startsWith('Failed query:') || /D1_ERROR|SQLITE_/.test(message)) {
      return true;
    }
  }
  return false;
}

/** Turns a SQLite constraint failure into a ConstraintError without the statement or its values. */
export function constraintErrorFrom(error: unknown): ConstraintError | null {
  if (error instanceof ConstraintError) return error;
  for (let current: any = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    const message = typeof current.message === 'string' ? current.message : '';
    // The statement text of a DrizzleQueryError holds the submitted values, so only its cause is read.
    if (message.startsWith('Failed query:')) continue;
    const columns = message.match(/constraint failed: ([\w.]+(?:, [\w.]+)*)/)?.[1]
      ?.split(', ').map((column: string) => column.split('.').pop()).join(', ');
    if (/UNIQUE constraint failed/i.test(message)) {
      return new ConstraintError(409, columns ? `Another record already uses this ${columns}.` : 'Another record already uses this value.', { cause: error });
    }
    if (/NOT NULL constraint failed/i.test(message)) {
      return new ConstraintError(400, columns ? `A value is required for ${columns}.` : 'A required value is missing.', { cause: error });
    }
    if (/FOREIGN KEY constraint failed/i.test(message)) {
      return new ConstraintError(409, 'This change conflicts with a related record.', { cause: error });
    }
    if (/CHECK constraint failed/i.test(message)) {
      return new ConstraintError(400, 'A value is not allowed.', { cause: error });
    }
    if (/SQLITE_TOOBIG|string or blob too big/i.test(message)) {
      return new ConstraintError(413, 'This content is too large to store.', { cause: error });
    }
  }
  return null;
}
