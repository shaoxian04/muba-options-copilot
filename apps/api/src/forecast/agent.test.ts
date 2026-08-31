import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  callClaudeForJson,
  ForecastGenerationFailed,
  realCreateWithFallback,
  type AgentCreateFn,
  type AgentFallbackDeps,
} from "./agent.js";

const schema = z.object({ greeting: z.string() });

test("callClaudeForJson parses and validates a well-formed response", async () => {
  const fakeCreate: AgentCreateFn = async () => ({ content: [{ type: "text", text: '{"greeting": "hello"}' }] });
  const result = await callClaudeForJson(schema, "system", "user", fakeCreate);
  assert.deepEqual(result, { greeting: "hello" });
});

test("callClaudeForJson extracts JSON embedded in surrounding prose", async () => {
  const fakeCreate: AgentCreateFn = async () => ({
    content: [{ type: "text", text: 'Sure, here you go:\n{"greeting": "hi"}\nHope that helps!' }],
  });
  const result = await callClaudeForJson(schema, "system", "user", fakeCreate);
  assert.deepEqual(result, { greeting: "hi" });
});

test("callClaudeForJson throws ForecastGenerationFailed on invalid JSON", async () => {
  const fakeCreate: AgentCreateFn = async () => ({ content: [{ type: "text", text: "not json at all" }] });
  await assert.rejects(() => callClaudeForJson(schema, "system", "user", fakeCreate), ForecastGenerationFailed);
});

test("callClaudeForJson throws ForecastGenerationFailed when schema validation fails", async () => {
  const fakeCreate: AgentCreateFn = async () => ({ content: [{ type: "text", text: '{"wrongKey": 1}' }] });
  await assert.rejects(() => callClaudeForJson(schema, "system", "user", fakeCreate), ForecastGenerationFailed);
});

test("callClaudeForJson throws ForecastGenerationFailed when the create call itself rejects", async () => {
  const fakeCreate: AgentCreateFn = async () => { throw new Error("network down"); };
  await assert.rejects(() => callClaudeForJson(schema, "system", "user", fakeCreate), ForecastGenerationFailed);
});

const baseParams: Parameters<AgentCreateFn>[0] = {
  model: "whatever",
  max_tokens: 100,
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
};

test("realCreateWithFallback uses OpenAI when a key is configured and the call succeeds", async () => {
  let claudeCalled = false;
  const deps: AgentFallbackDeps = {
    openaiApiKey: () => "fake-openai-key",
    openaiCreate: async () => ({ content: [{ type: "text", text: "from openai" }] }),
    claudeCreate: async () => {
      claudeCalled = true;
      return { content: [{ type: "text", text: "from claude" }] };
    },
  };
  const result = await realCreateWithFallback(baseParams, deps);
  assert.equal(result.content[0].text, "from openai");
  assert.equal(claudeCalled, false);
});

test("realCreateWithFallback falls back to Claude when no OpenAI key is configured", async () => {
  let openaiCalled = false;
  const deps: AgentFallbackDeps = {
    openaiApiKey: () => undefined,
    openaiCreate: async () => {
      openaiCalled = true;
      return { content: [{ type: "text", text: "from openai" }] };
    },
    claudeCreate: async () => ({ content: [{ type: "text", text: "from claude" }] }),
  };
  const result = await realCreateWithFallback(baseParams, deps);
  assert.equal(result.content[0].text, "from claude");
  assert.equal(openaiCalled, false);
});

test("realCreateWithFallback falls back to Claude when the OpenAI call itself throws", async () => {
  const deps: AgentFallbackDeps = {
    openaiApiKey: () => "fake-openai-key",
    openaiCreate: async () => { throw new Error("openai is down"); },
    claudeCreate: async () => ({ content: [{ type: "text", text: "from claude" }] }),
  };
  const result = await realCreateWithFallback(baseParams, deps);
  assert.equal(result.content[0].text, "from claude");
});
