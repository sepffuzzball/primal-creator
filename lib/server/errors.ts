/**
 * Consistent API error model.
 *
 * Every thrown ApiError maps to a JSON body of the shape
 * `{ error: { code, message } }` with the given HTTP status. Route handlers use
 * `respond()` to centralize conversion so that 400/401/403/404/409 responses are
 * uniform across the app. Unexpected errors become a 500 with a generic message
 * (the real error is logged server-side, never leaked).
 */

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

export function badRequest(code: string, message: string): ApiError {
  return new ApiError(400, code, message)
}

export function unauthorized(
  code = "unauthorized",
  message = "Not authenticated"
): ApiError {
  return new ApiError(401, code, message)
}

export function forbidden(
  code = "forbidden",
  message = "Not allowed"
): ApiError {
  return new ApiError(403, code, message)
}

export function notFound(code = "not_found", message = "Not found"): ApiError {
  return new ApiError(404, code, message)
}

export function conflict(code = "conflict", message = "Conflict"): ApiError {
  return new ApiError(409, code, message)
}

export function errorBody(status: number, code: string, message: string) {
  return { error: { code, message } }
}

/**
 * Wrap a route handler so that any thrown ApiError (or unexpected error) is
 * converted into a JSON error response. Route handlers should be authored as
 * `return respond(async () => { ... })`.
 */
export async function respond<T extends Response>(
  fn: () => Promise<T> | T
): Promise<Response> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ApiError) {
      return Response.json(errorBody(err.status, err.code, err.message), {
        status: err.status,
      })
    }
    console.error("[api] unexpected error", err)
    return Response.json(errorBody(500, "internal", "Internal server error"), {
      status: 500,
    })
  }
}
