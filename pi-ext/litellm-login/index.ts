/**
 * LiteLLM Login — Pi Extension
 *
 * Usage in Pi:
 *   /login-litellm    ← device flow login (prints URL to console)
 *   /refresh-models   ← re-fetch model list
 *   /logout-litellm   ← revoke session key
 *   /model litellm/flash
 *
 * Proxy URL defaults to http://localhost:4000.
 * Override with: export LLM_PROXY_URL=http://my-host:4000
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROXY_URL = process.env.LLM_PROXY_URL ?? "http://localhost:4000";
const STORE_PATH = join(homedir(), ".litellm-jwt");

// ── JWT persistence ─────────────────────────────────────────
function storeJwt(jwt: string) {
	try { writeFileSync(STORE_PATH, jwt, "utf-8"); } catch {}
}
function getStoredJwt(): string | null {
	try { return readFileSync(STORE_PATH, "utf-8").trim() || null; } catch { return null; }
}
function clearStoredJwt() {
	try { if (existsSync(STORE_PATH)) unlinkSync(STORE_PATH); } catch {}
}

// ── Helpers ──────────────────────────────────────────────────
async function apiPost(path: string, body: URLSearchParams) {
	const res = await fetch(`${PROXY_URL}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
	const data = await res.json();
	if (!res.ok) throw new Error(data.error ?? data.error_description ?? `${res.status}`);
	return data;
}

async function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

// ── Device flow ──────────────────────────────────────────────
async function doDeviceFlow(): Promise<string> {
	const d = await apiPost("/auth/device", new URLSearchParams({ client_id: "device-flow-client" }));

	console.log("\n========================================");
	console.log("Device Authorization");
	console.log("  Code:", d.user_code);
	console.log("  URL: ", d.verification_uri_complete);
	console.log("========================================\n");

	const deadline = Date.now() + 5 * 60 * 1000;
	while (Date.now() < deadline) {
		await sleep((d.interval ?? 5) * 1000);
		try {
			const t = await apiPost("/auth/token", new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: d.device_code,
				client_id: "device-flow-client",
			}));
			if (t.access_token) return t.access_token;
		} catch (e: any) {
			if (e.message?.includes("authorization_pending")) continue;
			if (e.message?.includes("access_denied")) throw new Error("Denied by user");
			if (e.message?.includes("expired_token") || e.message?.includes("invalid_grant")) {
				throw new Error("Expired. Run /login-litellm again.");
			}
		}
	}
	throw new Error("Timed out");
}

// ── Fetch models ─────────────────────────────────────────────
async function fetchModels() {
	try {
		const res = await fetch(`${PROXY_URL}/v1/models`);
		if (!res.ok) throw new Error(`${res.status}`);
		const body: any = await res.json();
		return (body?.data ?? []).map((m: any) => ({
			id: m.id,
			name: m.id,
			reasoning: false,
			input: ["text"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}));
	} catch {
		return [
			{ id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo", reasoning: false, input: ["text"] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16385, maxTokens: 4096 },
			{ id: "gpt-4", name: "GPT-4", reasoning: false, input: ["text"] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 4096 },
		];
	}
}

// ── Extension ────────────────────────────────────────────────
function registerProvider(pi: ExtensionAPI, models: any[], jwt?: string) {
	try { pi.unregisterProvider("litellm"); } catch {}
	pi.registerProvider("litellm", {
		name: "LiteLLM (Keycloak)",
		baseUrl: PROXY_URL,
		api: "openai-completions",
		apiKey: jwt ?? "litellm-proxy",  // After login: JWT → per-user auth
		models,
	});
}

export default async function (pi: ExtensionAPI) {
	const models = await fetchModels();
	const stored = getStoredJwt();
	registerProvider(pi, models, stored ?? undefined);

	pi.registerCommand("login-litellm", {
		description: "Login via Keycloak device flow and refresh model list",
		handler: async () => {
			const jwt = await doDeviceFlow();
			storeJwt(jwt);

			// Check LiteLLM authorization
			const checkRes = await fetch(`${PROXY_URL}/auth/check`, {
				headers: { Authorization: `Bearer ${jwt}` },
			});
			const check = await checkRes.json();
			if (!checkRes.ok || !check.authorized) {
				console.log("Access denied:", check.error);
				return;
			}

			// Register with JWT so all requests use per-user auth
			console.log("Fetching available models…");
			const newModels = await fetchModels();
			registerProvider(pi, newModels, jwt);

			console.log(`Login successful! Available models (${newModels.length}):`);
			for (const m of newModels) console.log(`  - ${m.id}`);
			console.log('Use /model litellm/... to select a model.');
		},
	});

	pi.registerCommand("logout-litellm", {
		description: "Logout and revoke LLM access",
		handler: async () => {
			console.log("Logging out…");
			try {
				const jwt = getStoredJwt();
				if (jwt) {
					const res = await fetch(`${PROXY_URL}/logout`, {
						headers: { Authorization: `Bearer ${jwt}` },
						method: "POST",
					});
					const body = await res.json().catch(() => ({}));
					console.log(body.status === "logged_out" ? "Logged out." : "Logout done.");
				} else {
					console.log("No active session found.");
				}
				clearStoredJwt();
				// Reset apiKey to dummy (no valid JWT anymore)
				const newModels = await fetchModels();
				registerProvider(pi, newModels);
			} catch (e: any) {
				console.log("Logout error:", e.message);
			}
		},
	});

	pi.registerCommand("refresh-models", {
		description: "Re-fetch model list from LiteLLM",
		handler: async () => {
			const newModels = await fetchModels();
			const stored = getStoredJwt();
			registerProvider(pi, newModels, stored ?? undefined);
			console.log(`Models updated (${newModels.length} available):`);
			for (const m of newModels) console.log(`  - ${m.id}`);
		},
	});
}
