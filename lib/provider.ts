/**
 * Pi provider registration and model list refresh for llama-swap.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import { buildModelLimits, resolveContextWindow, resolveMaxTokens } from "./context.js";
import { fetchModels, LlamaSwapClientError } from "./client.js";
import { buildBaseUrl } from "./url.js";
import type { LlamaSwapConfig, OpenAIModelEntry, RefreshResult } from "./types.js";

export const PROVIDER_ID = "llama-swap";

/**
 * Placeholder apiKey so pi lists models when llama-swap has no apiKeys.
 * OpenAI client may send `Authorization: Bearer <this>`; most open local proxies ignore it.
 */
export const NO_AUTH_API_KEY_PLACEHOLDER = "local-no-auth";

/** Whether a successful provider registration has occurred this session. */
let hasRegisteredProvider = false;

/**
 * Maps OpenAI model entries to pi provider model definitions.
 * @param entries - Models from GET /v1/models.
 * @param contextByModel - Resolved context window per model id.
 * @param maxTokensByModel - Resolved max output tokens per model id.
 * @returns Pi-compatible model configs.
 */
export function mapOpenAIModelsToPi(
	entries: OpenAIModelEntry[],
	contextByModel: Map<string, number>,
	maxTokensByModel: Map<string, number>,
	thinkingOverrides?: Record<string, string>,
): ProviderModelConfig[] {
	return entries.map((model) => {
		const contextWindow = resolveContextWindow(model.id, contextByModel);
		const maxTokens = resolveMaxTokens(model.id, maxTokensByModel, contextWindow);
		const name = typeof model.name === "string" && model.name.length > 0 ? model.name : model.id;

		const cfg: ProviderModelConfig = {
			id: model.id,
			name,
			// Enable reasoning/thinking: exposes the thinking cycle
			// (app.thinking.cycle) in the TUI.
			reasoning: true,
			// Map pi thinking levels onto `reasoning_effort` values the backend
			// accepts. Levels mapped to null are HIDDEN from the pi thinking
			// cycle (pi-ai getSupportedThinkingLevels treats null as unsupported;
			// xhigh/max are also hidden when the entry is missing).
			// The Qwen3.8 Strata templates (DavidAU + turboderp) accept:
			// none (thinking off), low, medium, xhigh -- so minimal, high and
			// max are null instead of remapped, and never appear in /thinking.
			thinkingLevelMap: {
				off: "none", // thinking off: sends reasoning_effort=none under thinkingFormat=openai; never sent under qwen (enable_thinking=false)
				minimal: null,
				low: "low",
				medium: "medium",
				high: null,
				xhigh: "xhigh",
				max: null,
			},
			// vLLM and TabbyAPI both accept a flat top-level `enable_thinking`, and both
			// need it: vLLM ignores a bare `reasoning_effort` entirely, while TabbyAPI
			// forwards it straight to a template that rejects most values. Sending both
			// keeps effort granularity AND gives a real off switch.
			compat: {
				supportsReasoningEffort: true,
				thinkingFormat: "qwen",
			},
			input: ["text", "image"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
		};

		// Per-model override: when set, tell pi to send thinking using the
		// vLLM-compatible `enable_thinking` format (`qwen`) instead of the
		// llama.cpp default `reasoning_effort`. vLLM ignores `reasoning_effort`,
		// so vLLM-backed models MUST set this to "qwen".
		const override = thinkingOverrides?.[model.id];
		if (override) {
			cfg.compat = { ...(cfg.compat ?? {}), thinkingFormat: override };
			console.warn(`[llama-swap] model ${model.id}: thinkingFormat override applied -> ${override} (sends enable_thinking to vLLM)`);
		}

		return cfg;
	});
}

/**
 * Registers the llama-swap provider with the given models.
 * @param pi - Pi extension API.
 * @param config - Connection settings.
 * @param models - Model list (may be empty).
 */
export function registerLlamaSwapProvider(
	pi: ExtensionAPI,
	config: LlamaSwapConfig,
	models: ProviderModelConfig[],
): void {
	const baseUrl = buildBaseUrl(config);
	const hasKey = Boolean(config.apiKey?.trim());

	const providerConfig = {
		name: "Llama Swap",
		baseUrl,
		api: "openai-completions" as const,
		models,
		...(hasKey
			? { apiKey: config.apiKey, authHeader: true }
			: models.length > 0
				? { apiKey: NO_AUTH_API_KEY_PLACEHOLDER }
				: {}),
	};

	pi.registerProvider(PROVIDER_ID, providerConfig);
	hasRegisteredProvider = true;
}

/**
 * Fetches models, then replaces the provider only after a successful fetch.
 * On failure after a prior success, leaves the previous registration untouched.
 * @param pi - Pi extension API.
 * @param config - Effective connection settings.
 * @param options - `isInitial`: first load; may register empty provider on failure.
 * @returns Refresh outcome with base URL and model count.
 */
export async function refreshProvider(
	pi: ExtensionAPI,
	config: LlamaSwapConfig,
	options?: { isInitial?: boolean },
): Promise<RefreshResult> {
	const baseUrl = buildBaseUrl(config);

	try {
		const entries = await fetchModels(baseUrl, config.apiKey);
		const { contextByModel, maxTokensByModel } = await buildModelLimits(entries, config, config.contextOverrides);
		// User maxTokensOverrides beat server-reported max_tokens (llama.cpp/EXL
		// profiles often omit it; default fallback is 8192).
		if (config.maxTokensOverrides) {
			for (const [id, tokens] of Object.entries(config.maxTokensOverrides)) {
				maxTokensByModel.set(id, tokens);
			}
		}
		const models = mapOpenAIModelsToPi(entries, contextByModel, maxTokensByModel, config.thinkingOverrides);

		if (hasRegisteredProvider) {
			pi.unregisterProvider(PROVIDER_ID);
		}
		registerLlamaSwapProvider(pi, config, models);

		return { baseUrl, modelCount: models.length };
	} catch (err) {
		const message = err instanceof LlamaSwapClientError ? err.message : err instanceof Error ? err.message : String(err);

		if (options?.isInitial) {
			registerLlamaSwapProvider(pi, config, []);
			return { baseUrl, modelCount: 0, error: message };
		}

		return { baseUrl, modelCount: 0, error: message };
	}
}
