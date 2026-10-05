export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    /** Safe, structured detail sent to the client, such as which fields were wrong. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}
