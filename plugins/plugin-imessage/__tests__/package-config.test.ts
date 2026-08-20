/**
 * Verifies the published iMessage configuration hints keep runtime-defaulted
 * policy controls visible without requiring optional path overrides.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  agentConfig?: {
    pluginParameters?: Record<string, unknown>;
    configUiHints?: Record<string, { requiresAny?: string[] }>;
  };
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
) as PackageManifest;

describe("iMessage package config hints", () => {
  it("does not gate default-backed behavior fields on optional paths", () => {
    const hints = manifest.agentConfig?.configUiHints ?? {};
    for (const key of [
      "IMESSAGE_POLL_INTERVAL_MS",
      "IMESSAGE_DM_POLICY",
      "IMESSAGE_GROUP_POLICY",
      "IMESSAGE_ALLOW_FROM",
    ]) {
      expect(hints[key]?.requiresAny).toBeUndefined();
    }
  });

  it("does not advertise the deprecated auxiliary CLI transport", () => {
    expect(manifest.agentConfig?.pluginParameters).not.toHaveProperty("IMESSAGE_CLI_PATH");
    expect(manifest.agentConfig?.configUiHints).not.toHaveProperty("IMESSAGE_CLI_PATH");
  });
});
