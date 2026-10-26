/**
 * Load llama-swap extension configuration from ~/.pi/agent/pi-llama-swap.json.
 *
 * Shape: top-level fields configure the DEFAULT server (provider id
 * `llama-swap`); an optional `servers` array adds named extra servers
 * (provider ids `llama-swap-<name>`).
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultConfig, mergeConfig, parsePortArg, parseUrlArg } from "./url.js";
import type { LlamaSwapFileConfig, ResolvedConfig, ServerConfig, ServerEntry, ThinkingFormat } from "./types.js";

const CONFIG_FILENAME = "pi-llama-swap.json";

/**
 * Path to the config file under `~/.pi/agent/`.
 * @returns Absolute path to pi-llama-swap.json.
 */
export function configPath(): string {
	return join(homedir(), ".pi", "agent", CONFIG_FILENAME);
}

/**
 * Reads and parses the config file if it exists.
 * @param path - File path to read.
 * @returns Parsed config or null when missing.
 */
async function readConfigFile(path: string): Promise<LlamaSwapFileConfig | null> {
	try {
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw) as LlamaSwapFileConfig;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw err;
	}
}

/**
 * Validates and normalizes per-server connection fields.
 * @param raw - Partial server settings from JSON.
 * @returns Normalized config fragment.
 */
function normalizeServer(raw: Partial<ServerConfig>): Partial<ServerConfig> {
	const out: Partial<ServerConfig> = {};
	if (typeof raw.origin === "string" && raw.origin.trim()) {
		out.origin = raw.origin.trim();
	}
	if (typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535) {
		out.port = raw.port;
	}
	if (typeof raw.basePath === "string" && raw.basePath.trim()) {
		out.basePath = raw.basePath.trim();
	}
	if (typeof raw.apiKey === "string" && raw.apiKey.length > 0) {
		out.apiKey = raw.apiKey;
	}
	if (raw.contextOverrides && typeof raw.contextOverrides === "object") {
		const overrides: Record<string, number> = {};
		for (const [model, size] of Object.entries(raw.contextOverrides)) {
			if (typeof size === "number" && Number.isInteger(size) && size > 0) {
				overrides[model] = size;
			}
		}
		if (Object.keys(overrides).length > 0) {
			out.contextOverrides = overrides;
		}
	}
	if (raw.thinkingOverrides && typeof raw.thinkingOverrides === "object") {
		const overrides: Record<string, ThinkingFormat> = {};
		for (const [model, format] of Object.entries(raw.thinkingOverrides)) {
			if (typeof format === "string" && format.trim()) {
				// Trust boundary: JSON config; pi rejects unknown formats at request time.
				overrides[model] = format.trim() as ThinkingFormat;
			}
		}
		if (Object.keys(overrides).length > 0) {
			out.thinkingOverrides = overrides;
		}
	}
	if (raw.maxTokensOverrides && typeof raw.maxTokensOverrides === "object") {
		const overrides: Record<string, number> = {};
		for (const [model, tokens] of Object.entries(raw.maxTokensOverrides)) {
			if (typeof tokens === "number" && Number.isInteger(tokens) && tokens > 0) {
				overrides[model] = tokens;
			}
		}
		if (Object.keys(overrides).length > 0) {
			out.maxTokensOverrides = overrides;
		}
	}
	return out;
}

/**
 * Validates and normalizes the `servers` array.
 * Entries without a valid non-empty string `name` are skipped.
 * @param raw - Raw entries from JSON.
 * @returns Normalized named server entries.
 */
function normalizeServers(raw: unknown): Partial<ServerEntry>[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const entries: Partial<ServerEntry>[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const candidate = item as Partial<ServerEntry>;
		if (typeof candidate.name !== "string" || !candidate.name.trim()) {
			continue;
		}
		const name = candidate.name.trim();
		if (name === "default" || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
			// "default" is reserved for the top-level config section.
			continue;
		}
		entries.push({ name, ...normalizeServer(candidate) });
	}
	return entries;
}

/**
 * Applies environment variable overrides (highest precedence, default server only).
 * @param config - Default server after file merge.
 * @returns Config with env overrides applied.
 */
export function applyEnvOverrides(config: ServerConfig): ServerConfig {
	let result = { ...config };

	const urlEnv = process.env.LLAMA_SWAP_URL?.trim();
	if (urlEnv) {
		const parsed = parseUrlArg(urlEnv);
		result = mergeConfig(result, {
			origin: parsed.origin,
			...(parsed.port !== undefined ? { port: parsed.port } : {}),
			...(parsed.basePath !== undefined ? { basePath: parsed.basePath } : {}),
		});
	}

	const portEnv = process.env.LLAMA_SWAP_PORT?.trim();
	if (portEnv) {
		result = mergeConfig(result, { port: parsePortArg(portEnv) });
	}

	const keyEnv = process.env.LLAMA_SWAP_API_KEY?.trim();
	if (keyEnv) {
		result = mergeConfig(result, { apiKey: keyEnv });
	}

	return result;
}

/**
 * Loads config: defaults, optional ~/.pi/agent/pi-llama-swap.json (default
 * server fields + optional `servers` array), then env overrides.
 * @returns Resolved default server plus named extra servers.
 */
export async function loadConfig(): Promise<ResolvedConfig> {
	const file = await readConfigFile(configPath());

	const defaultServer = applyEnvOverrides(
		mergeConfig(defaultConfig(), normalizeServer(file ?? {})),
	);

	const servers = normalizeServers(file?.servers);

	// Reject duplicate names deterministically: first occurrence wins.
	const seen = new Set<string>();
	const deduped: ServerEntry[] = [];
	for (const entry of servers) {
		if (entry.name === undefined || seen.has(entry.name)) {
			continue;
		}
		seen.add(entry.name);
		deduped.push(mergeConfig(defaultConfig(), entry) as ServerEntry);
	}

	return { defaultServer, servers: deduped };
}

/**
 * Updates the context-overrides map for a model in the config file.
 * @param model - Model id to set or clear.
 * @param ctxSize - Context size in tokens, or undefined to remove the override.
 * @param serverName - Named server section to write; omit for the default section.
 */
export async function saveContextOverride(
	model: string,
	ctxSize: number | undefined,
	serverName?: string,
): Promise<void> {
	const path = configPath();
	let current: Record<string, unknown> = {};
	try {
		const raw = await readFile(path, "utf8");
		current = JSON.parse(raw) as Record<string, unknown>;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}

	const setOverrides = (section: Record<string, unknown>) => {
		const overrides = (section.contextOverrides as Record<string, number> | undefined) ?? {};
		if (ctxSize === undefined) {
			delete overrides[model];
		} else {
			overrides[model] = ctxSize;
		}
		section.contextOverrides = overrides;
	};

	if (serverName) {
		const servers = Array.isArray(current.servers) ? (current.servers as Record<string, unknown>[]) : [];
		const entry = servers.find((s) => (s as { name?: string }).name === serverName);
		if (entry) {
			setOverrides(entry);
		} else {
			servers.push({ name: serverName, contextOverrides: ctxSize === undefined ? {} : { [model]: ctxSize } });
			current.servers = servers;
		}
	} else {
		setOverrides(current);
	}

	await writeFile(path, JSON.stringify(current, null, 2), "utf8");
}
