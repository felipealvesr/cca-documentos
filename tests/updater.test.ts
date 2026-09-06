import { describe, expect, it } from "vitest";
import { compareVersions, parseManifest } from "../src/shared/update";

describe("release updater", () => {
  it("parses the electron-builder manifest", () => {
    expect(
      parseManifest(
        "version: 0.2.1\nfiles:\n  - url: CCA-Setup.exe\n    sha512: abc123\n    size: 1234\npath: CCA-Setup.exe\nsha512: abc123\n",
      ),
    ).toEqual({
      version: "0.2.1",
      path: "CCA-Setup.exe",
      sha512: "abc123",
      size: 1234,
    });
  });
  it("compares release versions and rejects unsafe installer paths", () => {
    expect(compareVersions("v0.3.0", "0.2.9")).toBe(1);
    expect(compareVersions("0.2.0", "v0.2.0")).toBe(0);
    expect(() => parseManifest("version: 0.2.1\npath: ../CCA-Setup.exe")).toThrow();
  });
});
