import { expect, test } from "bun:test";
import { getWatermark, openStateDb, setWatermark } from "./state.ts";

test("keeps v1 checkpoints and tracks v2 independently", () => {
  openStateDb(":memory:");
  setWatermark("session", 500);
  setWatermark("message", 600);
  expect(getWatermark("session_v2")).toBe(0);
  expect(getWatermark("message_v2")).toBe(0);
  setWatermark("session_v2", 100);
  setWatermark("message_v2", 200);
  expect(getWatermark("session")).toBe(500);
  expect(getWatermark("message")).toBe(600);
  expect(getWatermark("session_v2")).toBe(100);
  expect(getWatermark("message_v2")).toBe(200);
});
