/**
 * Domain errors. Services throw these; the Fastify error handler maps them to
 * HTTP responses. Never throw raw provider errors across the API boundary.
 */
export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'یافت نشد', details?: unknown) {
    super(404, 'not_found', message, details)
  }
}

export class ConflictError extends AppError {
  constructor(message = 'تعارض با وضعیت فعلی', details?: unknown) {
    super(409, 'conflict', message, details)
  }
}

export class ValidationError extends AppError {
  constructor(message = 'داده ورودی نامعتبر است', details?: unknown) {
    super(422, 'validation_error', message, details)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'احراز هویت انجام نشده است') {
    super(401, 'unauthorized', message)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'دسترسی مجاز نیست') {
    super(403, 'forbidden', message)
  }
}

export class InsufficientFundsError extends AppError {
  constructor(message = 'موجودی کیف پول کافی نیست') {
    super(422, 'insufficient_funds', message)
  }
}

export class PaymentRequiredError extends AppError {
  constructor(message = 'پرداخت الزامی است') {
    super(402, 'payment_required', message)
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'درخواست نامعتبر است', details?: unknown) {
    super(400, 'bad_request', message, details)
  }
}

/** Provider-side permanent failure (e.g. invalid request, not allowed). */
export class ProviderPermanentError extends AppError {
  constructor(message: string, details?: unknown) {
    super(502, 'provider_permanent_error', message, details)
  }
}

/** Provider-side transient failure (safe to retry later). */
export class ProviderRetryableError extends AppError {
  constructor(message: string, details?: unknown) {
    super(502, 'provider_retryable_error', message, details)
  }
}

/** The provider call result is ambiguous (timeout after dispatch). */
export class ProviderUnknownError extends AppError {
  constructor(message = 'نتیجه عملیات سرویس‌دهنده نامشخص است', details?: unknown) {
    super(502, 'provider_unknown_error', message, details)
  }
}