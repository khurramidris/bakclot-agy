// One error shape for the whole public API: { "error": { "type", "code", "message", "param" } }, with the HTTP status
// telling the class of problem. Every internal error is mapped here, so a developer never sees a stack trace, a table
// name or which provider we use.

import { PermanentError } from '../queue.js';

export type ApiErrorType = 'invalid_request' | 'authentication_error' | 'insufficient_credit' | 'permission_error' | 'not_found'
  | 'idempotency_error' | 'content_refused' | 'rate_limited' | 'server_error' | 'service_unavailable';

export class ApiError extends Error {
  /** Seconds the client should wait before trying again (sent as Retry-After). */
  retryAfter?: number;
  constructor(public status: number, public type: ApiErrorType, public code: string, message: string, public param?: string) { super(message); }
}

export const invalid = (message: string, param?: string, code = 'invalid_request') => new ApiError(400, 'invalid_request', code, message, param);
export const notFound = (what = 'resource') => new ApiError(404, 'not_found', 'not_found', `No such ${what}.`);

/** Postgres saying "busy right now": a lock wait or a transaction that timed out. Safe to retry. */
const BUSY = new Set(['55P03', '25P03', '57014', '40P01', '40001']);

export function toApiError(e: any): ApiError {
  if (e instanceof ApiError) return e;
  if (e?.name === 'ZodError') {
    const issue = (e.issues || [])[0];
    const param = issue?.path?.length ? issue.path.join('.') : undefined;
    const msg = issue ? `${param ? `${param}: ` : ''}${issue.code === 'unrecognized_keys' ? `unknown field(s) ${(issue.keys || []).join(', ')}` : issue.message}` : 'Invalid request.';
    return new ApiError(400, 'invalid_request', 'invalid_request', msg, param);
  }
  if (e instanceof SyntaxError) return invalid('The request body is not valid JSON.');
  if (BUSY.has(e?.code)) return new ApiError(503, 'service_unavailable', 'busy', 'We’re handling a lot right now. Please retry in a moment.');
  if (e?.code === 'busy') return new ApiError(503, 'service_unavailable', 'busy', e.message);
  if (e instanceof PermanentError || typeof e?.code === 'string') {
    const code = String(e.code);
    switch (code) {
      case 'bad_input': case 'bad_request': case 'too_long': case 'consent_required': case 'permanent':
        return new ApiError(400, 'invalid_request', code === 'permanent' ? 'invalid_request' : code, e.message, e.param);
      case 'insufficient_credit': return new ApiError(402, 'insufficient_credit', code, e.message);
      case 'not_found': return notFound();
      case 'sensitive_content': return new ApiError(422, 'content_refused', 'content_refused', e.message);
      case 'bad_state': case 'conflict': return new ApiError(409, 'invalid_request', 'bad_state', e.message);
      case 'rate_limited': return new ApiError(429, 'rate_limited', code, e.message);
      case 'config': return new ApiError(503, 'service_unavailable', 'unavailable', 'This is not available right now.');
    }
  }
  return new ApiError(500, 'server_error', 'server_error', 'Something went wrong on our side. It is safe to retry with the same Idempotency-Key.');
}

export const errorBody = (e: ApiError) => ({ error: { type: e.type, code: e.code, message: e.message, ...(e.param ? { param: e.param } : {}) } });
