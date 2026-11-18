import { describe, expect, it } from "vitest";
import { profileFor, parseModelCatalog, type ModelCatalog } from "../src/config/models.js";
import {
  ChatStreamDecoder,
  ChatStreamEncoder,
  decodeChatRequest,
  decodeChatResponse,
  encodeChatRequest,
  encodeChatResponse,
} from "../src/translate/chat.js";
import { chooseEffort, type EncodeTarget, type ResponseContext } from "../src/translate/codec.js";
import type { IRRequest, IRStreamEvent } from "../src/translate/ir.js";
import {
  decodeMessagesRequest,
  decodeMessagesResponse,
  encodeMessagesRequest,
  encodeMessagesResponse,
  maxTokensFor,
  MessagesStreamDecoder,
  MessagesStreamEncoder,
} from "../src/translate/messages.js";
import { cleanCallId, geminiSchema, ToolNames } from "../src/translate/names.js";
import {
  decodeResponsesRequest,
  decodeResponsesResponse,
  encodeResponsesRequest,
  encodeResponsesResponse,
  ResponsesStreamDecoder,
  ResponsesStreamEncoder,
} from "../src/translate/responses.js";
import { SseDecoder } from "../src/upstream/sse.js";
import {
  anthropicMessageBody,
  anthropicTextStream,
  anthropicToolStream,
  chatToolStream,
  completionBody,
  responsesBody,
  responsesTextStream,
  responsesToolStream,
  textStream,
  type FakeStep,
} from "../src/dev/fake-upstream.js";
import type { JsonObject } from "../src/types.js";
import { MODELS } from "./helpers.js";

const catalog = parseModelCatalog(MODELS) as ModelCatalog;

function target(model: string, ir: IRRequest, overrides: Partial<EncodeTarget> = {}): EncodeTarget {
  return {
    model,
    profile: profileFor(catalog, model),
    names: new ToolNames(ir.tools),
    geminiSchemas: false,
    autoCache: true,
    sessionKey: "session-1",
    replay: () => undefined,
    ...overrides,
  };
}

function responseContext(ir: IRRequest, overrides: Partial<ResponseContext> = {}): ResponseContext {
  return {
    names: new ToolNames(ir.tools),
    customTools: new Set(
      ir.tools.filter((tool) => tool.kind === "custom").map((tool) => tool.name),
    ),
    now: 1_800_000_000_000,
    requestedModel: "requested-model",
    servedModel: "served-model",
    wantsUsage: true,
    showReasoning: true,
    inputEstimate: 10,
    ...overrides,
  };
}

const weatherSchema = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
};

/** One conversation, written once in each format. */
const chatRequest: JsonObject = {
  model: "m",
  messages: [
    { role: "system", content: "Be brief." },
    {
      role: "user",
      content: [
        { type: "text", text: "Weather here?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD", detail: "high" } },
      ],
    },
    {
      role: "assistant",
      content: "Checking.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "weather", arguments: '{"city":"Oslo"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "Sunny" },
    { role: "user", content: "Thanks" },
  ],
  tools: [
    {
      type: "function",
      function: { name: "weather", description: "Get weather", parameters: weatherSchema },
    },
  ],
  tool_choice: "auto",
  parallel_tool_calls: false,
  max_completion_tokens: 500,
  temperature: 0.5,
  stop: ["END"],
  reasoning_effort: "high",
};

const messagesRequest: JsonObject = {
  model: "m",
  max_tokens: 500,
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=1;" },
    { type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } },
  ],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Weather here?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "call_1", name: "weather", input: { city: "Oslo" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "Sunny" },
        { type: "text", text: "Thanks" },
      ],
    },
  ],
  tools: [{ name: "weather", description: "Get weather", input_schema: weatherSchema }],
  tool_choice: { type: "auto", disable_parallel_tool_use: true },
  temperature: 0.5,
  stop_sequences: ["END"],
  thinking: { type: "adaptive", display: "omitted" },
  output_config: { effort: "high" },
  context_management: { edits: [] },
  metadata: { user_id: "private" },
};

const responsesRequest: JsonObject = {
  model: "m",
  input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Be brief." }] },
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Weather here?" },
        { type: "input_image", image_url: "data:image/png;base64,QUJD", detail: "auto" },
      ],
    },
    {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "secret-reasoning",
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Checking.", annotations: [] }],
    },
    { type: "function_call", call_id: "call_1", name: "weather", arguments: '{"city":"Oslo"}' },
    { type: "function_call_output", call_id: "call_1", output: "Sunny" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Thanks" }] },
  ],
  tools: [
    {
      type: "function",
      name: "weather",
      description: "Get weather",
      parameters: weatherSchema,
      strict: false,
    },
  ],
  tool_choice: "auto",
  parallel_tool_calls: false,
  max_output_tokens: 500,
  temperature: 0.5,
  reasoning: { effort: "high", summary: "auto" },
  store: false,
  include: ["reasoning.encrypted_content"],
};

describe("request translation", () => {
  const expectedMessages = {
    system: [{ type: "text", text: "Be brief." }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Weather here?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "call_1", name: "weather", input: { city: "Oslo" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [{ type: "text", text: "Sunny" }],
          },
          { type: "text", text: "Thanks" },
        ],
      },
    ],
    tools: [{ name: "weather", description: "Get weather", input_schema: weatherSchema }],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    max_tokens: 500,
    output_config: { effort: "high" },
    thinking: { type: "adaptive", display: "omitted" },
    cache_control: { type: "ephemeral" },
  };

  it("turns Chat Completions into Anthropic Messages", () => {
    const ir = decodeChatRequest(chatRequest);
    const body = encodeMessagesRequest(ir, target("claude-opus-5-5", ir, { effort: "high" }), true);
    expect(body).toMatchObject({ model: "claude-opus-5-5", stream: true, ...expectedMessages });
    // Current Claude models reject these.
    expect(body).not.toHaveProperty("temperature");
    expect(body.stop_sequences).toEqual(["END"]);
  });

  it("turns Responses into Anthropic Messages", () => {
    const ir = decodeResponsesRequest(responsesRequest);
    const body = encodeMessagesRequest(ir, target("claude-opus-5-5", ir, { effort: "high" }), true);
    expect(body).toMatchObject({
      ...expectedMessages,
      thinking: { type: "adaptive", display: "summarized" },
    });
    // OpenAI's reasoning means nothing to Anthropic.
    expect(JSON.stringify(body)).not.toContain("secret-reasoning");
  });

  const expectedChat = {
    messages: [
      { role: "system", content: "Be brief." },
      {
        role: "user",
        content: [
          { type: "text", text: "Weather here?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
        ],
      },
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "weather", arguments: '{"city":"Oslo"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "Sunny" },
      { role: "user", content: "Thanks" },
    ],
    tools: [
      {
        type: "function",
        function: { name: "weather", description: "Get weather", parameters: weatherSchema },
      },
    ],
    parallel_tool_calls: false,
    max_tokens: 500,
    reasoning_effort: "high",
  };

  it("turns Anthropic Messages into Chat Completions", () => {
    const ir = decodeMessagesRequest(messagesRequest);
    const body = encodeChatRequest(
      ir,
      target("gemini-4-hydrogen", ir, { effort: "high", maxOutputTokens: 500 }),
      true,
    );
    expect(body).toMatchObject(expectedChat);
    const text = JSON.stringify(body);
    expect(text).not.toContain("x-anthropic-billing-header");
    expect(text).not.toContain("sig");
    expect(text).not.toContain("private");
  });

  it("turns Responses into Chat Completions", () => {
    const ir = decodeResponsesRequest(responsesRequest);
    const body = encodeChatRequest(
      ir,
      target("gw", ir, { effort: "high", maxOutputTokens: 500 }),
      false,
    );
    expect(body).toMatchObject({ ...expectedChat, temperature: 0.5 });
    expect(JSON.stringify(body)).not.toContain("secret-reasoning");
  });

  const expectedInput = [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Be brief." }] },
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Weather here?" },
        { type: "input_image", image_url: "data:image/png;base64,QUJD" },
      ],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Checking." }],
    },
    { type: "function_call", call_id: "call_1", name: "weather", arguments: '{"city":"Oslo"}' },
    { type: "function_call_output", call_id: "call_1", output: "Sunny" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Thanks" }] },
  ];

  it("turns Chat Completions into Responses", () => {
    const ir = decodeChatRequest(chatRequest);
    const body = encodeResponsesRequest(
      ir,
      target("gpt-6.2-astra", ir, { effort: "high", maxOutputTokens: 500 }),
      true,
    );
    expect(body).toMatchObject({
      model: "gpt-6.2-astra",
      input: expectedInput,
      store: false,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "session-1",
      parallel_tool_calls: false,
      tool_choice: "auto",
      max_output_tokens: 500,
      reasoning: { effort: "high" },
      tools: [{ type: "function", name: "weather", parameters: weatherSchema, strict: false }],
    });
    expect(body).not.toHaveProperty("temperature");
  });

  it("turns Anthropic Messages into Responses", () => {
    const ir = decodeMessagesRequest(messagesRequest);
    const body = encodeResponsesRequest(ir, target("gpt-6.2-astra", ir), true);
    expect(body.input).toMatchObject(expectedInput);
    expect(JSON.stringify(body)).not.toContain('"sig"');
  });

  it("keeps a model's own reasoning when it stays in the family", () => {
    const fromResponses = decodeResponsesRequest(responsesRequest);
    const openai = encodeResponsesRequest(
      fromResponses,
      target("gpt-6.2-astra", fromResponses),
      true,
    );
    expect(JSON.stringify(openai)).toContain("secret-reasoning");

    const fromMessages = decodeMessagesRequest(messagesRequest);
    const anthropic = encodeMessagesRequest(
      fromMessages,
      target("claude-opus-5-5", fromMessages),
      true,
    );
    expect((anthropic.messages as JsonObject[])[1]).toMatchObject({
      content: [{ type: "thinking", signature: "sig" }, { type: "text" }, { type: "tool_use" }],
    });
  });

  it("replays stored reasoning for a tool call", () => {
    const ir = decodeChatRequest(chatRequest);
    const thinking = { type: "thinking", thinking: "", signature: "kept" };
    const body = encodeMessagesRequest(
      ir,
      target("claude-opus-5-5", ir, { replay: (id) => (id === "call_1" ? [thinking] : undefined) }),
      true,
    );
    expect(((body.messages as JsonObject[])[1]!.content as JsonObject[])[0]).toEqual(thinking);

    const item = { type: "reasoning", id: "rs", summary: [], encrypted_content: "kept" };
    const responses = encodeResponsesRequest(
      ir,
      target("gpt-6.2-astra", ir, { replay: () => [item] }),
      true,
    );
    const input = responses.input as JsonObject[];
    const callIndex = input.findIndex((entry) => entry.type === "function_call");
    expect(input[callIndex - 1]).toEqual(item);
  });

  it("handles system messages inside a conversation", () => {
    const ir = decodeMessagesRequest({
      messages: [
        { role: "user", content: "One" },
        { role: "system", content: [{ type: "text", text: "Note" }] },
        { role: "user", content: "Two" },
      ],
    });
    const claude = encodeMessagesRequest(ir, target("claude-opus-5-5", ir), true);
    expect((claude.messages as JsonObject[]).map((m) => m.role)).toEqual([
      "user",
      "system",
      "user",
    ]);

    const older = encodeMessagesRequest(ir, target("claude-old", ir), true);
    expect((older.messages as JsonObject[]).map((m) => m.role)).toEqual(["user"]);
    expect(JSON.stringify(older.messages)).toContain("<system-reminder>");

    const chat = encodeChatRequest(ir, target("gw", ir), true);
    expect((chat.messages as JsonObject[]).map((m) => m.role)).toEqual(["user", "system", "user"]);
  });

  it("shows deferred tools only once a search has loaded them", () => {
    const tools = [
      { name: "Search", input_schema: { type: "object" } },
      { name: "Hidden", input_schema: { type: "object" }, defer_loading: true },
      { name: "Loaded", input_schema: { type: "object" }, defer_loading: true },
    ];
    const ir = decodeMessagesRequest({
      tools,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "tool_reference", tool_name: "Loaded" }],
            },
          ],
        },
      ],
    });
    expect(ir.tools.map((tool) => tool.name)).toEqual(["Search", "Loaded"]);
    expect(JSON.stringify(ir.messages)).toContain("The tool Loaded is now available.");
  });

  it("flattens namespaced tools and maps long names", () => {
    const long = `mcp__${"x".repeat(80)}__tool`;
    const ir = decodeResponsesRequest({
      input: "hi",
      tools: [
        { type: "namespace", name: "agents", tools: [{ type: "function", name: "close" }] },
        { type: "function", name: long },
      ],
    });
    const body = encodeChatRequest(ir, target("gw", ir), true);
    const names = (body.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names[0]).toBe("agents__close");
    expect(names[1]!.length).toBeLessThanOrEqual(64);
    expect(new ToolNames(ir.tools).original(names[1]!)).toEqual({ name: long });
    expect(new ToolNames(ir.tools).original("agents__close")).toEqual({
      name: "close",
      namespace: "agents",
    });
  });

  it("marks hosted tools as required only when the request depends on them", () => {
    const optional = decodeResponsesRequest({
      input: "hi",
      tools: [{ type: "function", name: "a" }, { type: "web_search" }],
    });
    expect(optional).toMatchObject({ hostedToolsRequired: false });
    expect(JSON.stringify(encodeChatRequest(optional, target("gw", optional), true))).not.toContain(
      "web_search",
    );
    expect(decodeResponsesRequest({ input: "hi", tools: [{ type: "web_search" }] })).toMatchObject({
      hostedToolsRequired: true,
    });
    expect(
      decodeMessagesRequest({
        messages: [],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    ).toMatchObject({ hostedToolsRequired: true });
  });

  it("applies the rules for current Claude models", () => {
    const ir = decodeChatRequest({
      messages: [
        { role: "user", content: "Say hi" },
        { role: "assistant", content: "Hi the" },
      ],
      tools: [{ type: "function", function: { name: "a", parameters: { type: "object" } } }],
      tool_choice: "required",
      temperature: 1,
    });
    const opus = encodeMessagesRequest(ir, target("claude-opus-5-5", ir), false);
    expect(opus.max_tokens).toBe(16_000);
    expect(opus.tool_choice).toEqual({ type: "auto" });
    expect(opus).not.toHaveProperty("temperature");
    expect((opus.messages as JsonObject[]).at(-1)!.role).toBe("user");
    expect(JSON.stringify(opus.messages)).toContain("ended with:\\nHi the");

    const haiku = encodeMessagesRequest(ir, target("claude-haiku-5-5", ir), true);
    expect(haiku.max_tokens).toBe(64_000);
    expect(haiku.tool_choice).toEqual({ type: "any" });
    expect(maxTokensFor(200_000, true, 128_000)).toBe(128_000);
  });

  it("uses an explicit cache marker where automatic caching is not available", () => {
    const ir = decodeChatRequest(chatRequest);
    const body = encodeMessagesRequest(
      ir,
      target("claude-opus-5-5", ir, { autoCache: false }),
      true,
    );
    expect(body).not.toHaveProperty("cache_control");
    expect((body.system as JsonObject[]).at(-1)!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("translates structured output", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const ir = decodeChatRequest({
      messages: [{ role: "user", content: "x" }],
      response_format: { type: "json_schema", json_schema: { name: "r", schema, strict: true } },
    });
    expect(encodeMessagesRequest(ir, target("claude-opus-5-5", ir), true).output_config).toEqual({
      format: { type: "json_schema", schema },
    });
    expect(encodeResponsesRequest(ir, target("gpt-6.2-astra", ir), true).text).toEqual({
      format: { type: "json_schema", name: "r", schema, strict: true },
    });
    const back = decodeResponsesRequest({
      input: "x",
      text: { format: { type: "json_schema", name: "r", schema } },
    });
    expect(encodeChatRequest(back, target("gw", back), true).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "r", schema },
    });
  });

  it("moves media out of tool results for Chat Completions", () => {
    const ir = decodeMessagesRequest({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t",
              is_error: true,
              content: [
                { type: "text", text: "see image" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "QQ==" },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(encodeChatRequest(ir, target("gw", ir), true).messages).toEqual([
      { role: "tool", tool_call_id: "t", content: "Error: see image" },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } }],
      },
    ]);
  });
});

describe("helpers", () => {
  it("picks the closest reasoning effort", () => {
    expect(chooseEffort("high", ["low", "high"])).toBe("high");
    expect(chooseEffort("xhigh", ["low", "medium", "high"])).toBe("high");
    expect(chooseEffort("none", ["low", "medium"])).toBe("low");
    expect(chooseEffort("max", undefined)).toBe("max");
  });

  it("cleans call IDs for Anthropic", () => {
    expect(cleanCallId("call:1/a")).toBe("call_1_a");
    expect(cleanCallId("toolu_ok-1")).toBe("toolu_ok-1");
  });

  it("reduces tool schemas to what Gemini documents", () => {
    expect(
      geminiSchema({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        properties: {
          a: { type: ["string", "null"], exclusiveMinimum: 1, description: "A" },
          b: { $ref: "#/$defs/B" },
          c: { const: "x" },
          d: { oneOf: [{ type: "string" }, { type: "number" }] },
          e: { type: "array", items: { type: "string", propertyNames: {} } },
        },
        required: ["a"],
        $defs: { B: { type: "number", minimum: 1 } },
      }),
    ).toEqual({
      type: "object",
      properties: {
        a: { type: "string", nullable: true, description: "A" },
        b: { type: "number", minimum: 1 },
        c: { enum: ["x"] },
        d: { anyOf: [{ type: "string" }, { type: "number" }] },
        e: { type: "array", items: { type: "string" } },
      },
      required: ["a"],
    });
  });

  it("reads the model catalog", () => {
    expect(profileFor(catalog, "gpt-6.2-sol")).toMatchObject({
      toolsOn: ["openai.responses"],
      sampling: false,
    });
    expect(profileFor(catalog, "claude-haiku-5-5")).toMatchObject({
      forcedToolChoice: true,
      prefill: false,
    });
    expect(profileFor(catalog, "unknown-model")).toMatchObject({ images: true, sampling: true });
    expect(parseModelCatalog("version: 1")).toEqual(
      expect.arrayContaining([expect.stringContaining("version")]),
    );
  });
});

// ---- Streams and complete responses, for every pair of formats ----

interface Reply {
  text: string;
  calls: { id: string; name: string; input: unknown }[];
  finish: string;
  usage?: JsonObject;
}

const eventsOf = (step: FakeStep) => (step as { events: string[] }).events;
const ir = decodeChatRequest({ messages: [{ role: "user", content: "x" }] });

function decoderFor(format: string, ctx: ResponseContext) {
  if (format === "chat") return new ChatStreamDecoder(ctx);
  if (format === "messages") return new MessagesStreamDecoder(ctx);
  return new ResponsesStreamDecoder(ctx);
}

function encoderFor(format: string, ctx: ResponseContext) {
  if (format === "chat") return new ChatStreamEncoder(ctx);
  if (format === "messages") return new MessagesStreamEncoder(ctx);
  return new ResponsesStreamEncoder(ctx);
}

function translateStream(from: string, to: string, step: FakeStep): string {
  const ctx = responseContext(ir);
  const decoder = decoderFor(from, ctx);
  const encoder = encoderFor(to, ctx);
  const sse = new SseDecoder();
  let output = "";
  let finished = false;
  for (const raw of eventsOf(step)) {
    for (const event of sse.push(Buffer.from(`${raw}\n\n`))) {
      for (const item of decoder.push(event) as IRStreamEvent[]) {
        if (item.type === "finish") finished = true;
        output += encoder.push(item);
      }
    }
  }
  expect(finished).toBe(true);
  return output + encoder.close();
}

function dataLines(text: string): JsonObject[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as JsonObject);
}

function readChat(text: string): Reply {
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  const reply: Reply = { text: "", calls: [], finish: "" };
  const args = new Map<number, string>();
  for (const chunk of dataLines(text)) {
    if (chunk.usage) reply.usage = chunk.usage as JsonObject;
    const choice = (chunk.choices as JsonObject[])[0];
    if (!choice) continue;
    const delta = choice.delta as JsonObject;
    reply.text += (delta.content as string | undefined) ?? "";
    for (const call of (delta.tool_calls as JsonObject[] | undefined) ?? []) {
      const index = call.index as number;
      const fn = call.function as JsonObject;
      if (call.id)
        reply.calls[index] = { id: call.id as string, name: fn.name as string, input: null };
      args.set(index, (args.get(index) ?? "") + (fn.arguments as string));
    }
    if (choice.finish_reason) reply.finish = choice.finish_reason as string;
  }
  reply.calls.forEach((call, index) => (call.input = JSON.parse(args.get(index) ?? "{}")));
  return reply;
}

function readMessages(text: string): Reply {
  const reply: Reply = { text: "", calls: [], finish: "" };
  const events = dataLines(text);
  expect(events[0]!.type).toBe("message_start");
  expect(events.at(-1)!.type).toBe("message_stop");
  const open = new Map<number, { json: string; call?: Reply["calls"][number] }>();
  for (const event of events) {
    if (event.type === "content_block_start") {
      const block = event.content_block as JsonObject;
      const entry: { json: string; call?: Reply["calls"][number] } = { json: "" };
      if (block.type === "tool_use") {
        entry.call = { id: block.id as string, name: block.name as string, input: null };
        reply.calls.push(entry.call);
      }
      open.set(event.index as number, entry);
    } else if (event.type === "content_block_delta") {
      const delta = event.delta as JsonObject;
      if (delta.type === "text_delta") reply.text += delta.text as string;
      else open.get(event.index as number)!.json += delta.partial_json as string;
    } else if (event.type === "content_block_stop") {
      const entry = open.get(event.index as number)!;
      if (entry.call) entry.call.input = JSON.parse(entry.json || "{}");
      open.delete(event.index as number);
    } else if (event.type === "message_delta") {
      reply.finish = (event.delta as JsonObject).stop_reason as string;
      reply.usage = event.usage as JsonObject;
    }
  }
  expect(open.size).toBe(0);
  return reply;
}

function readResponses(text: string): Reply {
  const reply: Reply = { text: "", calls: [], finish: "" };
  const events = dataLines(text);
  expect(events[0]!.type).toBe("response.created");
  expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
  for (const event of events) {
    if (event.type === "response.output_text.delta") reply.text += event.delta as string;
    if (event.type === "response.output_item.done") {
      const item = event.item as JsonObject;
      if (item.type === "function_call") {
        reply.calls.push({
          id: item.call_id as string,
          name: item.name as string,
          input: JSON.parse(item.arguments as string),
        });
      }
    }
    if (event.type === "response.completed") {
      const response = event.response as JsonObject;
      reply.finish = response.status as string;
      reply.usage = response.usage as JsonObject;
    }
  }
  return reply;
}

const readers: Record<string, (text: string) => Reply> = {
  chat: readChat,
  messages: readMessages,
  responses: readResponses,
};

const finishNames: Record<string, { stop: string; tool: string }> = {
  chat: { stop: "stop", tool: "tool_calls" },
  messages: { stop: "end_turn", tool: "tool_use" },
  responses: { stop: "completed", tool: "completed" },
};

const textStreams: Record<string, FakeStep> = {
  chat: textStream("up", "Hello there world"),
  messages: anthropicTextStream("up", "Hello there world"),
  responses: responsesTextStream("up", "Hello there world"),
};

const toolStreams: Record<string, FakeStep> = {
  chat: chatToolStream("up", "call_9", "weather", { city: "Oslo" }),
  messages: anthropicToolStream("up", "call_9", "weather", { city: "Oslo" }),
  responses: responsesToolStream("up", "call_9", "weather", { city: "Oslo" }),
};

describe.each(["chat", "messages", "responses"])("streams from %s", (from) => {
  describe.each(["chat", "messages", "responses"])("to %s", (to) => {
    it("carries text, the stop reason and usage", () => {
      const reply = readers[to]!(translateStream(from, to, textStreams[from]!));
      expect(reply.text).toBe("Hello there world");
      expect(reply.finish).toBe(finishNames[to]!.stop);
      expect(reply.usage).toBeDefined();
    });

    it("carries a tool call", () => {
      const reply = readers[to]!(translateStream(from, to, toolStreams[from]!));
      expect(reply.calls).toEqual([{ id: "call_9", name: "weather", input: { city: "Oslo" } }]);
      expect(reply.finish).toBe(finishNames[to]!.tool);
    });
  });
});

describe("stream details", () => {
  it("does not interleave overlapping tool calls for Anthropic clients", () => {
    const ctx = responseContext(ir);
    const encoder = new MessagesStreamEncoder(ctx);
    let text = "";
    for (const event of [
      { type: "tool_start", index: 0, id: "a", name: "one", kind: "function" },
      { type: "tool_start", index: 1, id: "b", name: "two", kind: "function" },
      { type: "tool_delta", index: 1, text: '{"b":1}' },
      { type: "tool_delta", index: 0, text: '{"a":1}' },
      { type: "tool_end", index: 0 },
      { type: "tool_end", index: 1 },
      { type: "finish", reason: "tool_calls" },
    ] as IRStreamEvent[]) {
      text += encoder.push(event);
    }
    const reply = readMessages(text + encoder.close());
    expect(reply.calls).toEqual([
      { id: "a", name: "one", input: { a: 1 } },
      { id: "b", name: "two", input: { b: 1 } },
    ]);
  });

  it("reports cached input the way each format expects", () => {
    const ctx = responseContext(ir);
    const usage = {
      inputTokens: 10,
      cachedTokens: 80,
      cacheWrite5mTokens: 7,
      cacheWrite1hTokens: 3,
      outputTokens: 5,
      reasoningTokens: 2,
    };
    const run = (encoder: ChatStreamEncoder | MessagesStreamEncoder | ResponsesStreamEncoder) => {
      let text = encoder.push({ type: "usage", usage });
      text += encoder.push({ type: "finish", reason: "stop" });
      return text + encoder.close();
    };
    expect(readChat(run(new ChatStreamEncoder(ctx))).usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 2 },
    });
    expect(readMessages(run(new MessagesStreamEncoder(ctx))).usage).toMatchObject({
      input_tokens: 10,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
      output_tokens: 5,
    });
    expect(readResponses(run(new ResponsesStreamEncoder(ctx))).usage).toMatchObject({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 105,
    });
  });

  it("hides Anthropic thinking from other formats but keeps it as an artifact", () => {
    const ctx = responseContext(ir, { showReasoning: false });
    const decoder = new MessagesStreamDecoder(ctx);
    const sse = new SseDecoder();
    const events: IRStreamEvent[] = [];
    for (const raw of eventsOf(
      anthropicToolStream("up", "t1", "a", {}, { text: "secret", signature: "sig" }),
    )) {
      for (const event of sse.push(Buffer.from(`${raw}\n\n`))) events.push(...decoder.push(event));
    }
    expect(events.find((event) => event.type === "artifact")).toMatchObject({
      family: "anthropic",
      item: { type: "thinking", thinking: "secret", signature: "sig" },
    });
  });

  it("writes reasoning summaries for Responses clients that asked for them", () => {
    const encoder = new ResponsesStreamEncoder(responseContext(ir));
    let text = encoder.push({ type: "reasoning", text: "Thinking" });
    text += encoder.push({ type: "text", text: "Done" });
    text += encoder.push({ type: "finish", reason: "stop" }) + encoder.close();
    const types = dataLines(text).map((event) => event.type);
    expect(types).toContain("response.reasoning_summary_text.delta");
    expect(types.indexOf("response.reasoning_summary_text.done")).toBeLessThan(
      types.indexOf("response.output_text.delta"),
    );
  });

  it("marks a cut-off answer as incomplete for Responses clients", () => {
    const encoder = new ResponsesStreamEncoder(responseContext(ir));
    encoder.push({ type: "finish", reason: "length" });
    const last = dataLines(encoder.close()).at(-1)!;
    expect(last).toMatchObject({
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" } },
    });
  });

  it("reports stream errors from each format", () => {
    const ctx = responseContext(ir);
    const event = (type: string, data: JsonObject) => ({
      raw: "",
      data: JSON.stringify({ type, ...data }),
      event: type,
      isComment: false,
    });
    expect(
      new ResponsesStreamDecoder(ctx).push(
        event("response.failed", {
          response: { error: { code: "rate_limit_exceeded", message: "slow" } },
        }),
      )[0],
    ).toMatchObject({ type: "error", cause: { retryElsewhere: true } });
    expect(
      new MessagesStreamDecoder(ctx).push(
        event("error", { error: { type: "overloaded_error", message: "busy" } }),
      )[0],
    ).toMatchObject({ type: "error", cause: { outcome: "overloaded" } });
  });
});

describe("complete responses", () => {
  const ctx = responseContext(ir);

  it("translates text between every format", () => {
    const decoded = [
      decodeChatResponse(completionBody("up", "Hi"), ctx),
      decodeMessagesResponse(anthropicMessageBody("up", "Hi"), ctx),
      decodeResponsesResponse(responsesBody("up", "Hi"), ctx),
    ];
    for (const response of decoded) {
      expect(response).toMatchObject({ blocks: [{ type: "text", text: "Hi" }], finish: "stop" });
      if ("outcome" in response) throw new Error("unexpected error");
      expect(encodeChatResponse(response, ctx, null)).toMatchObject({
        object: "chat.completion",
        model: "served-model",
        choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      });
      expect(encodeMessagesResponse(response, ctx, null)).toMatchObject({
        type: "message",
        model: "requested-model",
        content: [{ type: "text", text: "Hi" }],
        stop_reason: "end_turn",
      });
      expect(encodeResponsesResponse(response, ctx, null)).toMatchObject({
        object: "response",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "Hi" }] }],
      });
    }
  });

  it("carries tool calls in complete responses", () => {
    const response = decodeMessagesResponse(
      {
        type: "message",
        content: [{ type: "tool_use", id: "t1", name: "weather", input: { city: "Oslo" } }],
        stop_reason: "tool_use",
      },
      ctx,
    );
    if ("outcome" in response) throw new Error("unexpected error");
    expect(encodeChatResponse(response, ctx, null)).toMatchObject({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "t1", function: { name: "weather", arguments: '{"city":"Oslo"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(encodeResponsesResponse(response, ctx, null).output).toMatchObject([
      { type: "function_call", call_id: "t1", name: "weather" },
    ]);
  });

  it("adds a note to the text when one is due", () => {
    const response = decodeChatResponse(completionBody("up", "Hi"), ctx);
    if ("outcome" in response) throw new Error("unexpected error");
    expect(encodeChatResponse(response, ctx, "Note. ")).toMatchObject({
      choices: [{ message: { content: "Note. Hi" } }],
    });
  });

  it("recognizes failed responses", () => {
    expect(
      decodeResponsesResponse(
        { status: "failed", error: { code: "insufficient_quota", message: "No credit" } },
        ctx,
      ),
    ).toMatchObject({ outcome: "quota_exhausted" });
  });
});
