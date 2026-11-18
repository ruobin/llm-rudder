import { describe, expect, it } from "vitest";
import {
  anthropicRequestHeaders,
  anthropicResponseHeaders,
  findEdgeRoute,
  findTopLevelString,
  globToRegExp,
  isCredentialHeader,
  parseEdgePlan,
  replaceTopLevelString,
  setTopLevelField,
  withoutOauthBetas,
} from "../src/index.js";

const bytes = (text: string) => Buffer.from(text, "utf8");

describe("top-level JSON fields", () => {
  it("finds a field and ignores nested fields of the same name", () => {
    const body = bytes('{"metadata":{"model":"inner"},"tools":[{"model":"x"}],"model":"outer"}');
    expect(findTopLevelString(body, "model")?.value).toBe("outer");
  });

  it("handles escapes, unicode and whitespace", () => {
    const body = bytes(' {\n "a\\"b" : "}{" ,\t"model" :\r\n "cl\\u0061ude-é" } ');
    expect(findTopLevelString(body, "model")?.value).toBe("claude-é");
  });

  it("returns null for absent, non-string or malformed fields", () => {
    expect(findTopLevelString(bytes('{"a":1}'), "model")).toBeNull();
    expect(findTopLevelString(bytes('{"model":1}'), "model")).toBeNull();
    expect(findTopLevelString(bytes('["model"]'), "model")).toBeNull();
    expect(findTopLevelString(bytes('{"model":"a"'), "model")).toBeNull();
    expect(findTopLevelString(bytes('{"model" "a"}'), "model")).toBeNull();
    expect(findTopLevelString(bytes('{"model":"a" "b":1}'), "model")).toBeNull();
    expect(findTopLevelString(bytes(""), "model")).toBeNull();
  });

  it("uses the last duplicate, like JSON.parse", () => {
    const text = '{"model":"first","model":"second"}';
    expect(findTopLevelString(bytes(text), "model")?.value).toBe(JSON.parse(text).model);
  });

  it("changes only the field, byte for byte", () => {
    // These would change if the body were parsed and serialized again.
    const before = '{"tools":{"b":1,"2":"x","1":"y"},"n":1.0,"big":12345678901234567890,';
    const after = ',"s":"\\u00e9 é","system":[{"cache_control":{"type":"ephemeral"}}]}';
    const body = bytes(`${before}"model":"claude-opus-5-5"${after}`);
    const result = replaceTopLevelString(body, "model", 'claude-"sonnet"');
    expect(result?.toString()).toBe(`${before}"model":"claude-\\"sonnet\\""${after}`);
  });

  it("returns the same buffer when nothing changes", () => {
    const body = bytes('{"model":"m"}');
    expect(replaceTopLevelString(body, "model", "m")).toBe(body);
    expect(replaceTopLevelString(body, "other", "m")).toBeNull();
  });

  it("keeps invalid UTF-8 elsewhere in the body", () => {
    const body = Buffer.concat([bytes('{"x":"'), Buffer.from([0xff]), bytes('","model":"a"}')]);
    const result = replaceTopLevelString(body, "model", "b");
    expect(result?.includes(Buffer.from([0xff]))).toBe(true);
  });
});

describe("setting a top-level JSON field", () => {
  it("adds a missing field and leaves every other byte alone", () => {
    const body = bytes('{ "model" : "m",\n "n":1.50, "2":{"1":[ ]} }');
    expect(setTopLevelField(body, "reasoning", { effort: "high" })?.toString()).toBe(
      '{ "model" : "m",\n "n":1.50, "2":{"1":[ ]},"reasoning":{"effort":"high"} }',
    );
  });

  it("replaces an existing value in place", () => {
    const body = bytes('{"a":1,"reasoning":{"summary":"auto"},"b":2.0}');
    expect(setTopLevelField(body, "reasoning", { effort: "low" })?.toString()).toBe(
      '{"a":1,"reasoning":{"effort":"low"},"b":2.0}',
    );
  });

  it("handles an empty object and rejects anything else", () => {
    expect(setTopLevelField(bytes(" { } "), "a", 1)?.toString()).toBe(' {"a":1 } ');
    expect(setTopLevelField(bytes("[1]"), "a", 1)).toBeNull();
    expect(setTopLevelField(bytes('{"a":'), "a", 1)).toBeNull();
  });

  it("still reads the last duplicate and ignores a non-string one", () => {
    expect(findTopLevelString(bytes('{"m":"a","m":"b"}'), "m")?.value).toBe("b");
    expect(findTopLevelString(bytes('{"m":"a","m":1}'), "m")).toBeNull();
  });
});

describe("Anthropic headers", () => {
  it("removes only login betas", () => {
    expect(withoutOauthBetas("a-1, oauth-2025-04-20,b-2")).toBe("a-1,b-2");
    expect(withoutOauthBetas("oauth-2025-04-20")).toBeNull();
    expect(withoutOauthBetas("a-1, b-2")).toBe("a-1, b-2");
  });

  it("passes new anthropic headers and blocks credentials", () => {
    const headers = anthropicRequestHeaders({
      authorization: "Bearer login",
      "x-api-key": "key",
      cookie: "c",
      "Anthropic-Version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20,new-beta",
      "anthropic-future-thing": "kept",
      "anthropic-client-token": "secret",
      "anthropic-api-key": "secret",
      "x-claude-code-session-id": "s",
    });
    expect(headers).toEqual({
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "new-beta",
      "anthropic-future-thing": "kept",
    });
  });

  it("recognizes credential names without matching ordinary ones", () => {
    for (const name of ["authorization", "x-api-key", "x-auth-token", "proxy-authorization"]) {
      expect(isCredentialHeader(name)).toBe(true);
    }
    for (const name of ["anthropic-version", "anthropic-beta", "x-author"]) {
      expect(isCredentialHeader(name)).toBe(false);
    }
  });

  it("keeps the response headers clients read", () => {
    expect(
      anthropicResponseHeaders({
        "request-id": "req_1",
        "retry-after": "5",
        "x-should-retry": "false",
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-organization-id": "org",
        "set-cookie": "x",
      }),
    ).toEqual({
      "request-id": "req_1",
      "retry-after": "5",
      "x-should-retry": "false",
      "anthropic-ratelimit-unified-status": "allowed",
    });
  });
});

describe("edge plan", () => {
  const plan = {
    version: 1,
    reportIntervalS: 60,
    routes: [
      {
        match: "claude-opus-*",
        tier: "frontier",
        steps: [
          { kind: "plan" },
          { kind: "gateway", tier: "frontier" },
          { kind: "plan", model: "claude-sonnet-5-5" },
        ],
      },
    ],
  };

  it("accepts a valid plan and finds routes", () => {
    const parsed = parseEdgePlan(plan);
    expect(parsed).toEqual(plan);
    expect(findEdgeRoute(parsed!, "claude-opus-5-5")?.tier).toBe("frontier");
    expect(findEdgeRoute(parsed!, "other")).toBeNull();
  });

  it("rejects anything malformed", () => {
    expect(parseEdgePlan(null)).toBeNull();
    expect(parseEdgePlan({ version: 2, routes: [] })).toBeNull();
    expect(
      parseEdgePlan({ version: 1, routes: [{ match: "a", tier: "b", steps: [{ kind: "x" }] }] }),
    ).toBeNull();
  });

  it("escapes pattern characters", () => {
    expect(globToRegExp("a.b*").test("a.bcd")).toBe(true);
    expect(globToRegExp("a.b*").test("axbc")).toBe(false);
  });
});
