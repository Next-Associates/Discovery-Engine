/**
 * POST /api/asset-discovery  (Phase 2c — Unified Asset Discovery)
 *
 * Default path: the deterministic structured pipeline (see lib/agents/assetDiscovery).
 * Accepts `requirements[]` and/or `query`, searches + scrapes top-N sources with a
 * MANDATORY catalog scrape on asset intent, and returns clean structured JSON
 * (no prose). Milestone 1 returns raw per-source candidates; later milestones add
 * datasets[], grounding, verification_status, interaction{}, requirement_ids[].
 *
 * Legacy path (Phase 2b): send `{ "legacy": true, ... }` to run the original search
 * agent and get `{ message, sources, verified_downloads, interaction_required_downloads }`.
 * Kept as a documented fallback while 2c stabilizes. /api/search and /api/chat are
 * untouched.
 */
import ModelRegistry from '@/lib/models/registry';
import { ModelWithProvider } from '@/lib/models/types';
import SessionManager from '@/lib/session';
import { Chunk, ChatTurnMessage } from '@/lib/types';
import { SearchSources } from '@/lib/agents/search/types';
import APISearchAgent from '@/lib/agents/search/api';
import { runAssetDiscovery } from '@/lib/agents/assetDiscovery/pipeline';
import { AssetDiscoveryInput } from '@/lib/agents/assetDiscovery/types';

interface AssetDiscoveryRequestBody {
  optimizationMode: 'speed' | 'balanced' | 'quality';
  sources: SearchSources[];
  chatModel: ModelWithProvider;
  embeddingModel: ModelWithProvider;
  query: string;
  history: Array<[string, string]>;
  systemInstructions?: string;
}

type StructuredDownload = {
  label: string;
  url: string;
  status: number;
  sourcePage?: string;
};

const VERIFIED_HEADER = '## Verified download links';
const INTERACTION_HEADER = '## Downloads requiring user interaction';
// `- {label}: {url} (verified HTTP {status})`
const VERIFIED_LINE =
  /^-\s*(.*?):\s*(https?:\/\/\S+?)\s*\(verified HTTP\s*(\d+)\)\s*$/i;
// `- {label}: {url} (HTTP {status}, requires user interaction)`
const INTERACTION_LINE =
  /^-\s*(.*?):\s*(https?:\/\/\S+?)\s*\(HTTP\s*(\d+),\s*requires user interaction\)\s*$/i;

function parseSectionDownloads(
  content: string,
  header: string,
  lineRe: RegExp,
  sourcePage?: string,
): StructuredDownload[] {
  if (!content || !content.includes(header)) return [];

  const out: StructuredDownload[] = [];
  const lines = content.split('\n');
  let inSection = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith(header)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (line.startsWith('## ')) break;
    if (line === '') continue;

    const m = line.match(lineRe);
    if (m) {
      out.push({
        label: m[1].trim() || m[2],
        url: m[2],
        status: Number(m[3]) || 200,
        sourcePage,
      });
    }
  }
  return out;
}

/** Pull structured verified downloads out of a single source's content. */
export function parseVerifiedDownloads(
  content: string,
  sourcePage?: string,
): StructuredDownload[] {
  return parseSectionDownloads(content, VERIFIED_HEADER, VERIFIED_LINE, sourcePage);
}

/** Pull gated/interaction-required downloads from a single source's content. */
export function parseInteractionRequiredDownloads(
  content: string,
  sourcePage?: string,
): StructuredDownload[] {
  return parseSectionDownloads(content, INTERACTION_HEADER, INTERACTION_LINE, sourcePage);
}

function collectStructuredDownloads(
  sources: Chunk[],
  parser: (content: string, sourcePage?: string) => StructuredDownload[],
): StructuredDownload[] {
  const seen = new Set<string>();
  const merged: StructuredDownload[] = [];
  for (const src of sources) {
    const page =
      (src.metadata && (src.metadata.url as string)) || undefined;
    for (const d of parser(src.content, page)) {
      const key = d.url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(d);
    }
  }
  return merged;
}

export const POST = async (req: Request) => {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ message: 'Invalid JSON body' }, { status: 400 });
  }

  // Phase 2c is the default. Opt into the legacy Phase 2b agent with { legacy: true }.
  if (!body?.legacy) {
    return handleStructured(body);
  }
  return handleLegacy(body as AssetDiscoveryRequestBody);
};

/** Phase 2c — deterministic structured pipeline. */
async function handleStructured(body: any): Promise<Response> {
  try {
    const hasRequirements =
      Array.isArray(body?.requirements) && body.requirements.length > 0;
    const hasQuery = typeof body?.query === 'string' && body.query.trim();
    if (!hasRequirements && !hasQuery) {
      return Response.json(
        { message: 'One of `requirements[]` or `query` is required' },
        { status: 400 },
      );
    }

    const input: AssetDiscoveryInput = {
      requirements: body.requirements,
      query: body.query,
      urls: body.urls,
      sources: body.sources,
      optimizationMode: body.optimizationMode,
      maxSources: body.maxSources,
      history: body.history,
      include_superseded_assets: body.include_superseded_assets,
      include_sources: body.include_sources,
      chatModel: body.chatModel,
      embeddingModel: body.embeddingModel,
      systemInstructions: body.systemInstructions,
    };

    const result = await runAssetDiscovery(input);
    return Response.json(result, { status: 200 });
  } catch (err: any) {
    console.error(`Error in asset-discovery (2c): ${err?.message}`);
    return Response.json(
      { message: 'An error has occurred.', error: String(err?.message ?? err) },
      { status: 500 },
    );
  }
}

/** Phase 2b — legacy search-agent path (fallback). */
async function handleLegacy(body: AssetDiscoveryRequestBody): Promise<Response> {
  try {
    if (!body.sources || !body.query) {
      return Response.json(
        { message: 'Missing sources or query' },
        { status: 400 },
      );
    }

    body.history = body.history || [];
    body.optimizationMode = body.optimizationMode || 'balanced';

    const registry = new ModelRegistry();

    const [llm, embeddings] = await Promise.all([
      registry.loadChatModel(body.chatModel.providerId, body.chatModel.key),
      registry.loadEmbeddingModel(
        body.embeddingModel.providerId,
        body.embeddingModel.key,
      ),
    ]);

    const history: ChatTurnMessage[] = body.history.map((msg) =>
      msg[0] === 'human'
        ? { role: 'user', content: msg[1] }
        : { role: 'assistant', content: msg[1] },
    );

    const session = SessionManager.createSession();
    const agent = new APISearchAgent();

    agent.searchAsync(session, {
      chatHistory: history,
      config: {
        embedding: embeddings,
        llm: llm,
        sources: body.sources,
        mode: body.optimizationMode,
        fileIds: [],
        systemInstructions: body.systemInstructions || '',
      },
      followUp: body.query,
      chatId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
    });

    return new Promise(
      (
        resolve: (value: Response) => void,
        reject: (value: Response) => void,
      ) => {
        let message = '';
        let sources: Chunk[] = [];

        session.subscribe((event: string, data: Record<string, any>) => {
          if (event === 'data') {
            try {
              if (data.type === 'response') {
                message += data.data;
              } else if (data.type === 'searchResults') {
                sources = data.data as Chunk[];
              }
            } catch (error) {
              reject(
                Response.json(
                  { message: 'Error parsing data' },
                  { status: 500 },
                ),
              );
            }
          }

          if (event === 'end') {
            resolve(
              Response.json(
                {
                  message,
                  sources,
                  verified_downloads: collectStructuredDownloads(
                    sources,
                    parseVerifiedDownloads,
                  ),
                  interaction_required_downloads: collectStructuredDownloads(
                    sources,
                    parseInteractionRequiredDownloads,
                  ),
                },
                { status: 200 },
              ),
            );
          }

          if (event === 'error') {
            reject(
              Response.json(
                { message: 'Asset discovery error', error: data },
                { status: 500 },
              ),
            );
          }
        });
      },
    );
  } catch (err: any) {
    console.error(`Error in asset-discovery: ${err.message}`);
    return Response.json({ message: 'An error has occurred.' }, { status: 500 });
  }
};
