import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeResponseBodyToFile } from "../src/file-io.ts";

function chunkedResponse(chunks: string[], headers?: HeadersInit): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers },
  );
}

async function temporaryFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith(".part"));
}

describe("bounded response file writes", () => {
  test("streams a multi-chunk body up to the exact limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aside-download-"));
    try {
      const path = join(directory, "attachment.txt");
      const bytes = await writeResponseBodyToFile(chunkedResponse(["ab", "cd"], { "content-length": "4" }), path, 4);
      expect(bytes).toBe(4);
      expect(await Bun.file(path).text()).toBe("abcd");
      expect(await temporaryFiles(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects the actual streamed size when content-length is misleading", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aside-download-"));
    try {
      const path = join(directory, "attachment.txt");
      await expect(
        writeResponseBodyToFile(chunkedResponse(["abc", "de"], { "content-length": "2" }), path, 4),
      ).rejects.toThrow("attachment is larger than 25 MB");
      expect(await Bun.file(path).exists()).toBe(false);
      expect(await temporaryFiles(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects the actual streamed size when content-length is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aside-download-"));
    try {
      const path = join(directory, "attachment.txt");
      await expect(writeResponseBodyToFile(chunkedResponse(["abc", "de"]), path, 4)).rejects.toThrow(
        "attachment is larger than 25 MB",
      );
      expect(await Bun.file(path).exists()).toBe(false);
      expect(await temporaryFiles(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects an oversized content-length before writing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aside-download-"));
    try {
      const path = join(directory, "attachment.txt");
      await expect(
        writeResponseBodyToFile(chunkedResponse(["abcde"], { "content-length": "5" }), path, 4),
      ).rejects.toThrow("attachment is larger than 25 MB");
      expect(await Bun.file(path).exists()).toBe(false);
      expect(await temporaryFiles(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("removes partial files after a response stream error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aside-download-"));
    try {
      const path = join(directory, "attachment.txt");
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            controller.error(new Error("stream failed"));
          },
        }),
      );
      await expect(writeResponseBodyToFile(response, path, 20)).rejects.toThrow("stream failed");
      expect(await Bun.file(path).exists()).toBe(false);
      expect(await temporaryFiles(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("preserves successful empty response bodies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aside-download-"));
    try {
      const path = join(directory, "attachment.txt");
      expect(await writeResponseBodyToFile(new Response(null), path, 4)).toBe(0);
      expect(await Bun.file(path).exists()).toBe(true);
      expect((await Bun.file(path).bytes()).byteLength).toBe(0);
      expect(await temporaryFiles(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("isolates concurrent temporary files for the same destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aside-download-"));
    try {
      const path = join(directory, "attachment.txt");
      const results = await Promise.all([
        writeResponseBodyToFile(chunkedResponse(["first"]), path, 10),
        writeResponseBodyToFile(chunkedResponse(["second"]), path, 10),
      ]);
      expect(results.sort()).toEqual([5, 6]);
      expect(["first", "second"]).toContain(await Bun.file(path).text());
      expect(await temporaryFiles(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
