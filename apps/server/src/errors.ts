/** An error safe to expose to the browser; details must never contain credentials. */
export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

/** Maps unexpected implementation errors to a non-sensitive public response. */
export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: 'DEVICE_ERROR', message: 'The device operation failed. Check the device and connection, then retry.' };
}
