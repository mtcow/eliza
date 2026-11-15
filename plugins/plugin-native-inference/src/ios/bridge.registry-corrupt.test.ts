/**
 * A corrupt `registry.json` must not be reported (and then persisted) as an
 * empty model registry.
 *
 * `readJsonObjectFile` collapses "registry absent" and "registry unparseable"
 * into the same `{}`. `upsertInstalledModel` — the only writer of that file —
 * read through it, so a completed download replaced the damaged registry with
 * `{"version":1,"models":[<the one new model>]}`: every previously installed
 * model's record (lastUsedAt, dimensions, hfRepo, bundleVerifiedAt) was dropped
 * and the download job reported success. The caller had no way to see that the
 * stored state was damaged rather than empty.
 *
 * `readAssignmentsSnapshot` already encodes the rule for `assignments.json`
 * ("Only ENOENT means 'there is no state yet'"); this file applies it to the
 * registry, which is read-modify-written by the download path.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileFsGlobals } from "../shared/fs-sandbox.ts";
import { handleDirectCoreRoute, type IosBridgeBackend } from "./bridge.ts";

const savedStateDir = process.env.ELIZA_STATE_DIR;
const tempDirs: string[] = [];
/** A registry cut off mid-write: valid prefix, no closing braces. */
const TRUNCATED_REGISTRY =
  '{"version":1,"models":[{"id":"eliza-1-2b","path":"models/text/eliza-1-2b-128k.gguf","displayName":"eliza-1-2B"';

const fsGlobals = globalThis as MobileFsGlobals;
let previousResolver: MobileFsGlobals["__ELIZA_MOBILE_FS_RESOLVE__"];

beforeEach(() => {
  previousResolver = fsGlobals.__ELIZA_MOBILE_FS_RESOLVE__;
  fsGlobals.__ELIZA_MOBILE_FS_RESOLVE__ = (inputPath) => inputPath;
});

afterEach(() => {
  fsGlobals.__ELIZA_MOBILE_FS_RESOLVE__ = previousResolver;
  vi.unstubAllGlobals();
  if (savedStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = savedStateDir;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function useStateDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ios-bridge-registry-"));
  tempDirs.push(dir);
  process.env.ELIZA_STATE_DIR = dir;
  return dir;
}

function registryPath(stateDir: string): string {
  return path.join(stateDir, "local-inference", "registry.json");
}

function backend(): IosBridgeBackend {
  return {
    runtime: {} as IAgentRuntime,
    dispatchRoute: async () => null,
    cloudInferenceRejection: () => null,
    conversations: new Map(),
    close: async () => {},
  };
}

async function getDownloads(): Promise<Array<Record<string, unknown>>> {
  const res = await handleDirectCoreRoute(
    backend(),
    "GET",
    "/api/local-inference/downloads",
    {},
  );
  if (!res) throw new Error("downloads route returned null");
  return JSON.parse(res.body).downloads as Array<Record<string, unknown>>;
}

async function waitForTerminalJob(
  modelId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = (await getDownloads()).find(
      (entry) => entry.modelId === modelId,
    );
    if (job && (job.state === "completed" || job.state === "failed")) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`download job for ${modelId} never reached a terminal state`);
}

/**
 * Serve a tiny GGUF payload so the download reaches the registry write. If the
 * registry guard fires first, `fetch` is never called — both are valid, but
 * without this stub the "before" run cannot demonstrate the overwrite.
 */
function stubModelDownload(): ReturnType<typeof vi.fn> {
  const payload = Buffer.from("GGUF0000tiny-model-bytes");
  const fetchStub = vi.fn(
    async () =>
      new Response(payload, {
        status: 200,
        headers: { "content-length": String(payload.byteLength) },
      }),
  );
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

describe("iOS bridge — local model registry storage", () => {
  it("refuses to replace an unparseable registry when recording a download", async () => {
    const stateDir = useStateDir();
    const filePath = registryPath(stateDir);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, TRUNCATED_REGISTRY);
    stubModelDownload();

    const res = await handleDirectCoreRoute(
      backend(),
      "POST",
      "/api/local-inference/downloads",
      { body: JSON.stringify({ modelId: "eliza-1-2b" }) },
    );
    expect(res?.status).toBe(200);

    const job = await waitForTerminalJob("eliza-1-2b");
    // The damaged bytes survive for recovery instead of being replaced by the
    // registry the read collapsed them into.
    expect(readFileSync(filePath, "utf8")).toBe(TRUNCATED_REGISTRY);
    expect(job.state).toBe("failed");
    expect(String(job.error)).toMatch(/registry/i);
  });

  it("refuses to replace a registry whose models field is not an array", async () => {
    const stateDir = useStateDir();
    const filePath = registryPath(stateDir);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const damaged = '{"version":1,"models":"damaged"}';
    writeFileSync(filePath, damaged);
    stubModelDownload();

    await handleDirectCoreRoute(
      backend(),
      "POST",
      "/api/local-inference/downloads",
      { body: JSON.stringify({ modelId: "eliza-1-2b" }) },
    );

    const job = await waitForTerminalJob("eliza-1-2b");
    expect(job.state).toBe("failed");
    expect(readFileSync(filePath, "utf8")).toBe(damaged);
  });

  it("still records a download when no registry exists yet", async () => {
    const stateDir = useStateDir();
    const filePath = registryPath(stateDir);
    stubModelDownload();

    await handleDirectCoreRoute(
      backend(),
      "POST",
      "/api/local-inference/downloads",
      { body: JSON.stringify({ modelId: "eliza-1-2b" }) },
    );

    const job = await waitForTerminalJob("eliza-1-2b");
    expect(job.state).toBe("completed");
    const written = JSON.parse(readFileSync(filePath, "utf8"));
    expect(written.models.map((entry: { id: string }) => entry.id)).toEqual([
      "eliza-1-2b",
    ]);
  });
});
