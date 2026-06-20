/**
 * LiteLLM Login — Pi Extension
 *
 * The client only needs ONE URL:
 *   export LLM_PROXY_URL=http://localhost:4000   (default)
 *
 * Then in Pi:
 *   /login litellm       ← browser opens, log in, done
 *   /model litellm/gpt-4 ← pick model
 *   start coding!
 *
 * No API keys, no master key, no multiple URLs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

const PROXY_URL = process.env.LLM_PROXY_URL ?? "http://localhost:4000";

// ── Helpers ──────────────────────────────────────────────────
async function apiPost(path: string, body: URLSearchParams | string, auth?: string) {
	const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
	if (auth) headers["Authorization"] = `Bearer ${auth}`;

	const res = await fetch(`${PROXY_URL}${path}`, {
		method: "POST",
		headers,
		body: body.toString(),
	});
	const data = await res.json();
	if (!res.ok) throw new Error(data.error ?? data.error_description ?? `${res.status}`);
	return data;
}

async function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

// ── Device Flow (all through the proxy) ──────────────────────
async function getJwt(cb: OAuthLoginCallbacks): Promise<string> {
	// 1. Start device auth
	const d = await apiPost("/auth/device", new URLSearchParams({ client_id: "device-flow-client" }));

	// 2. Tell user to open URL
	cb.onProgress?.(`Open in browser: ${d.verification_uri_complete}`);
	try {
		cb.onAuth({ url: d.verification_uri_complete });
	} catch {
		// pi UI rendering may throw for some versions; progress message suffices
	}

	// 3. Poll for token
	const deadline = Date.now() + 5 * 60 * 1000;
	while (Date.now() < deadline) {
		await sleep((d.interval ?? 5) * 1000);
		try {
			const t = await apiPost(
				"/auth/token",
				new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: d.device_code,
					client_id: "device-flow-client",
				}),
			);
			if (t.access_token) return t.access_token;
		} catch (e: any) {
			if (e.message?.includes("authorization_pending")) {
				cb.onProgress?.("Waiting for browser login…");
				continue;
			}
			if (e.message?.includes("access_denied")) throw new Error("Denied by user");
			if (e.message?.includes("expired_token") || e.message?.includes("invalid_grant")) {
				throw new Error("Expired. Run /login again.");
			}
			cb.onProgress?.(`Waiting… (${e.message})`);
		}
	}
	throw new Error("Timed out");
}

// ── Login / Refresh ──────────────────────────────────────────
async function login(cb: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	cb.onProgress?.("Starting device authorization…");
	const jwt = await getJwt(cb);

	// After Keycloak login, check if admin provisioned a LiteLLM key
	cb.onProgress?.("Checking LLM access…");
	const checkRes = await fetch(`${PROXY_URL}/auth/check`, {
		headers: { Authorization: `Bearer ${jwt}` },
	});
	const check = await checkRes.json();
	if (!checkRes.ok || !check.authorized) {
		throw new Error(check.error ?? "No LLM access. Contact admin.");
	}

	return {
		access: jwt,
		refresh: jwt,
		expires: Date.now() + 55 * 60 * 1000,
	};
}

async function refreshToken(cred: OAuthCredentials): Promise<OAuthCredentials> {
	// Refresh by re-using the JWT (if still valid, proxy accepts it)
	return {
		access: cred.refresh,
		refresh: cred.refresh,
		expires: Date.now() + 55 * 60 * 1000,
	};
}

// ── Fetch models from proxy ─────────────────────────────────
async function fetchModels(): Promise<Array<{
	id: string;
	name: string;
	reasoning: boolean;
	input: readonly string[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}>> {
	try {
		const res = await fetch(`${PROXY_URL}/v1/models`);
		if (!res.ok) throw new Error(`${res.status}`);
		const body: any = await res.json();
		const items: Array<{ id: string }> = body?.data ?? [];
		return items.map((m) => ({
			id: m.id,
			name: m.id,
			reasoning: false,
			input: ["text"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}));
	} catch {
		// Fallback if proxy is unreachable
		return [
			{ id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo", reasoning: false, input: ["text"] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16385, maxTokens: 4096 },
			{ id: "gpt-4", name: "GPT-4", reasoning: false, input: ["text"] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 4096 },
		];
	}
}

// ── Extension ────────────────────────────────────────────────
export default async function (pi: ExtensionAPI) {
	const models = await fetchModels();

	pi.registerProvider("litellm", {
		name: "LiteLLM",
		baseUrl: PROXY_URL,
		api: "openai-completions",
		models,
		oauth: {
			name: "LiteLLM / Keycloak",
			login,
			refreshToken,
			getApiKey: (c: OAuthCredentials) => c.access,
		},
	});
}
