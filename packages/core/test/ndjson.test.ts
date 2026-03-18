import { describe, expect, it } from "vitest";
import { parseNdjsonLine, serializeNdjsonLine } from "../src/ndjson.js";

describe("ndjson", () => {
  it("round-trips values", () => {
    const serialized = serializeNdjsonLine({ hello: "world" });
    expect(serialized).toBe('{"hello":"world"}\n');
    expect(parseNdjsonLine(serialized)).toEqual({ hello: "world" });
  });

  it("ignores empty lines and trims trailing carriage returns", () => {
    expect(parseNdjsonLine("")).toBeNull();
    expect(parseNdjsonLine('{"value":1}\r')).toEqual({ value: 1 });
  });

  it("preserves unicode content", () => {
    const serialized = serializeNdjsonLine({ greeting: "hello", accent: "cafe" });
    expect(parseNdjsonLine(serialized)).toEqual({ greeting: "hello", accent: "cafe" });
  });

  it("throws on malformed json", () => {
    expect(() => parseNdjsonLine("{")).toThrow(SyntaxError);
  });
});
