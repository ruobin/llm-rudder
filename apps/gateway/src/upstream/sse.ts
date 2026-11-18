export interface SseEvent {
  /** The event exactly as received, without the trailing blank line. */
  raw: string;
  /** Joined data lines, or null when the block has none. */
  data: string | null;
  event: string | null;
  isComment: boolean;
}

const EVENT_BOUNDARY = /\r\n\r\n|\n\n|\r\r/;

function parseBlock(raw: string): SseEvent {
  const data: string[] = [];
  let event: string | null = null;
  let sawField = false;
  for (const line of raw.split(/\r\n|\n|\r/)) {
    if (line === "" || line.startsWith(":")) continue;
    sawField = true;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  }
  return { raw, data: data.length > 0 ? data.join("\n") : null, event, isComment: !sawField };
}

/** Incremental server-sent events parser. Chunks may split events or characters. */
export class SseDecoder {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  push(chunk: Uint8Array): SseEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    // A trailing \r may be the first half of \r\n, so wait for the next chunk.
    const events: SseEvent[] = [];
    for (;;) {
      const match = EVENT_BOUNDARY.exec(this.buffer);
      if (!match) break;
      const end = match.index + match[0].length;
      if (end === this.buffer.length && this.buffer.endsWith("\r")) break;
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(end);
      if (block !== "") events.push(parseBlock(block));
    }
    return events;
  }

  /** Returns any final event that was not followed by a blank line. */
  flush(): SseEvent[] {
    this.buffer += this.decoder.decode();
    const block = this.buffer.replace(/[\r\n]+$/, "");
    this.buffer = "";
    return block === "" ? [] : [parseBlock(block)];
  }
}
