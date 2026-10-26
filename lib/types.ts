/**
 * Shared types for the pi llama-swap extension.
 */

/** Persisted connection settings for llama-swap. */
export interface LlamaSwapConfig {
	/** Origin without path, e.g. `http://127.0.0.1`. */
	origin: string;
	/** TCP port (1–65535). */
	port: number;
	/** OpenAI API path prefix (default `/v1`). */
	basePath?: string;
	/** Optional API key sent as Bearer when set. */
	apiKey?: string;
	/** Per-model context window overrides (model id -> tokens). */
	contextOverrides?: Record<string, number>;
	/**
	 * Per-model pi `thinkingFormat` overrides (model id -> thinkingFormat).
	 *
	 * Controls how pi sends thinking to the backend:
	 * - `qwen`            -> vLLM-compatible `enable_thinking` (what this box's
	 *                        vLLM endpoint understands).
	 * - (unset)           -> package default: `reasoning_effort`, intended for
	 *                        llama.cpp endpoints.
	 *
	 * vLLM ignores `reasoning_effort`, so vLLM-backed models must set `qwen`.
	 */
	thinkingOverrides?: Record<string, ThinkingFormat>;
	/**
	 * Per-model max output token overrides (model id -> max_tokens).
	 * Used when the server's /v1/models metadata omits `max_tokens`
	 * (e.g. llama.cpp/EXL profiles report only context_length); without
	 * it pi caps output at 8192.
	 */
	maxTokensOverrides?: Record<string, number>;
}

/**
 * pi `compat.thinkingFormat` values (mirrors pi-ai Compat type; not exported
 * from the pi-coding-agent root, so declared locally).
 */
export type ThinkingFormat =
	| "openai"
	| "openrouter"
	| "deepseek"
	| "together"
	| "baseten"
	| "zai"
	| "qwen"
	| "chat-template"
	| "qwen-chat-template"
	| "string-thinking"
	| "ant-ling";

/** OpenAI-compatible model entry from GET /v1/models. */
export interface OpenAIModelEntry {
	id: string;
	name?: string;
	[key: string]: unknown;
}

/** OpenAI-compatible models list response. */
export interface OpenAIModelsListResponse {
	object?: string;
	data: OpenAIModelEntry[];
}

/** Result of a provider refresh attempt. */
export interface RefreshResult {
	baseUrl: string;
	modelCount: number;
	error?: string;
}
