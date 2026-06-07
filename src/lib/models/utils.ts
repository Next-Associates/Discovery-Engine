import { Model } from './types';

export function dedupeModelsByKey(models: Model[]): Model[] {
  const seen = new Set<string>();
  const result: Model[] = [];

  for (const model of models) {
    if (seen.has(model.key)) continue;
    seen.add(model.key);
    result.push(model);
  }

  return result;
}

export function mergeModelsByKey(...lists: Model[][]): Model[] {
  return dedupeModelsByKey(lists.flat());
}
