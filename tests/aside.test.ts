import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAssistantTextSince } from "../src/aside.ts";

describe("transcript tail reading", () => {
  test("reads from a byte offset after a multibyte prefix", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aside-transcript-"));
    try {
      const path = join(directory, "messages.jsonl");
      const prefix = `${JSON.stringify({ role: "user", content: [{ type: "text", text: "नमस्ते 👋" }] })}\n`;
      const tail = [
        JSON.stringify({ role: "user", content: [{ type: "text", text: "ignore me" }] }),
        "{partial json",
        JSON.stringify({
          role: "assistant",
          content: [
            { type: "text", text: "first answer" },
            { type: "tool", text: "ignore this" },
            { type: "text", text: "second answer" },
          ],
        }),
      ].join("\n");
      await Bun.write(path, prefix + tail);

      const offset = new TextEncoder().encode(prefix).byteLength;
      expect(await readAssistantTextSince(path, offset)).toBe("first answer\n\nsecond answer");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("returns an empty result when the tail has no valid assistant text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aside-transcript-"));
    try {
      const path = join(directory, "messages.jsonl");
      await Bun.write(path, `${JSON.stringify({ role: "user", content: [] })}\n`);
      expect(await readAssistantTextSince(path, 0)).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
