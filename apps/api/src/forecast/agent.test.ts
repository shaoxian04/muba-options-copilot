import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  callAgentForJson,
  ForecastGenerationFailed,
  realCreateWithFallback,
  type AgentCreateFn,
  type AgentFallbackDeps,
} from "./agent.js";

const schema = z.object({ greeting: z.string() });

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
