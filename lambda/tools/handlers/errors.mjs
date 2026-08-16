export class ToolRequestError extends Error {
  constructor(message, {
    statusCode = 400,
    code = "invalid_request",
    action,
    transportError = false,
  } = {}) {
    super(message);
    this.name = "ToolRequestError";
    this.statusCode = statusCode;
    this.code = code;
    this.action = action;
    this.transportError = transportError;
  }
}

export function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolRequestError(`${field} is required`, {
      transportError: true,
    });
  }
  return value.trim();
}
