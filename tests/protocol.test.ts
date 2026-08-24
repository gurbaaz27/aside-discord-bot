import { describe, expect, test } from "bun:test";
import { parseApproval, parseQuestion, removeProtocolBlocks } from "../src/protocol.ts";

describe("Discord response protocol", () => {
  test("parses approval blocks", () => {
    expect(parseApproval("[[APPROVAL]]\nAction: Send it\nDetails: to me\n[[/APPROVAL]]")).toEqual({
      action: "Send it",
      details: "to me",
    });
  });

  test("parses question envelopes and limits options", () => {
    const options = Array.from({ length: 10 }, (_, index) => ({ label: `Choice ${index}` }));
    const question = parseQuestion(`[[QUESTION]]${JSON.stringify({ questions: [{ header: "Pick", question: "Which?", options }] })}[[/QUESTION]]`);
    expect(question?.header).toBe("Pick");
    expect(question?.options).toHaveLength(8);
  });

  test("removes protocol blocks without hiding surrounding prose", () => {
    expect(removeProtocolBlocks("Before\n\n[[QUESTION]]{}[[/QUESTION]]\n\nAfter")).toBe("Before\n\nAfter");
  });
});
