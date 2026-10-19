/**
 * Regression coverage for the runtime-cache token store: an unreadable cache is
 * a storage fault, not "no stored credentials". Reading `null` there makes
 * `getAccessToken()` start a fresh interactive OAuth login, hiding the outage.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { OAuth2PKCEAuthProvider } from "./oauth2-pkce";
import { RuntimeCacheTokenStore } from "./token-store";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function runtimeWithCache(
  getCache: (key: string) => Promise<unknown>,
): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    getSetting: (key: string) =>
      (
        {
          TWITTER_CLIENT_ID: "client-id",
          TWITTER_REDIRECT_URI: "http://127.0.0.1/callback",
        } as Record<string, string>
      )[key],
    getCache: vi.fn(getCache),
    setCache: vi.fn(async () => undefined),
  } as unknown as IAgentRuntime;
}

describe("RuntimeCacheTokenStore", () => {
  it("still reports an empty cache slot as no stored tokens", async () => {
    const store = new RuntimeCacheTokenStore(
      runtimeWithCache(async () => undefined),
    );

    await expect(store.load()).resolves.toBeNull();
  });

  it("propagates a cache read failure instead of reporting no stored tokens", async () => {
    const store = new RuntimeCacheTokenStore(
      runtimeWithCache(async () => {
        throw new Error("cache backend unavailable");
      }),
    );

    await expect(store.load()).rejects.toThrow("cache backend unavailable");
  });

  it("fails the token request when the cache is unreadable instead of starting a new login", async () => {
    const runtime = runtimeWithCache(async () => {
      throw new Error("cache backend unavailable");
    });
    const interactiveLogin = vi.fn(async () => ({
      access_token: "fresh-token",
      expires_at: Date.now() + 3_600_000,
    }));
    const provider = new OAuth2PKCEAuthProvider(
      runtime,
      undefined,
      new RuntimeCacheTokenStore(runtime, "default"),
      vi.fn<typeof fetch>(),
      interactiveLogin,
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      "cache backend unavailable",
    );
    expect(interactiveLogin).not.toHaveBeenCalled();
  });
});
