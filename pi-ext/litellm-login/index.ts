/**
 * LiteLLM Login — Pi Extension
 *
 * Usage in Pi:
 *   /login-litellm    ← device flow login
 *   /logout-litellm   ← revoke session key
 *   /refresh-models   ← re-fetch model list
 *
 * Proxy URL defaults to http://localhost:4000.
 * Override with: export LLM_PROXY_URL=http://my-host:4000
 *
 * Credentials (Keycloak JWT + refresh token) are stored in
 * ~/.pi/agent/auth.json via AuthStorage as type: "oauth".
 * AuthStorage auto-refreshes the JWT when it nears expiry.
 */

import { AuthStorage, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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
					throw new Error("Expired. Run /login-litellm again.");
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

// ── JWT persistence (via AuthStorage, auto-refreshes OAuth tokens) ──
/** Read stored JWT from auth.json, auto-refreshing if expired. */
async function getStoredJwt(): Promise<string | null> {
	try {
		return await AUTH.getApiKey("litellm") ?? null;
	} catch { return null; }
}

/** Persist OAuth credentials (access + refresh + expiry) to auth.json. */
function storeOAuth(accessToken: string, refreshToken: string, expiresIn: number) {
	try {
		AUTH.set("litellm", {
			type: "oauth",
			access: accessToken,
			refresh: refreshToken,
			expires: Date.now() + expiresIn * 1000,
		});
	} catch {}
}

/** Remove credentials from auth.json. */
function clearStoredJwt() {
	try { AUTH.remove("litellm"); } catch {}
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
interface DeviceFlowResult {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
}

async function doDeviceFlow(ctx: ExtensionCommandContext): Promise<DeviceFlowResult> {
	const d = await apiPost("/auth/device", new URLSearchParams({ client_id: CLIENT_ID }));

	ctx.ui.setWidget("litellm-login", [
		"╭─ Device Authorization ─────────────────────╮",
		`│  Code: ${String(d.user_code).padEnd(37)}│`,
		`│  URL:                                       │`,
		`│  ${String(d.verification_uri_complete).padEnd(43)}│`,
		"╰──────────────────────────────────────────────╯",
	]);

	const deadline = Date.now() + 5 * 60 * 1000;
	let pollCount = 0;
	while (Date.now() < deadline) {
		await sleep((d.interval ?? 5) * 1000);
		pollCount++;
		ctx.ui.setWidget("litellm-login", [
			"╭─ Device Authorization ─────────────────────╮",
			`│  Code: ${String(d.user_code).padEnd(37)}│`,
			`│  URL:                                       │`,
			`│  ${String(d.verification_uri_complete).padEnd(43)}│`,
			`│  Waiting… (poll ${pollCount})${new Array(25).fill(" ").join("")}│`,
			"╰──────────────────────────────────────────────╯",
		]);
		try {
			const t = await apiPost("/auth/token", new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: d.device_code,
				client_id: CLIENT_ID,
			}));
			if (t.access_token) {
				return {
					accessToken: t.access_token,
					refreshToken: t.refresh_token,
					expiresIn: t.expires_in ?? 3600,
				};
			}
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

	pi.registerCommand("login-litellm", {
		description: "Login via Keycloak device flow",
		handler: async (_args, ctx) => {
			try {
				const { accessToken, refreshToken, expiresIn } = await doDeviceFlow(ctx);
				storeOAuth(accessToken, refreshToken, expiresIn);

				// Check authorization
				const checkRes = await fetch(`${PROXY_URL}/auth/check`, {
					headers: { Authorization: `Bearer ${accessToken}` },
				});
				const check = await checkRes.json();
				if (!checkRes.ok || !check.authorized) {
					ctx.ui.setWidget("litellm-login", [
						`Access denied: ${check.error}`,
						"Contact your admin to provision an LLM key.",
					]);
					ctx.ui.notify(`Access denied: ${check.error}`, "error");
					clearStoredJwt();
					return;
				}

				// Re-register with JWT
				ctx.ui.setStatus("litellm", "Loading models…");
				const newModels = await fetchModels();
				registerProvider(pi, newModels, accessToken);
				ctx.ui.setStatus("litellm", undefined);

				const modelList = newModels.map((m) => `  - ${m.id}`).join("\n");
				ctx.ui.setWidget("litellm-login", [
					"Login successful! Available models:",
					modelList,
					'Use /model litellm/... to select.',
				]);
			} catch (e: any) {
				const msg = String(e.message || e);
				ctx.ui.setWidget("litellm-login", [`Error: ${msg}`]);
				ctx.ui.notify(msg, "error");
			}
		},
	});

	pi.registerCommand("logout-litellm", {
		description: "Logout and revoke LLM access",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("litellm", "Logging out…");
			let isError = false;
			try {
				const jwt = await getStoredJwt();
				if (jwt) {
					const res = await fetch(`${PROXY_URL}/logout`, {
						headers: { Authorization: `Bearer ${jwt}` },
						method: "POST",
					});
					const body = await res.json().catch(() => ({}));
					if (body.status === "logged_out") {
						ctx.ui.notify("Logged out.", "info");
					} else {
						ctx.ui.notify("Session ended.", "info");
					}
				} else {
					ctx.ui.notify("No active session.", "info");
				}
			} catch (e: any) {
				isError = true;
				const msg = String(e.message || e);
				ctx.ui.setWidget("litellm-login", [`Logout error: ${msg}`]);
				ctx.ui.notify(`Logout: ${msg}`, "error");
			} finally {
				clearStoredJwt();
				const newModels = await fetchModels();
				registerProvider(pi, newModels);
				if (!isError) {
					ctx.ui.setWidget("litellm-login", undefined);
				}
				ctx.ui.setStatus("litellm", undefined);
			}
		},
	});

	pi.registerCommand("refresh-models", {
		description: "Re-fetch model list from LiteLLM",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("litellm", "Refreshing models…");
			const newModels = await fetchModels();
			const stored = await getStoredJwt();
			registerProvider(pi, newModels, stored ?? undefined);
			ctx.ui.setStatus("litellm", undefined);
			ctx.ui.setWidget("litellm-login", [
				`Models updated (${newModels.length} available):`,
				...newModels.map((m) => `  - ${m.id}`),
			]);
		},
	});
}
