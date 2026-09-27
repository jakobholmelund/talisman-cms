export * from './db/client';
// Thrown by getClient().entries: a slug another entry uses, a save based on a stale revision, or a
// missing entry. PendingPublishWorkflow describes a publish still running in its Workflow.
// invalidateEntryCache clears the cached reads of rows that server code wrote to D1 directly.
export {
  EntryNotFoundError,
  RevisionConflictError,
  SlugConflictError,
  type PendingPublishWorkflow
} from './versioning';
// invalidateGlobalCache and invalidateCollectionCache do the same for globals and the collection list.
export { invalidateCollectionCache, invalidateEntryCache, invalidateGlobalCache } from './service/cache';
// The errors the service throws for a caller's mistake, with the status the admin API answers.
// A collection hook may throw one to refuse a write with that status.
export {
  AccessDeniedError,
  ConstraintError,
  HookError,
  NativeRecordConflictError,
  NotFoundError,
  PayloadTooLargeError,
  PreconditionRequiredError,
  ServiceError,
  UnsupportedOperationError,
  ValidationError,
  isServiceError,
  type HookPhase,
  type ServiceErrorCode
} from './service/errors';
