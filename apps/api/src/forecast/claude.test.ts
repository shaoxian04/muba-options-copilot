import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { callClaudeForJson, ForecastGenerationFailed, type ClaudeCreateFn } from "./claude.js";

const schema = z.object({ greeting: z.string() });

test("callClaudeForJson parses and validates a well-formed response", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({ content: [{ type: "text", text: '{"greeting": "hello"}' }] });
  const result = await callClaudeForJson(schema, "system", "user", fakeCreate);
  assert.deepEqual(result, { greeting: "hello" });
});

test("callClaudeForJson extracts JSON embedded in surrounding prose", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({
    content: [{ type: "text", text: 'Sure, here you go:\n{"greeting": "hi"}\nHope that helps!' }],
  });
  const result = await callClaudeForJson(schema, "system", "user", fakeCreate);
  assert.deepEqual(result, { greeting: "hi" });
});

test("callClaudeForJson throws ForecastGenerationFailed on invalid JSON", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({ content: [{ type: "text", text: "not json at all" }] });
  await assert.rejects(() => callClaudeForJson(schema, "system", "user", fakeCreate), ForecastGenerationFailed);
});

test("callClaudeForJson throws ForecastGenerationFailed when schema validation fails", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({ content: [{ type: "text", text: '{"wrongKey": 1}' }] });
  await assert.rejects(() => callClaudeForJson(schema, "system", "user", fakeCreate), ForecastGenerationFailed);
});

test("callClaudeForJson throws ForecastGenerationFailed when the create call itself rejects", async () => {
  const fakeCreate: ClaudeCreateFn = async () => { throw new Error("network down"); };
  await assert.rejects(() => callClaudeForJson(schema, "system", "user", fakeCreate), ForecastGenerationFailed);
});
