import { describe, expect, it } from "vitest";
import {
  isElicitationRequest,
  isRpcExtensionUIRequest,
  normalizeElicitationResponse,
} from "../src/pi-process.js";

describe("pi-process vendored PI helpers", () => {
  it("accepts typed extension UI requests and narrows elicitation variants", () => {
    const request = {
      type: "extension_ui_request",
      id: "req-1",
      method: "select",
      title: "Choose",
      options: ["a", "b"],
    };

    expect(isRpcExtensionUIRequest(request)).toBe(true);
    expect(isElicitationRequest(request)).toBe(true);
  });

  it("rejects malformed extension UI requests", () => {
    expect(
      isRpcExtensionUIRequest({
        type: "extension_ui_request",
        id: "req-1",
        method: "select",
        options: ["a", "b"],
      })
    ).toBe(false);

    expect(
      isRpcExtensionUIRequest({
        type: "extension_ui_request",
        id: "req-2",
        method: "setStatus",
      })
    ).toBe(false);

    expect(
      isRpcExtensionUIRequest({ type: "extension_ui_request", id: 3, method: "confirm" })
    ).toBe(false);
  });

  it("normalizes supported elicitation responses", () => {
    expect(normalizeElicitationResponse("req-1", "value")).toEqual({
      type: "extension_ui_response",
      id: "req-1",
      value: "value",
    });

    expect(normalizeElicitationResponse("req-2", { confirmed: true })).toEqual({
      type: "extension_ui_response",
      id: "req-2",
      confirmed: true,
    });

    expect(normalizeElicitationResponse("req-3", { cancelled: true })).toEqual({
      type: "extension_ui_response",
      id: "req-3",
      cancelled: true,
    });
  });

  it("rejects unsupported elicitation response shapes", () => {
    expect(() => normalizeElicitationResponse("req-1", 123)).toThrow(
      "Unsupported Pi elicitation response shape"
    );
  });
});
