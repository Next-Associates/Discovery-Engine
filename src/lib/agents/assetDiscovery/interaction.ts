/**
 * Phase 2c — interaction detection (D7) + multi-format option capture (D8).
 *
 * For a gated asset URL that returns a 2xx HTML page, GET it, parse the <form>, and
 * emit an interaction{} spec the OCTO downloader can fill from a config identity:
 *   - field `kind` maps inputs to identity slots (name/email/org/country) + the
 *     agreement checkbox, so OCTO knows WHAT to fill.
 *   - honeypot_fields lists off-screen/hidden inputs that MUST be left empty.
 *   - a format <select> (name ~ format/filetype) is captured as multi_format (D8) so
 *     the downloader can iterate one download per format.
 *
 * The honeypot name can be per-page-load (e.g. firstname-<hash>), so this spec is a
 * HINT — OCTO may re-parse the live form at download time (spec §6.2).
 */
import { JSDOM } from 'jsdom';
import { warmPageSession } from '@/lib/utils/verifyUrls';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15_000;

export type InteractionFieldKind =
  | 'identity_name'
  | 'identity_email'
  | 'identity_org'
  | 'identity_country'
  | 'agreement_checkbox'
  | 'format_select'
  | 'hidden'
  | 'other';

export type InteractionField = {
  name: string;
  kind: InteractionFieldKind;
  required?: boolean;
  value?: string;
  options?: string[];
};

export type InteractionSpec = {
  type: 'form_post' | 'js' | 'unknown';
  action: string;
  method: string;
  fields: InteractionField[];
  honeypot_fields: string[];
  multi_format?: { field: string; options: string[] };
};

function isHoneypot(el: Element): boolean {
  const name = (el.getAttribute('name') || '').toLowerCase();
  const style = (el.getAttribute('style') || '').toLowerCase().replace(/\s+/g, '');
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'hidden') return false; // legit hidden fields are not honeypots
  // Off-screen positioning (left:-99999px) or display:none/visibility:hidden.
  if (/position:absolute/.test(style) && /left:-\d/.test(style)) return true;
  if (/display:none/.test(style) || /visibility:hidden/.test(style)) return true;
  // Common honeypot field names that mirror a real field.
  if (/^(firstname|lastname|fname|lname|url|website|homepage|honeypot)\b/.test(name)) {
    return true;
  }
  return false;
}

function classifyField(el: Element): InteractionFieldKind {
  const name = (el.getAttribute('name') || '').toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const tag = el.tagName.toLowerCase();

  if (type === 'email' || /e-?mail/.test(name)) return 'identity_email';
  if (type === 'checkbox' && /agree|accept|terms|consent|licen[sc]e/.test(name)) {
    return 'agreement_checkbox';
  }
  if (/organi[sz]ation|organi[sz]ation|company|affiliation|institut/.test(name)) {
    return 'identity_org';
  }
  if (/country|nation/.test(name)) return 'identity_country';
  if (tag === 'select' && /format|filetype|file_type|extension|ext|type/.test(name)) {
    return 'format_select';
  }
  if (/(^|_|-)name($|_|-)|fullname|yourname|\bname\b/.test(name)) return 'identity_name';
  if (type === 'hidden') return 'hidden';
  return 'other';
}

function selectOptions(el: Element): string[] {
  return [...el.querySelectorAll('option')]
    .map((o) => o.getAttribute('value') ?? o.getAttribute('name') ?? o.textContent ?? '')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pick the most form-like <form> (one with a submit or recognizable inputs). */
function pickForm(doc: Document): HTMLFormElement | null {
  const forms = [...doc.querySelectorAll('form')] as HTMLFormElement[];
  if (forms.length === 0) return null;
  const score = (f: HTMLFormElement) => {
    let s = 0;
    if (f.querySelector('input[type="submit"], button[type="submit"], button')) s += 2;
    if (f.querySelector('input[type="email"]')) s += 2;
    if (f.querySelector('input[type="checkbox"]')) s += 1;
    s += f.querySelectorAll('input,select,textarea').length > 0 ? 1 : 0;
    return s;
  };
  return forms.sort((a, b) => score(b) - score(a))[0];
}

async function fetchGated(url: string, referer?: string): Promise<string | null> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (referer) {
    headers.Referer = referer;
    const cookie = await warmPageSession(referer);
    if (cookie) headers.Cookie = cookie;
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers,
    });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/html')) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Build an interaction template by parsing ONE representative gated URL. The caller
 * clones it per asset with action = the asset's own URL.
 */
export async function detectInteractionTemplate(
  sampleUrl: string,
  referer?: string,
): Promise<InteractionSpec | null> {
  const html = await fetchGated(sampleUrl, referer);
  if (!html) return { type: 'unknown', action: sampleUrl, method: 'get', fields: [], honeypot_fields: [] };

  const dom = new JSDOM(html, { url: sampleUrl });
  const doc = dom.window.document;
  const form = pickForm(doc);
  if (!form) {
    return { type: 'unknown', action: sampleUrl, method: 'get', fields: [], honeypot_fields: [] };
  }

  const method = (form.getAttribute('method') || 'get').toLowerCase();
  const actionAttr = form.getAttribute('action');
  // Empty action => posts back to the form's own URL.
  let action = sampleUrl;
  if (actionAttr) {
    try {
      action = new URL(actionAttr, sampleUrl).href;
    } catch {
      /* keep sampleUrl */
    }
  }

  const fields: InteractionField[] = [];
  const honeypot_fields: string[] = [];
  let multi_format: InteractionSpec['multi_format'];

  const controls = [...form.querySelectorAll('input,select,textarea')];
  for (const el of controls) {
    const name = el.getAttribute('name');
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (!name) continue;
    if (type === 'submit' || type === 'button' || type === 'reset') continue;

    if (isHoneypot(el)) {
      honeypot_fields.push(name);
      continue;
    }

    const kind = classifyField(el);
    const field: InteractionField = { name, kind };
    if (el.hasAttribute('required')) field.required = true;
    if (type === 'checkbox') field.value = el.getAttribute('value') ?? '1';
    if (el.tagName.toLowerCase() === 'select') {
      const opts = selectOptions(el);
      field.options = opts;
      if (kind === 'format_select' && opts.length > 0) {
        multi_format = { field: name, options: opts };
      }
    }
    fields.push(field);
  }

  return {
    type: method === 'post' ? 'form_post' : 'unknown',
    action,
    method,
    fields,
    honeypot_fields,
    ...(multi_format ? { multi_format } : {}),
  };
}

/**
 * Annotate gated assets with an interaction{} spec. Parses one representative URL per
 * origin (forms are structurally identical), then clones per asset with action=url.
 */
export async function attachInteractions(
  datasets: Array<{ assets?: any[]; source_page?: string }>,
): Promise<number> {
  // Collect one representative gated asset per origin.
  const repByOrigin = new Map<string, { url: string; referer?: string }>();
  for (const ds of datasets) {
    for (const a of ds.assets ?? []) {
      if (a.verification_status !== 'requires_interaction') continue;
      let origin = '';
      try {
        origin = new URL(a.url).origin;
      } catch {
        origin = a.url;
      }
      if (!repByOrigin.has(origin)) {
        repByOrigin.set(origin, { url: a.url, referer: a.source_page || ds.source_page });
      }
    }
  }

  const templateByOrigin = new Map<string, InteractionSpec | null>();
  await Promise.all(
    [...repByOrigin.entries()].map(async ([origin, rep]) => {
      templateByOrigin.set(origin, await detectInteractionTemplate(rep.url, rep.referer));
    }),
  );

  let annotated = 0;
  for (const ds of datasets) {
    for (const a of ds.assets ?? []) {
      if (a.verification_status !== 'requires_interaction') continue;
      let origin = '';
      try {
        origin = new URL(a.url).origin;
      } catch {
        origin = a.url;
      }
      const template = templateByOrigin.get(origin);
      if (!template) continue;
      a.interaction = { ...template, action: a.url };
      annotated++;
    }
  }
  return annotated;
}
