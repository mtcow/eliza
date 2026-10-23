/**
 * Unit tests for the PaddleOCR wrapper JSON contract.
 *
 * The Python wrapper is documented to print exactly one JSON array on stdout
 * (`[]` when there is no text). CI never runs a real PaddleOCR install: the
 * parser and mapper are pure, so the contract is pinned from a fixture string,
 * the same way the Tesseract/RapidOCR adapters are tested.
 *
 * The interesting case is the one that used to be invisible: PaddleOCR (and
 * paddle's C++ runtime) prints progress/log lines to stdout on the first run
 * while it downloads its models, so stdout can be `...log lines... []`. That
 * is unreadable output, not a screen without text, and must not be reported as
 * an empty OCR result.
 */

import { describe, expect, it } from "vitest";
import {
  mapPaddleOcrJsonToResult,
  parsePaddleOcrJson,
} from "./ocr-service-paddleocr.js";

const TILE = 128;

describe("paddleocr wrapper output", () => {
  it("keeps a genuine no-text frame empty", () => {
    // Documented success-with-nothing-found payload.
    expect(parsePaddleOcrJson("[]")).toEqual([]);
    expect(mapPaddleOcrJsonToResult("[]", TILE, TILE, 0, 0)).toEqual({
      blocks: [],
    });
  });

  it("maps a documented detection payload", () => {
    const raw = JSON.stringify([
      {
        box: [
          [10, 10],
          [60, 10],
          [60, 24],
          [10, 24],
        ],
        text: "Save",
        conf: 0.97,
      },
    ]);
    const result = mapPaddleOcrJsonToResult(raw, TILE, TILE, 5, 7);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].text).toBe("Save");
    expect(result.blocks[0].bbox).toEqual({
      x: 15,
      y: 17,
      width: 50,
      height: 14,
    });
  });

  it("throws instead of reporting an empty screen when stdout is not JSON", () => {
    // First run: model download progress goes to stdout before the payload.
    const raw = [
      "Downloading PP-OCRv5_det_infer.tar ...",
      "[INFO] download 100%",
      "[]",
    ].join("\n");
    expect(() => parsePaddleOcrJson(raw)).toThrow(
      /did not print the documented JSON array/,
    );
    expect(() => mapPaddleOcrJsonToResult(raw, TILE, TILE, 0, 0)).toThrow();
  });

  it("throws when stdout is JSON but not the documented array", () => {
    expect(() =>
      parsePaddleOcrJson('{"error":"inference failed"}'),
    ).toThrow(/did not print the documented JSON array/);
  });
});
