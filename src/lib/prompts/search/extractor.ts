import { ASSET_EXTRACTOR_RULES } from '@/lib/utils/assetPipeline';

export const getExtractorPrompt = (basePrompt: string) =>
  basePrompt.replace('## Output format', `${ASSET_EXTRACTOR_RULES}\n\n      ## Output format`);
