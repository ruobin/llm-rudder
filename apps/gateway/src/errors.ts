/** An error that is returned to the client in OpenAI's error format. */
export class RouterError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly type: string = "router_error",
    readonly headers: Record<string, string> = {},
    readonly param: string | null = null,
  ) {
    super(message);
    this.name = "RouterError";
  }
}

const ANTHROPIC_ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  402: "billing_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  504: "timeout_error",
  529: "overloaded_error",
};

export function anthropicErrorBody(status: number, message: string, requestId?: string) {
  const type =
    ANTHROPIC_ERROR_TYPES[status] ?? (status >= 500 ? "api_error" : "invalid_request_error");
  return {
    type: "error",
    error: { type, message },
    ...(requestId === undefined ? {} : { request_id: requestId }),
  };
}

export function errorBody(
  message: string,
  type: string,
  code: string | null,
  param: string | null = null,
) {
  return { error: { message, type, param, code } };
}
