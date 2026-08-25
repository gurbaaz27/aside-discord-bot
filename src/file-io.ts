import { rename } from "node:fs/promises";

const attachmentTooLarge = () => new Error("attachment is larger than 25 MB");

export async function writeResponseBodyToFile(
  response: Response,
  destination: string,
  maxBytes: number,
): Promise<number> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }

  const contentLengthValue = response.headers.get("content-length")?.trim();
  if (contentLengthValue && /^\d+$/.test(contentLengthValue)) {
    const contentLength = Number(contentLengthValue);
    if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw attachmentTooLarge();
    }
  }

  const temporary = `${destination}.part`;
  const reader = response.body?.getReader();
  const file = Bun.file(temporary);
  let sink: ReturnType<typeof file.writer> | undefined;
  let bytesWritten = 0;

  try {
    if (!reader) {
      await Bun.write(file, new Uint8Array());
    } else {
      sink = file.writer();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (bytesWritten + value.byteLength > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw attachmentTooLarge();
        }
        sink.write(value);
        bytesWritten += value.byteLength;
      }
      await sink.end();
      sink = undefined;
    }

    await rename(temporary, destination);
    return bytesWritten;
  } catch (error) {
    await reader?.cancel().catch(() => undefined);
    if (sink) {
      try {
        await sink.end();
      } catch {
        // Preserve the download error while still attempting to close the file.
      }
    }
    await file.delete().catch(() => undefined);
    throw error;
  } finally {
    reader?.releaseLock();
  }
}
