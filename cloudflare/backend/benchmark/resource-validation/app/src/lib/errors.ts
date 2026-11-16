export type ErrorMap = Record<string, string[]>;

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly errors: ErrorMap;

  constructor(statusCode: number, errors: ErrorMap) {
    super('API Error');
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.errors = errors;
  }
}

export function unauthorizedError(field: string, message: string): ApiError {
  return new ApiError(401, { [field]: [message] });
}

export function forbiddenError(resource: string): ApiError {
  return new ApiError(403, { [resource]: ['forbidden'] });
}

export function notFoundError(resource: string): ApiError {
  return new ApiError(404, { [resource]: ['not found'] });
}

export function conflictError(errors: ErrorMap): ApiError {
  return new ApiError(409, errors);
}

export function validationError(errors: ErrorMap): ApiError {
  return new ApiError(422, errors);
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}
