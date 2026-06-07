import { Chunk } from '@/lib/types';
import BaseEmbedding from '../../base/embedding';
import { FeatureExtractionPipeline } from '@huggingface/transformers';

type TransformerConfig = {
  model: string;
};

class TransformerEmbedding extends BaseEmbedding<TransformerConfig> {
  private static pipelines = new Map<
    string,
    Promise<FeatureExtractionPipeline>
  >();

  constructor(protected config: TransformerConfig) {
    super(config);
  }

  async embedText(texts: string[]): Promise<number[][]> {
    return this.embed(texts);
  }

  async embedChunks(chunks: Chunk[]): Promise<number[][]> {
    return this.embed(chunks.map((c) => c.content));
  }

  private async embed(texts: string[]) {
    const modelKey = this.config.model;
    let pipelinePromise = TransformerEmbedding.pipelines.get(modelKey);

    if (!pipelinePromise) {
      pipelinePromise = (async () => {
        const { pipeline } = await import('@huggingface/transformers');
        try {
          const result = await pipeline('feature-extraction', modelKey, {
            dtype: 'fp32',
          });
          return result as FeatureExtractionPipeline;
        } catch (err) {
          TransformerEmbedding.pipelines.delete(modelKey);
          const hint =
            ' If the model cache is corrupt, delete node_modules/@huggingface/transformers/.cache and retry.';
          throw new Error(
            `Failed to load embedding model "${modelKey}".${hint} ${err instanceof Error ? err.message : err}`,
          );
        }
      })();
      TransformerEmbedding.pipelines.set(modelKey, pipelinePromise);
    }

    const pipe = await pipelinePromise;
    const output = await pipe(texts, { pooling: 'mean', normalize: true });
    return output.tolist() as number[][];
  }
}

export default TransformerEmbedding;
