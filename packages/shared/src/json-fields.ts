/**
 * Reads and replaces one top-level string in JSON without re-encoding the rest.
 *
 * Parsing and re-serializing a request can reorder numeric object keys and
 * change number formats, which alters what Anthropic's prompt cache sees. These
 * helpers work on the original bytes, so everything else stays identical.
 */

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;

export interface StringField {
  value: string;
  /** Byte offset of the opening quote. */
  start: number;
  /** Byte offset just after the closing quote. */
  end: number;
}

const isSpace = (byte: number | undefined) =>
  byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;

function skipSpace(bytes: Buffer, from: number): number {
  let index = from;
  while (isSpace(bytes[index])) index += 1;
  return index;
}

/** Returns the offset just after the string starting at `from`, or -1. */
function stringEnd(bytes: Buffer, from: number): number {
  for (let index = from + 1; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === BACKSLASH) index += 1;
    else if (byte === QUOTE) return index + 1;
  }
  return -1;
}

/** Returns the offset just after the value starting at `from`, or -1. */
function valueEnd(bytes: Buffer, from: number): number {
  const first = bytes[from];
  if (first === QUOTE) return stringEnd(bytes, from);
  if (first === OPEN_BRACE || first === OPEN_BRACKET) {
    let depth = 0;
    for (let index = from; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (byte === QUOTE) {
        const end = stringEnd(bytes, index);
        if (end === -1) return -1;
        index = end - 1;
      } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
        depth += 1;
      } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return -1;
  }
  let index = from;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (isSpace(byte) || byte === COMMA || byte === CLOSE_BRACE || byte === CLOSE_BRACKET) break;
    index += 1;
  }
  return index > from ? index : -1;
}

function decodeString(bytes: Buffer, start: number, end: number): string | null {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8", start, end));
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Finds a top-level string field. Returns null when the field is absent, is not
 * a string, or the body is not a JSON object. As in JSON.parse, the last
 * duplicate wins.
 */
export function findTopLevelString(body: Buffer, field: string): StringField | null {
  let index = skipSpace(body, 0);
  if (body[index] !== OPEN_BRACE) return null;
  index = skipSpace(body, index + 1);
  let found: StringField | null = null;

  while (index < body.length) {
    if (body[index] === CLOSE_BRACE) return found;
    if (body[index] !== QUOTE) return null;
    const keyEnd = stringEnd(body, index);
    if (keyEnd === -1) return null;
    const key = decodeString(body, index, keyEnd);

    index = skipSpace(body, keyEnd);
    if (body[index] !== COLON) return null;
    index = skipSpace(body, index + 1);

    const start = index;
    const end = valueEnd(body, start);
    if (end === -1) return null;
    if (key === field) {
      const value = body[start] === QUOTE ? decodeString(body, start, end) : null;
      found = value === null ? null : { value, start, end };
    }

    index = skipSpace(body, end);
    if (body[index] === COMMA) index = skipSpace(body, index + 1);
    else if (body[index] !== CLOSE_BRACE) return null;
  }
  return null;
}

/** Sets a top-level string field. Returns null when the field cannot be found. */
export function replaceTopLevelString(body: Buffer, field: string, value: string): Buffer | null {
  const found = findTopLevelString(body, field);
  if (!found) return null;
  if (found.value === value) return body;
  return Buffer.concat([
    body.subarray(0, found.start),
    Buffer.from(JSON.stringify(value), "utf8"),
    body.subarray(found.end),
  ]);
}
