/**
 * Phase 2c — chat model resolution for the structuring pass.
 *
 * Priority:
 *   1. Explicit chatModel{providerId,key} in the request.
 *   2. env ASSET_DISCOVERY_CHAT_MODEL (key) matched across active providers.
 *   3. First available non-error chat model.
 *
 * No hardcoded provider keys in code. Returns null if no chat model can be loaded
 * (the pipeline then degrades to raw_sources only with a warning — never crashes).
 */
import ModelRegistry from '@/lib/models/registry';
import BaseLLM from '@/lib/models/base/llm';
import { ModelWithProvider } from '@/lib/models/types';

const PREFERRED_CHAT_MODEL =
  process.env.ASSET_DISCOVERY_CHAT_MODEL ?? 'qwen/qwen3.6-27b';

export async function resolveChatLLM(
  registry: ModelRegistry,
  requested?: ModelWithProvider,
): Promise<{ llm: BaseLLM<any> | null; resolvedKey: string | null }> {
  // 1. Explicit request wins.
  if (requested?.providerId && requested?.key) {
    try {
      const llm = await registry.loadChatModel(requested.providerId, requested.key);
      return { llm, resolvedKey: requested.key };
    } catch (err) {
      console.warn(
        `asset-discovery: requested chatModel ${requested.key} failed to load (${err}); falling back to auto-pick`,
      );
    }
  }

  const providers = await registry.getActiveProviders();
  const usable = providers
    .map((p) => ({
      id: p.id,
      models: p.chatModels.filter((m) => m.key !== 'error'),
    }))
    .filter((p) => p.models.length > 0);

  // 2. env-preferred key.
  for (const p of usable) {
    const match = p.models.find((m) => m.key === PREFERRED_CHAT_MODEL);
    if (match) {
      try {
        const llm = await registry.loadChatModel(p.id, match.key);
        return { llm, resolvedKey: match.key };
      } catch {
        /* try next */
      }
    }
  }

  // 3. First available.
  for (const p of usable) {
    for (const m of p.models) {
      try {
        const llm = await registry.loadChatModel(p.id, m.key);
        return { llm, resolvedKey: m.key };
      } catch {
        /* try next */
      }
    }
  }

  return { llm: null, resolvedKey: null };
}
