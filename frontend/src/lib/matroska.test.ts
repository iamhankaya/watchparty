import { describe, expect, test } from "vitest";
import {
  audioWarning,
  MKV_HEADER_BYTES,
  readMatroskaTracks,
  type MkvInspection,
  type MkvTrack,
} from "./matroska";

// Sözleşme (T20261029-25): şekil ve sabitler; ayrıştırma mantığı uygulama fazında.
describe("matroska sözleşmesi", () => {
  test("başlık okuma bütçesi 2 MiB", () => expect(MKV_HEADER_BYTES).toBe(2 * 1024 * 1024));

  test("iz ve inceleme şekli", () => {
    const track: MkvTrack = { number: 1, type: "audio", codecId: "A_AC3", audio: "unsupported", language: "tur", name: "Türkçe" };
    const ok: MkvInspection = { status: "ok", tracks: [track] };
    const failed: MkvInspection = { status: "unreadable", tracks: [] };
    expect([ok.status, failed.status]).toEqual(["ok", "unreadable"]);
  });

  test("imzalar", () => {
    expect(readMatroskaTracks).toBeTypeOf("function");
    expect(audioWarning).toBeTypeOf("function");
  });
});
