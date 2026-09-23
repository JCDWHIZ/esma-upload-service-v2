export interface AppErrorOptions {
  code: string;
  statusCode: number;
  message: string;
  detail?: string;
  errors?: unknown[];
  correlationId?: string;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly detail?: string;
  public readonly errors?: unknown[];
  public correlationId?: string;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = 'AppError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.detail = options.detail;
    this.errors = options.errors;
    this.correlationId = options.correlationId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
