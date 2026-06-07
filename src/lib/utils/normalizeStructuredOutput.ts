import z from 'zod';

const ARRAY_ROOT_ALIASES: Record<string, string> = {
  picked_indices: 'picked_indices',
  queries: 'queries',
  urls: 'urls',
};

export function normalizeStructuredOutput(
  data: unknown,
  schema: z.ZodTypeAny,
): unknown {
  if (data === null || data === undefined) {
    return {};
  }

  if (!Array.isArray(data)) {
    return data;
  }

  if (!(schema instanceof z.ZodObject)) {
    return data;
  }

  const shape = schema.shape;

  for (const key of Object.values(ARRAY_ROOT_ALIASES)) {
    if (key in shape) {
      return { [key]: data };
    }
  }

  const keys = Object.keys(shape);
  if (keys.length === 1) {
    const key = keys[0];
    if (shape[key] instanceof z.ZodArray) {
      return { [key]: data };
    }
  }

  if (
    'extracted_facts' in shape &&
    data.every((item) => typeof item === 'string')
  ) {
    return { extracted_facts: data.map((item) => `- ${item}`).join('\n') };
  }

  return data;
}

export function normalizeToolArguments(
  toolName: string,
  params: unknown,
): Record<string, unknown> {
  if (params === null || params === undefined) {
    params = {};
  }

  if (typeof params === 'object' && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }

  if (!Array.isArray(params)) {
    return {};
  }

  switch (toolName) {
    case 'web_search':
    case 'academic_search':
    case 'social_search':
    case 'uploads_search':
      return { queries: params };
    case 'scrape_url':
      return { urls: params };
    default:
      return { value: params };
  }
}

export function formatSchemaParseError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
  }

  if (err instanceof Error) {
    // Zod 4 may JSON-stringify issues into message — prefer readable text
    if (err.message.startsWith('[') && err.message.includes('"code"')) {
      try {
        const issues = JSON.parse(err.message) as z.ZodIssue[];
        return issues
          .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
          .join('; ');
      } catch {
        // fall through
      }
    }
    return err.message;
  }

  return String(err);
}
