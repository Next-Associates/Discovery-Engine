/**
 * Phase 2c — data-page extraction (spec §5).
 *
 * A `data_page` is a page that CARRIES the data inline (tables, specs, methodology)
 * rather than offering a downloadable file. We clean + LLM-extract its facts into
 * data_pages[].extracted — it is NOT saved as a file. The LLM also gets to veto a
 * page that turns out to be navigation/marketing (is_data_page=false → skipped).
 *
 * Reads source CONTENT ONLY (anti-hallucination). One bounded LLM call per page,
 * run concurrently.
 */
import z from 'zod';
import BaseLLM from '@/lib/models/base/llm';
import { RawSource, Requirement } from './types';

const MAX_CONTENT = 8000;

const extractSchema = z.object({
  is_data_page: z
    .boolean()
    .describe('True only if this page itself contains dataset-relevant data, specifications, tables, or methodology (not just navigation/marketing).'),
  summary: z.string().describe('One or two sentence factual summary of the data this page carries.'),
  facts: z.array(z.string()).describe('Concise factual bullets extracted from the page (specs, values, methodology). Empty if none.'),
});

export type DataPage = {
  url: string;
  title: string;
  requirement_ids: string[];
  extracted: { summary: string; facts: string[] };
};

async function extractOne(
  source: RawSource,
  reqText: string,
  requirementIds: string[],
  llm: BaseLLM<any>,
): Promise<DataPage | null> {
  const content = (source.content || '').slice(0, MAX_CONTENT);
  if (!content.trim()) return null;

  let res: z.infer<typeof extractSchema>;
  try {
    res = await llm.generateObject<typeof extractSchema>({
      schema: extractSchema,
      messages: [
        {
          role: 'system',
          content: `You extract factual content from a web page. Use ONLY the provided page content. Decide if the page itself carries dataset-relevant data/specs/methodology (is_data_page). If so, summarize and list concise factual bullets. Never invent facts. Output strict JSON.`,
        },
        {
          role: 'user',
          content: `User need:\n${reqText}\n\nPage URL: ${source.url}\nPage title: ${source.title}\n\n<page_content>\n${content}\n</page_content>`,
        },
      ],
      options: { temperature: 0, maxTokens: 3000 },
    });
  } catch {
    return null;
  }

  if (!res.is_data_page) return null;
  if (!res.summary && (!res.facts || res.facts.length === 0)) return null;

  return {
    url: source.url,
    title: source.title,
    requirement_ids: requirementIds,
    extracted: { summary: res.summary || '', facts: res.facts || [] },
  };
}

export async function extractDataPages(
  sources: RawSource[],
  requirements: Requirement[],
  query: string,
  llm: BaseLLM<any>,
): Promise<DataPage[]> {
  const reqText = requirements.length
    ? requirements.map((r) => `- (${r.id}) ${r.text}`).join('\n')
    : `- ${query}`;
  const requirementIds = requirements.length ? requirements.map((r) => r.id) : ['query'];

  const results = await Promise.all(
    sources.map((s) => extractOne(s, reqText, requirementIds, llm)),
  );
  return results.filter((r): r is DataPage => r !== null);
}
