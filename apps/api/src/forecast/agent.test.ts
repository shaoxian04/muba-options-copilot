import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  callAgentForJson,
  callOpenAICompatible,
  ForecastGenerationFailed,
  realCreateWithFallback,
  type AgentCreateFn,
  type AgentFallbackDeps,
  type OpenAICompatibleClient,
} from "./agent.js";

const schema = z.object({ greeting: z.string() });

const baseAgentParams: Parameters<AgentCreateFn>[0] = {
  model: "whatever",
  max_tokens: 4096,
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
};

test("callOpenAICompatible forwards max_tokens as max_completion_tokens to the client", async () => {
  let received: any;
  const fakeClient: OpenAICompatibleClient = {
    chat: {
      completions: {
        create: async (args) => {
          received = args;
          return { choices: [{ message: { content: '{"greeting": "hi"}' } }] };
        },
      },
    },
  };

  await callOpenAICompatible(fakeClient, "some-model", "openai", baseAgentParams);

  assert.equal(received.max_completion_tokens, 4096);
  assert.equal(received.max_tokens, undefined);
  assert.equal(received.model, "some-model");
});

test("callOpenAICompatible extracts text from the first choice's message content and tags the provider", async () => {
  const fakeClient: OpenAICompatibleClient = {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: "hello there" } }] }),
      },
    },
  };

  const result = await callOpenAICompatible(fakeClient, "some-model", "openai", baseAgentParams);

  assert.deepEqual(result, { content: [{ type: "text", text: "hello there" }], provider: "openai" });
});

test("callOpenAICompatible returns empty text when the response has no message content", async () => {
  const fakeClient: OpenAICompatibleClient = {
    chat: {
      completions: {
        create: async () => ({ choices: [] }),
      },
    },
  };

  const result = await callOpenAICompatible(fakeClient, "some-model", "groq", baseAgentParams);

  assert.deepEqual(result, { content: [{ type: "text", text: "" }], provider: "groq" });
});

test("callOpenAICompatible normalizes prompt/completion token usage from the response", async () => {
  const fakeClient: OpenAICompatibleClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: "hi" } }],
          usage: { prompt_tokens: 12, completion_tokens: 34 },
        }),
      },
    },
  };

  const result = await callOpenAICompatible(fakeClient, "some-model", "groq", baseAgentParams);

  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 34 });
});

test("callOpenAICompatible omits usage when the response doesn't include token counts", async () => {
  const fakeClient: OpenAICompatibleClient = {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: "hi" } }] }),
      },
    },
  };

  const result = await callOpenAICompatible(fakeClient, "some-model", "groq", baseAgentParams);

  assert.equal(result.usage, undefined);
});

test("callAgentForJson parses and validates a well-formed response", async () => {
  const fakeCreate: AgentCreateFn = async () => ({ content: [{ type: "text", text: '{"greeting": "hello"}' }] });
  const result = await callAgentForJson(schema, "system", "user", fakeCreate);
  assert.deepEqual(result, { greeting: "hello" });
});

test("callAgentForJson extracts JSON embedded in surrounding prose", async () => {
  const fakeCreate: AgentCreateFn = async () => ({
    content: [{ type: "text", text: 'Sure, here you go:\n{"greeting": "hi"}\nHope that helps!' }],
  });
  const result = await callAgentForJson(schema, "system", "user", fakeCreate);
  assert.deepEqual(result, { greeting: "hi" });
});

test("callAgentForJson throws ForecastGenerationFailed on invalid JSON", async () => {
  const fakeCreate: AgentCreateFn = async () => ({ content: [{ type: "text", text: "not json at all" }] });
  await assert.rejects(() => callAgentForJson(schema, "system", "user", fakeCreate), ForecastGenerationFailed);
});

test("callAgentForJson throws ForecastGenerationFailed when schema validation fails", async () => {
  const fakeCreate: AgentCreateFn = async () => ({ content: [{ type: "text", text: '{"wrongKey": 1}' }] });
  await assert.rejects(() => callAgentForJson(schema, "system", "user", fakeCreate), ForecastGenerationFailed);
});

test("callAgentForJson throws ForecastGenerationFailed when the create call itself rejects", async () => {
  const fakeCreate: AgentCreateFn = async () => { throw new Error("network down"); };
  await assert.rejects(() => callAgentForJson(schema, "system", "user", fakeCreate), ForecastGenerationFailed);
});

test("callAgentForJson reports provider, tokens, and latency for a successful call", async () => {
  const events: any[] = [];
  const fakeCreate: AgentCreateFn = async () => ({
    content: [{ type: "text", text: '{"greeting": "hello"}' }],
    provider: "groq",
    usage: { inputTokens: 10, outputTokens: 5 },
  });

  await callAgentForJson(schema, "system", "user", fakeCreate, (event) => events.push(event));

  assert.equal(events.length, 1);
  assert.equal(events[0].provider, "groq");
  assert.equal(events[0].inputTokens, 10);
  assert.equal(events[0].outputTokens, 5);
  assert.equal(typeof events[0].latencyMs, "number");
});

test("callAgentForJson reports provider 'unknown' and no token counts when the create function doesn't supply them", async () => {
  const events: any[] = [];
  const fakeCreate: AgentCreateFn = async () => ({ content: [{ type: "text", text: '{"greeting": "hello"}' }] });

  await callAgentForJson(schema, "system", "user", fakeCreate, (event) => events.push(event));

  assert.equal(events[0].provider, "unknown");
  assert.equal(events[0].inputTokens, undefined);
  assert.equal(events[0].outputTokens, undefined);
});

test("callAgentForJson does not log a usage event when the create call fails", async () => {
  const events: any[] = [];
  const fakeCreate: AgentCreateFn = async () => { throw new Error("boom"); };

  await assert.rejects(
    () => callAgentForJson(schema, "system", "user", fakeCreate, (event) => events.push(event)),
    ForecastGenerationFailed
  );

  assert.equal(events.length, 0);
});

const baseParams: Parameters<AgentCreateFn>[0] = {
  model: "whatever",
  max_tokens: 100,
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
};

const neverCalled = (label: string): AgentCreateFn => async () => {
  throw new Error(`${label} should not have been called`);
};
const neverAskedForKey = (label: string) => (): string | undefined => {
  throw new Error(`${label} key getter should not have been called`);
};

test("realCreateWithFallback uses OpenAI when a key is configured and the call succeeds", async () => {
  const deps: AgentFallbackDeps = {
    openaiApiKey: () => "fake-openai-key",
    openaiCreate: async () => ({ content: [{ type: "text", text: "from openai" }] }),
    groqApiKey: neverAskedForKey("groq"),
    groqCreate: neverCalled("groq"),
    claudeCreate: neverCalled("claude"),
  };
  const result = await realCreateWithFallback(baseParams, deps);
  assert.equal(result.content[0].text, "from openai");
});

test("realCreateWithFallback falls back to Groq when no OpenAI key is configured", async () => {
  const deps: AgentFallbackDeps = {
    openaiApiKey: () => undefined,
    openaiCreate: neverCalled("openai"),
    groqApiKey: () => "fake-groq-key",
    groqCreate: async () => ({ content: [{ type: "text", text: "from groq" }] }),
    claudeCreate: neverCalled("claude"),
  };
  const result = await realCreateWithFallback(baseParams, deps);
  assert.equal(result.content[0].text, "from groq");
});

test("realCreateWithFallback falls back to Groq when the OpenAI call itself throws", async () => {
  const deps: AgentFallbackDeps = {
    openaiApiKey: () => "fake-openai-key",
    openaiCreate: async () => { throw new Error("openai is down"); },
    groqApiKey: () => "fake-groq-key",
    groqCreate: async () => ({ content: [{ type: "text", text: "from groq" }] }),
    claudeCreate: neverCalled("claude"),
  };
  const result = await realCreateWithFallback(baseParams, deps);
  assert.equal(result.content[0].text, "from groq");
});

test("realCreateWithFallback falls back to Claude when no OpenAI or Groq key is configured", async () => {
  const deps: AgentFallbackDeps = {
    openaiApiKey: () => undefined,
    openaiCreate: neverCalled("openai"),
    groqApiKey: () => undefined,
    groqCreate: neverCalled("groq"),
    claudeCreate: async () => ({ content: [{ type: "text", text: "from claude" }] }),
  };
  const result = await realCreateWithFallback(baseParams, deps);
  assert.equal(result.content[0].text, "from claude");
});

test("realCreateWithFallback falls back to Claude when there's no OpenAI key and the Groq call throws", async () => {
  const deps: AgentFallbackDeps = {
    openaiApiKey: () => undefined,
    openaiCreate: neverCalled("openai"),
    groqApiKey: () => "fake-groq-key",
    groqCreate: async () => { throw new Error("groq is down"); },
    claudeCreate: async () => ({ content: [{ type: "text", text: "from claude" }] }),
  };
  const result = await realCreateWithFallback(baseParams, deps);
  assert.equal(result.content[0].text, "from claude");
});

test("realCreateWithFallback falls back to Claude when both OpenAI and Groq calls throw", async () => {
  const deps: AgentFallbackDeps = {
    openaiApiKey: () => "fake-openai-key",
    openaiCreate: async () => { throw new Error("openai is down"); },
    groqApiKey: () => "fake-groq-key",
    groqCreate: async () => { throw new Error("groq is down"); },
    claudeCreate: async () => ({ content: [{ type: "text", text: "from claude" }] }),
  };
  const result = await realCreateWithFallback(baseParams, deps);
  assert.equal(result.content[0].text, "from claude");
});

test("realCreateWithFallback logs each tier's failure and raises an error naming every tier when all three fail", async () => {
  const logs: string[] = [];
  const deps: AgentFallbackDeps = {
    openaiApiKey: () => "fake-openai-key",
    openaiCreate: async () => { throw new Error("openai boom"); },
    groqApiKey: () => "fake-groq-key",
    groqCreate: async () => { throw new Error("groq boom"); },
    claudeCreate: async () => { throw new Error("claude boom"); },
    logFallback: (message) => logs.push(message),
  };

  await assert.rejects(
    () => realCreateWithFallback(baseParams, deps),
    (err: any) => {
      assert.match(err.message, /openai.*boom/i);
      assert.match(err.message, /groq.*boom/i);
      assert.match(err.message, /claude.*boom/i);
      return true;
    }
  );

  assert.equal(logs.length, 3);
  assert.match(logs[0], /openai/i);
  assert.match(logs[1], /groq/i);
  assert.match(logs[2], /claude/i);
});

test("realCreateWithFallback surfaces Claude's own error when it's the only tier attempted", async () => {
  const deps: AgentFallbackDeps = {
    openaiApiKey: () => undefined,
    openaiCreate: neverCalled("openai"),
    groqApiKey: () => undefined,
    groqCreate: neverCalled("groq"),
    claudeCreate: async () => { throw new Error("ANTHROPIC_API_KEY is not set"); },
  };

  await assert.rejects(() => realCreateWithFallback(baseParams, deps), /ANTHROPIC_API_KEY is not set/);
});
