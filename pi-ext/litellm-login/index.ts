/**
 * LiteLLM Login — Pi Extension
 *
 * Usage in Pi:
 *   /login litellm      ← OAuth device flow (via pi's built-in /login)
 *   /logout litellm     ← clears auth.json credentials (built-in)
 *
 * Proxy URL defaults to http://localhost:4000.
 * Override with: export LLM_PROXY_URL=http://my-host:4000
 *
 * Credentials (Keycloak JWT + refresh token) are stored in
 * ~/.pi/agent/auth.json via AuthStorage as type: "oauth".
 * AuthStorage auto-refreshes the JWT when it nears expiry.
 */

import { AuthStorage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOAuthProvider, type OAuthProviderInterface } from "@earendil-works/pi-ai/oauth";

const PROXY_URL = process.env.LLM_PROXY_URL ?? "http://localhost:4000";
const CLIENT_ID = "device-flow-client";
const AUTH = AuthStorage.create();

// ── Keycloak OAuth provider (for auto-refresh & /login flow) ──
const keycloakOAuthProvider: OAuthProviderInterface = {
	id: "litellm",
	name: "LiteLLM (Keycloak)",

	async login(callbacks) {
		const d = await apiPost("/auth/device", new URLSearchParams({ client_id: CLIENT_ID }));

		callbacks.onDeviceCode({
			userCode: d.user_code,
			verificationUri: d.verification_uri_complete ?? d.verification_uri,
			intervalSeconds: d.interval ?? 5,
			expiresInSeconds: d.expires_in ?? 300,
		});

		const deadline = Date.now() + ((d.expires_in ?? 300) * 1000);
		let pollCount = 0;
		while (Date.now() < deadline) {
			await sleep((d.interval ?? 5) * 1000);
			pollCount++;
			callbacks.onProgress?.(`Waiting for authorization (poll ${pollCount})…`);
			try {
				const t = await apiPost("/auth/token", new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: d.device_code,
					client_id: CLIENT_ID,
				}));
				if (t.access_token) {
					return {
						refresh: t.refresh_token,
						access: t.access_token,
						expires: Date.now() + (t.expires_in ?? 3600) * 1000,
					};
				}
			} catch (e: any) {
				if (e.message?.includes("authorization_pending")) continue;
				if (e.message?.includes("access_denied")) throw new Error("Denied by user");
				if (e.message?.includes("expired_token") || e.message?.includes("invalid_grant")) {
					throw new Error("Expired. Run /login litellm again.");
				}
			}
		}
		throw new Error("Timed out");
	},

	async refreshToken(credentials) {
		const res = await fetch(`${PROXY_URL}/auth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: credentials.refresh,
				client_id: CLIENT_ID,
			}),
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			throw new Error(err.error_description ?? `Token refresh failed (${res.status})`);
		}
		const data = await res.json();
		return {
			refresh: data.refresh_token,
			access: data.access_token,
			expires: Date.now() + (data.expires_in ?? 3600) * 1000,
		};
	},

	getApiKey(credentials) {
		return credentials.access;
	},
};

registerOAuthProvider(keycloakOAuthProvider);

// ── JWT access (via AuthStorage, auto-refreshes OAuth tokens) ──
/** Read stored JWT from auth.json, auto-refreshing if expired. */
async function getStoredJwt(): Promise<string | null> {
	try {
		return await AUTH.getApiKey("litellm") ?? null;
	} catch { return null; }
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

// ── Provider registration ────────────────────────────────────
function registerProvider(pi: ExtensionAPI, models: any[], jwt?: string) {
	try { pi.unregisterProvider("litellm"); } catch {}
	pi.registerProvider("litellm", {
		name: "LiteLLM (Keycloak)",
		baseUrl: PROXY_URL,
		api: "openai-completions",
		apiKey: jwt ?? "litellm-proxy",
		models,
	});
}

export default async function (pi: ExtensionAPI) {
	const models = await fetchModels();
	const stored = await getStoredJwt();
	registerProvider(pi, models, stored ?? undefined);

	// Re-register provider with fresh JWT on session start.
	// This picks up credentials stored by /login litellm.
	pi.on("session_start", async (_event, ctx) => {
		const jwt = await getStoredJwt();
		if (jwt) {
			const newModels = await fetchModels();
			registerProvider(pi, newModels, jwt);
			ctx.ui.setWidget("litellm-login", [
				"Logged in (auto-refresh active).",
				`Models: ${newModels.length} available.`,
				'Use /model litellm/... to select.',
			]);
		}
	});
}
