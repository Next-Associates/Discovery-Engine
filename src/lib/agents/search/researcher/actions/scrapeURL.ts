import z from 'zod';
import { ResearchAction } from '../../types';
import { Chunk, ReadingResearchBlock } from '@/lib/types';
import Scraper from '@/lib/scraper';
import { splitText } from '@/lib/utils/splitText';
import { getExtractorPrompt } from '@/lib/prompts/search/extractor';
import {
  formatLinksSection,
  formatSourcePagesSection,
  formatUnverifiedDownloadsNote,
  formatVerifiedLinksSection,
  type ExtractedLink,
  type VerifiedDownload,
} from '@/lib/utils/extractLinks';
import {
  isAssetLikeUrl,
  MAX_SCRAPE_URLS_PER_CALL,
  MAX_VERIFY_URLS_PER_PAGE,
  normalizeScrapeTargets,
} from '@/lib/utils/assetPipeline';
import { verifyDownloadUrls } from '@/lib/utils/verifyUrls';

const extractorPrompt = getExtractorPrompt(`
                  Assistant is an AI information extractor. Assistant will be shared with scraped information from a website along with the queries used to retrieve that information. Assistant's task is to extract relevant facts from the scraped data to answer the queries.
            
                  ## Things to taken into consideration when extracting information:
                  1. Relevance to the query: The extracted information must dynamically adjust based on the query's intent. If the query asks "What is [X]", you must extract the definition/identity. If the query asks for "[X] specs" or "features", you must provide deep, granular technical details.
                     - Example: For "What is [Product]", extract the core definition. For "[Product] capabilities", extract every technical function mentioned.
                  2. Concentrate on extracting factual information that can help in answering the question rather than opinions or commentary. Ignore marketing fluff like "best-in-class" or "seamless."
                  3. Noise to signal ratio: If the scraped data is noisy (headers, footers, UI text), ignore it and extract only the high-value information. 
                     - Example: Discard "Click for more" or "Subscribe now" messages.
                  4. Avoid using filler sentences or words; extract concise, telegram-style information.
                     - Example: Change "The device features a weight of only 1.2kg" to "Weight: 1.2kg."
                  5. Duplicate information: If a fact appears multiple times (e.g., in a paragraph and a technical table), merge the details into a single, high-density bullet point to avoid redundancy.
                  6. Numerical Data Integrity: NEVER summarize or generalize numbers, benchmarks, or table data. Extract raw values exactly as they appear.
                     - Example: Do not say "Improved coding scores." Say "LiveCodeBench v6: 80.0%."
            
                  ## Example
                  For example, if the query is "What are the health benefits of green tea?" and the scraped data contains various pieces of information about green tea, Assistant should focus on extracting factual information related to the health benefits of green tea such as "Green tea contains antioxidants which can help in reducing inflammation" and ignore irrelevant information such as "Green tea is a popular beverage worldwide".
                  
                  It can also remove filler words to reduce the sentence to "Contains antioxidants; reduces inflammation." 
                  
                  For tables/numerical data extraction, Assistant should extract the raw numerical data or the content of the table without trying to summarize it to avoid losing important details. For example, if a table lists specific battery life hours for different modes, Assistant should list every mode and its corresponding hour count rather than giving a general average.
                  
                  Make sure the extracted facts are in bullet points format to make it easier to read and understand.
            
                  ## Output format
                  Assistant should reply with a JSON object containing a key "extracted_facts" which is a string of the bulleted facts. Return only raw JSON without markdown formatting (no \`\`\`json blocks).
            
                  <example_output>
                  {
                    "extracted_facts": "- Fact 1\n- Fact 2\n- Fact 3"
                  }
                  </example_output>
                  `);

const extractorSchema = z.object({
  extracted_facts: z
    .string()
    .describe(
      'The extracted facts that are relevant to the query and can help in answering the question should be listed here in a concise manner.',
    ),
});

const schema = z.object({
  urls: z.array(z.string()).describe('A list of URLs to scrape content from.'),
});

const actionDescription = `
Use this tool to scrape live content from specific web pages. REQUIRED whenever the user needs **assets**, **download links**, **datasets**, **files**, **direct URLs**, **releases**, **official/trusted sources**, or **portal item pages** — for any topic or website.

Pipeline: search finds candidate pages → this tool scrapes them live → links are extracted and HTTP-verified → the writer cites only those URLs.

Also use when:
- The user names a URL or domain and needs current links from that site
- Search snippets may be outdated (common for downloads and documentation)
- A data portal item page (ArcGIS, GitHub releases, Hugging Face, Zenodo, etc.) needs live resolution

Web search alone is not sufficient for asset/URL questions. Scrape the publisher's downloads, docs, releases, or item page — not only the homepage.

Up to 3 URLs per call. Prefer official catalog pages over guessed direct file paths.
`;

const scrapeURLAction: ResearchAction<typeof schema> = {
  name: 'scrape_url',
  schema: schema,
  getToolDescription: () =>
    `Scrape live pages to extract and verify asset/download URLs (up to ${MAX_SCRAPE_URLS_PER_CALL} URLs per call). Use when the user needs files, datasets, direct links, releases, or official sources.`,
  getDescription: () => actionDescription,
  enabled: (_) => true,
  execute: async (params, additionalConfig) => {
    const expandedUrls = [
      ...new Set(params.urls.flatMap((url) => normalizeScrapeTargets(url))),
    ].slice(0, MAX_SCRAPE_URLS_PER_CALL);
    const query = additionalConfig.followUp;

    let readingBlockId = crypto.randomUUID();
    let readingEmitted = false;

    const researchBlock = additionalConfig.session.getBlock(
      additionalConfig.researchBlockId,
    );

    const results: Chunk[] = [];

    await Promise.all(
      expandedUrls.map(async (url) => {
        try {
          const scraped = await Scraper.scrape(url);

          if (
            !readingEmitted &&
            researchBlock &&
            researchBlock.type === 'research'
          ) {
            readingEmitted = true;
            researchBlock.data.subSteps.push({
              id: readingBlockId,
              type: 'reading',
              reading: [
                {
                  content: '',
                  metadata: {
                    url,
                    title: scraped.title,
                  },
                },
              ],
            });

            additionalConfig.session.updateBlock(
              additionalConfig.researchBlockId,
              [
                {
                  op: 'replace',
                  path: '/data/subSteps',
                  value: researchBlock.data.subSteps,
                },
              ],
            );
          } else if (
            readingEmitted &&
            researchBlock &&
            researchBlock.type === 'research'
          ) {
            const subStepIndex = researchBlock.data.subSteps.findIndex(
              (step: any) => step.id === readingBlockId,
            );

            const subStep = researchBlock.data.subSteps[
              subStepIndex
            ] as ReadingResearchBlock;

            subStep.reading.push({
              content: '',
              metadata: {
                url,
                title: scraped.title,
              },
            });

            additionalConfig.session.updateBlock(
              additionalConfig.researchBlockId,
              [
                {
                  op: 'replace',
                  path: '/data/subSteps',
                  value: researchBlock.data.subSteps,
                },
              ],
            );
          }

          const chunks = splitText(scraped.content, 4000, 500);

          let accumulatedContent = '';

          if (chunks.length > 1) {
            try {
              await Promise.all(
                chunks.map(async (chunk) => {
                  const extracted = await additionalConfig.llm.generateObject<
                    typeof extractorSchema
                  >({
                    messages: [
                      {
                        role: 'system',
                        content: extractorPrompt,
                      },
                      {
                        role: 'user',
                        content: `<queries>${query}</queries>\n<scraped_data>${chunk}</scraped_data>`,
                      },
                    ],
                    schema: extractorSchema,
                  });

                  accumulatedContent += extracted.extracted_facts + '\n';
                }),
              );
            } catch (err) {
              console.log(
                'Error during extraction, falling back to raw content',
                err,
              );
              accumulatedContent = chunks[0];
            }
          } else {
            accumulatedContent = scraped.content;
          }

          const extractedLinks: ExtractedLink[] = scraped.extractedLinks ?? [];

          const downloadCandidates = extractedLinks
            .filter((link) => isAssetLikeUrl(link.url))
            .slice(0, MAX_VERIFY_URLS_PER_PAGE);

          // Navigation/catalog links only — asset URLs go through verification below
          const catalogLinks = extractedLinks.filter(
            (link) => !isAssetLikeUrl(link.url),
          );
          const catalogLinksSection = formatLinksSection(catalogLinks);
          if (catalogLinksSection) {
            accumulatedContent += `\n\n${catalogLinksSection}`;
          } else if (scraped.links && downloadCandidates.length === 0) {
            accumulatedContent += `\n\n${scraped.links}`;
          }

          const sourceSection = formatSourcePagesSection([
            { url, title: scraped.title },
          ]);

          if (downloadCandidates.length > 0) {
            const verifications = await verifyDownloadUrls(
              downloadCandidates.map((l) => ({
                url: l.url,
                sourceHref: l.sourceHref,
              })),
              MAX_VERIFY_URLS_PER_PAGE,
              { referer: url },
            );

            const verifiedDownloads: VerifiedDownload[] = [];
            downloadCandidates.forEach((link, i) => {
              const v = verifications[i];
              if (v?.ok && v.verifiedUrl) {
                verifiedDownloads.push({
                  label: link.label,
                  url: v.verifiedUrl,
                  status: v.status,
                });
              }
            });

            const verifiedSection =
              formatVerifiedLinksSection(verifiedDownloads);

            if (verifiedSection) {
              accumulatedContent += `\n\n${verifiedSection}`;
            } else {
              accumulatedContent += `\n\n${formatUnverifiedDownloadsNote()}`;
            }
          }

          if (sourceSection) {
            accumulatedContent += `\n\n${sourceSection}`;
          }

          results.push({
            content: accumulatedContent,
            metadata: {
              url,
              title: scraped.title,
            },
          });
        } catch (error) {
          const sourceSection = formatSourcePagesSection([{ url }]);
          results.push({
            content: [
              `Failed to fetch content from ${url}: ${error}`,
              formatUnverifiedDownloadsNote(),
              sourceSection,
            ]
              .filter(Boolean)
              .join('\n\n'),
            metadata: {
              url,
              title: `Error scraping ${url}`,
            },
          });
        }
      }),
    );

    return {
      type: 'search_results',
      results,
    };
  },
};

export default scrapeURLAction;
