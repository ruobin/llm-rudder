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

export function errorBody(
  message: string,
  type: string,
  code: string | null,
  param: string | null = null,
) {
  return { error: { message, type, param, code } };
}
