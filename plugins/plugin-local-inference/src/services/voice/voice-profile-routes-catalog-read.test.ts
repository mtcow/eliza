/**
 * Covers how the voice-profile routes read `profiles/catalog.json`.
 *
 * A catalog that has never been written is the normal first-run layout and must
 * keep answering "no profiles". A catalog that exists but cannot be read is a
 * fault: the routes read → mutate → write the same file, so reporting it as
 * "no profiles" would rewrite the user's registered profiles away.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import { Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
	resolveStateDir: () => "/tmp",
}));

const { handleVoiceProfileRoutes }: typeof import("./voice-profile-routes") =
	await import("./voice-profile-routes");
type VoiceProfileCatalog = import("./voice-profile-routes").VoiceProfileCatalog;
type VoiceProfileRouteOptions =
	import("./voice-profile-routes").VoiceProfileRouteOptions;

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "voice-profile-routes-catalog-read-"),
	);
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function voiceModelsDir(): string {
	const dir = path.join(tmpDir, "models", "voice");
	fs.mkdirSync(path.join(dir, "profiles"), { recursive: true });
	return dir;
}

function catalogOpts(dir: string): VoiceProfileRouteOptions {
	return { voiceModelsDir: dir };
}

function makeReq(method: string, url: string): http.IncomingMessage {
	const req = new http.IncomingMessage(new Socket());
	req.method = method;
	req.url = url;
	req.headers = { host: "127.0.0.1:31337" };
	Object.defineProperty(req.socket, "remoteAddress", {
		value: "127.0.0.1",
		configurable: true,
	});
	return req;
}

function makeRes(): {
	res: http.ServerResponse;
	status: () => number;
	body: () => string;
} {
	const fakeReq = new http.IncomingMessage(new Socket());
	const res = new http.ServerResponse(fakeReq);
	let statusCode = 200;
	let chunks = Buffer.alloc(0);
	res.writeHead = ((code: number) => {
		statusCode = code;
		res.statusCode = code;
		return res;
	}) as typeof res.writeHead;
	res.end = ((chunk?: string | Buffer | Uint8Array) => {
		if (chunk) {
			chunks = Buffer.concat([
				chunks,
				Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
			]);
		}
		return res;
	}) as typeof res.end;
	return {
		res,
		status: () => statusCode,
		body: () => chunks.toString("utf8"),
	};
}

describe("GET /v1/voice/profiles catalog read", () => {
	it("reports no profiles when the catalog has never been created", async () => {
		const opts = catalogOpts(voiceModelsDir());
		const { res, status, body } = makeRes();
		const handled = await handleVoiceProfileRoutes(
			makeReq("GET", "/v1/voice/profiles"),
			res,
			opts,
		);

		expect(handled).toBe(true);
		expect(status()).toBe(200);
		expect(JSON.parse(body())).toEqual({
			defaultProfileId: "same",
			profiles: [],
		});
	});

	it("lists the profiles of a readable catalog", async () => {
		const dir = voiceModelsDir();
		const catalog: VoiceProfileCatalog = {
			version: 1,
			defaultProfileId: "same",
			profiles: [
				{
					id: "clone-x",
					displayName: "Clone X",
					instruct: "warm",
					active: true,
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
		};
		fs.writeFileSync(
			path.join(dir, "profiles", "catalog.json"),
			JSON.stringify(catalog),
		);

		const { res, status, body } = makeRes();
		await handleVoiceProfileRoutes(
			makeReq("GET", "/v1/voice/profiles"),
			res,
			catalogOpts(dir),
		);

		expect(status()).toBe(200);
		const ids = (
			JSON.parse(body()) as { profiles: { id: string }[] }
		).profiles.map((profile) => profile.id);
		expect(ids).toContain("clone-x");
	});

	it("surfaces an unreadable catalog instead of an empty profile list", async () => {
		const dir = voiceModelsDir();
		// A catalog path that exists but cannot be read as a file: before the fix
		// the route answered 200 with `profiles: []`, so a client saw "no voice
		// profiles installed" while the catalog was in fact broken.
		fs.mkdirSync(path.join(dir, "profiles", "catalog.json"));

		const { res, status, body } = makeRes();
		await expect(
			handleVoiceProfileRoutes(
				makeReq("GET", "/v1/voice/profiles"),
				res,
				catalogOpts(dir),
			),
		).rejects.toThrow(/catalog/i);

		expect(res.headersSent).toBe(false);
		expect(status()).toBe(200);
		expect(body()).toBe("");
	});

	it("refuses to rewrite a corrupt catalog from an empty one", async () => {
		const dir = voiceModelsDir();
		const catalogPath = path.join(dir, "profiles", "catalog.json");
		const corrupt =
			'{"version":1,"defaultProfileId":"same","profiles":[{"id":"clone-x"';
		fs.writeFileSync(catalogPath, corrupt);

		const { res } = makeRes();
		await expect(
			handleVoiceProfileRoutes(
				makeReq("DELETE", "/v1/voice/profiles/alloy"),
				res,
				catalogOpts(dir),
			),
		).rejects.toThrow(/catalog/i);

		expect(fs.readFileSync(catalogPath, "utf8")).toBe(corrupt);
	});
});
