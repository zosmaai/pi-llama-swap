/**
 * Pi extension entry: llama-swap provider(s) with dynamic model discovery.
 *
 * Usage: pi -e /path/to/pi-llama-swap
 *
 * Config (optional): ~/.pi/agent/pi-llama-swap.json overrides defaults.
 * Top-level fields configure the default server (provider `llama-swap`);
 * a `servers` array adds named servers (providers `llama-swap-<name>`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig, saveContextOverride } from "./lib/config.js";
import { PROVIDER_ID, providerIdFor, refreshProvider } from "./lib/provider.js";
import type { RefreshResult } from "./lib/types.js";

/**
 * Pi extension factory (async for model discovery before startup).
 * @param pi - Extension API instance.
 */
export default async function llamaSwapExtension(pi: ExtensionAPI): Promise<void> {
	const config = await loadConfig();

	const targets = [
		{ providerId: PROVIDER_ID, server: config.defaultServer },
		...config.servers.map((entry) => ({ providerId: providerIdFor(entry.name), server: entry })),
	];

	const results: RefreshResult[] = [];
	for (const target of targets) {
		results.push(await refreshProvider(pi, target.providerId, target.server, { isInitial: true }));
	}

	for (const result of results) {
		if (result.error) {
			console.warn(`[llama-swap] ${result.providerId} (${result.baseUrl}): ${result.error}`);
		}
	}

	pi.registerCommand("llama-swap-set-context-length", {
		description: "Set or clear context window override for the current model",
		handler: async (args, ctx) => {
			const model = ctx.model;
			if (!model || !model.provider.startsWith(`${PROVIDER_ID}-`) && model.provider !== PROVIDER_ID) {
				ctx.ui.notify("No llama-swap model selected. Use /model first.", "warning");
				return;
			}
			// Named provider `llama-swap-<name>` -> per-server override section.
			const serverName = model.provider === PROVIDER_ID ? undefined : model.provider.slice(PROVIDER_ID.length + 1);

			const trimmed = args.trim();

			if (trimmed === "auto") {
				const ok = await ctx.ui.confirm(
					"Clear context override",
					`Use auto-detected context window for "${model.id}"?`,
				);
				if (!ok) return;

				await saveContextOverride(model.id, undefined, serverName);
				// ponyail: reload config + refresh to pick up removed override
				const config = await loadConfig();
				await refreshProvider(pi, model.provider, serverName
					? config.servers.find((s) => s.name === serverName) ?? config.defaultServer
					: config.defaultServer);
				ctx.ui.notify(`Context override removed for ${model.id}. Now auto-detected.`);
				return;
			}

			const ctxSize = Number(trimmed);
			if (!Number.isInteger(ctxSize) || ctxSize < 1) {
				ctx.ui.notify(
					"Invalid context size. Use a positive integer or \"auto\".\nExample: /llama-swap-set-context-length 32768",
					"error",
				);
				return;
			}

			const ok = await ctx.ui.confirm(
				"Set context override",
				`Set context window to ${ctxSize} for "${model.id}"?`,
			);
			if (!ok) return;

			await saveContextOverride(model.id, ctxSize, serverName);
			// ponyail: reload config + refresh to pick up new override
			const config = await loadConfig();
			await refreshProvider(pi, model.provider, serverName
				? config.servers.find((s) => s.name === serverName) ?? config.defaultServer
				: config.defaultServer);
			ctx.ui.notify(`Context window for ${model.id} set to ${ctxSize}.`);
		},
	});
}
