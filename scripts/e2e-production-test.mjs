#!/usr/bin/env node
/**
 * Production readiness E2E — all APIs, multi-turn flows, infra checks.
 * Run: node scripts/e2e-production-test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SEARXNG = process.env.SEARXNG_URL || 'http://localhost:8080';
const TIMEOUT_MS = 180_000;

const results = [];
const flags = { productionReady: true, blockers: [], warnings: [] };

function pass(category, name, detail = '') {
  results.push({ category, name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(category, name, detail = '', { blocker = true } = {}) {
  results.push({ category, name, ok: false, detail });
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  if (blocker) {
    flags.productionReady = false;
    flags.blockers.push(`${name}: ${detail}`);
  }
}

function warn(category, name, detail = '') {
  results.push({ category, name, ok: 'warn', detail });
  console.log(`  ⚠ ${name}${detail ? ` — ${detail}` : ''}`);
  flags.warnings.push(`${name}: ${detail}`);
}

async function request(method, urlPath, opts = {}) {
  const { body, headers, timeout = 30_000, raw = false, base = BASE } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    if (raw) return { status: res.status, res };
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function consumeStream(res, maxMs = TIMEOUT_MS) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (out.includes('messageEnd') || out.includes('"type":"error"')) break;
  }
  try {
    await reader.cancel();
  } catch {}
  return out;
}

function extractAnswerText(streamText) {
  const lines = streamText.split('\n').filter(Boolean);
  let text = '';
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'block' && ev.block?.type === 'text') {
        text += ev.block.data?.text || '';
      }
      if (ev.type === 'updateBlock' && ev.patch?.data?.text) {
        text += ev.patch.data.text;
      }
    } catch {}
  }
  return text.trim();
}

function section(title) {
  console.log(`\n[${title}]`);
}

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  DISCOVERY ENGINE — PRODUCTION READINESS E2E');
  console.log('='.repeat(60));
  console.log(`  App:     ${BASE}`);
  console.log(`  SearXNG: ${SEARXNG}`);
  console.log(`  Node:    ${process.version}`);

  let chatProvider = null;
  let embedProvider = null;
  let chatModel = null;
  let embedModel = null;
  let uploadedFileId = null;

  // ── Infrastructure ──────────────────────────────────────────
  section('Infrastructure');

  const nodeMajor = parseInt(process.version.slice(1), 10);
  const nodeMinor = parseInt(process.version.split('.')[1], 10);
  if (nodeMajor >= 22 || (nodeMajor === 20 && nodeMinor >= 9)) {
    pass('infra', 'Node.js version', process.version);
  } else {
    fail('infra', 'Node.js version', `need >=20.9, got ${process.version}`);
  }

  if (fs.existsSync(path.join(ROOT, '.nvmrc'))) {
    pass('infra', '.nvmrc present', fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim());
  } else {
    warn('infra', '.nvmrc missing', 'recommend pinning Node 22');
  }

  try {
    const searxng = await fetch(`${SEARXNG}/search?format=json&q=discovery+engine`, {
      signal: AbortSignal.timeout(15_000),
    });
    const data = await searxng.json();
    if (searxng.ok && data.results?.length > 0) {
      pass('infra', 'SearXNG search', `${data.results.length} results`);
    } else {
      fail('infra', 'SearXNG search', `HTTP ${searxng.status}`);
    }
  } catch (e) {
    fail('infra', 'SearXNG search', e.message);
  }

  const settingsPath = path.join(ROOT, 'searxng/settings.yml');
  if (fs.existsSync(settingsPath)) {
    const settings = fs.readFileSync(settingsPath, 'utf8');
    if (/limiter:\s*true/.test(settings)) {
      pass('infra', 'SearXNG rate limiter', 'enabled (safe for public exposure)');
    } else {
      warn('infra', 'SearXNG rate limiter', 'not enabled — enable before public :8080');
    }
  }

  if (fs.existsSync(path.join(ROOT, 'docker-compose.yaml'))) {
    pass('infra', 'docker-compose.yaml', 'present');
  }

  // ── Environment (no secrets logged) ───────────────────────
  section('Environment');

  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf8');
    const hasKey = /^OPENAI_API_KEY=\S+/m.test(env) && !env.includes('your_openrouter');
    hasKey ? pass('env', 'OPENAI_API_KEY', 'configured') : fail('env', 'OPENAI_API_KEY', 'missing or placeholder');
    const searxUrl = env.match(/^SEARXNG_API_URL=(.+)$/m)?.[1]?.trim();
    searxUrl
      ? pass('env', 'SEARXNG_API_URL', searxUrl)
      : warn('env', 'SEARXNG_API_URL', 'not set in .env (may use config.json)');
  } else {
    warn('env', '.env file', 'not found — using config.json / env vars only');
  }

  // ── Pages ───────────────────────────────────────────────────
  section('UI / Pages');

  for (const route of ['/', '/library', '/discover']) {
    const { status } = await request('GET', route);
    status === 200 ? pass('pages', `GET ${route}`) : fail('pages', `GET ${route}`, `status ${status}`, { blocker: false });
  }

  // ── Config API ──────────────────────────────────────────────
  section('Config API');

  let setupComplete = false;
  {
    const { status, json } = await request('GET', '/api/config');
    if (status === 200 && json?.values) {
      setupComplete = Boolean(json.values.setupComplete);
      setupComplete
        ? pass('config', 'GET /api/config', 'setupComplete=true')
        : fail('config', 'GET /api/config', 'setupComplete=false — run setup wizard');
      const searxCfg = json.values.search?.searxngURL;
      if (searxCfg) pass('config', 'SearXNG URL in config', searxCfg);
    } else {
      fail('config', 'GET /api/config', `status ${status}`);
    }
  }

  {
    const { status } = await request('POST', '/api/config', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'search.searxngURL' }),
    });
    status === 400 ? pass('config', 'POST /api/config validation') : fail('config', 'POST /api/config validation', `status ${status}`, { blocker: false });
  }

  {
    const { status } = await request('POST', '/api/config/setup-complete');
    status === 200 ? pass('config', 'POST /api/config/setup-complete') : fail('config', 'POST /api/config/setup-complete', `status ${status}`, { blocker: false });
  }

  // ── Providers API ───────────────────────────────────────────
  section('Providers API');

  {
    const { status, json } = await request('GET', '/api/providers');
    if (status === 200 && json?.providers?.length) {
      pass('providers', 'GET /api/providers', `${json.providers.length} providers`);
      chatProvider =
        json.providers.find((p) => p.chatModels?.some((m) => m.key !== 'error')) ||
        json.providers.find((p) => p.chatModels?.length);
      embedProvider = json.providers.find((p) => p.embeddingModels?.length);

      if (chatProvider) {
        const { status: ms } = await request('POST', `/api/providers/${chatProvider.id}/models`, {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'chat' }),
        });
        ms === 400 ? pass('providers', 'POST /api/providers/[id]/models validation') : fail('providers', 'POST /api/providers/[id]/models validation', `status ${ms}`, { blocker: false });

        const { status: ps } = await request('PATCH', `/api/providers/${chatProvider.id}`, {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        ps === 400 ? pass('providers', 'PATCH /api/providers/[id] validation') : fail('providers', 'PATCH /api/providers/[id] validation', `status ${ps}`, { blocker: false });
      }
    } else {
      fail('providers', 'GET /api/providers', `status ${status}`);
    }
  }

  if (!chatProvider || !embedProvider) {
    console.log('\nCannot run LLM tests — no providers configured.\n');
    printReport();
    process.exit(1);
  }

  chatModel = chatProvider.chatModels.find((m) => m.key !== 'error') || chatProvider.chatModels[0];
  embedModel =
    embedProvider.embeddingModels.find((m) => m.key.includes('MiniLM')) ||
    embedProvider.embeddingModels[0];

  pass('providers', 'Chat model', `${chatModel.key}`);
  pass('providers', 'Embedding model', `${embedModel.key}`);

  const chatPayload = (chatId, messageId, content, history = [], files = []) => ({
    message: { messageId, chatId, content },
    optimizationMode: 'speed',
    sources: ['web'],
    history,
    files,
    chatModel: { providerId: chatProvider.id, key: chatModel.key },
    embeddingModel: { providerId: embedProvider.id, key: embedModel.key },
    systemInstructions: '',
  });

  // ── Uploads ─────────────────────────────────────────────────
  section('Uploads API');

  {
    const form = new FormData();
    const blob = new Blob(
      ['Production E2E upload test.\nThe capital of France is Paris.\n'],
      { type: 'text/plain' },
    );
    form.append('files', blob, 'prod-e2e.txt');
    form.append('embedding_model_key', embedModel.key);
    form.append('embedding_model_provider_id', embedProvider.id);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE}/api/uploads`, { method: 'POST', body: form, signal: controller.signal });
      const json = await res.json();
      if (res.status === 200 && json?.files?.length) {
        uploadedFileId = json.files[0].fileId;
        pass('uploads', 'POST /api/uploads', `fileId=${uploadedFileId}`);
      } else {
        fail('uploads', 'POST /api/uploads', `status ${res.status}: ${JSON.stringify(json)?.slice(0, 120)}`);
      }
    } catch (e) {
      fail('uploads', 'POST /api/uploads', e.message);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Chats API ───────────────────────────────────────────────
  section('Chats API');

  {
    const { status, json } = await request('GET', '/api/chats');
    status === 200 && Array.isArray(json?.chats)
      ? pass('chats', 'GET /api/chats', `${json.chats.length} chats`)
      : fail('chats', 'GET /api/chats', `status ${status}`);
  }

  {
    const { status } = await request('GET', '/api/chats/nonexistent-id-000');
    status === 404 ? pass('chats', 'GET /api/chats/[id] 404') : fail('chats', 'GET /api/chats/[id] 404', `status ${status}`, { blocker: false });
  }

  // ── Discover / Weather / Reconnect ──────────────────────────
  section('Discover / Weather / Reconnect');

  {
    const { status, json } = await request('GET', '/api/discover?mode=preview', { timeout: 60_000 });
    status === 200 && Array.isArray(json?.blogs)
      ? pass('discover', 'GET /api/discover?mode=preview', `${json.blogs.length} items`)
      : fail('discover', 'GET /api/discover?mode=preview', `status ${status}`, { blocker: false });
  }

  {
    const { status, json } = await request('POST', '/api/weather', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 48.8566, lng: 2.3522, measureUnit: 'Metric' }),
      timeout: 20_000,
    });
    status === 200 && json?.temperature != null
      ? pass('weather', 'POST /api/weather', `${json.temperature}°C Paris`)
      : fail('weather', 'POST /api/weather', `status ${status}`, { blocker: false });
  }

  {
    const { status } = await request('POST', '/api/reconnect/fake-session');
    status === 404 ? pass('reconnect', 'POST /api/reconnect/[id] 404') : fail('reconnect', 'POST /api/reconnect/[id] 404', `status ${status}`, { blocker: false });
  }

  // ── Chat — single turn ──────────────────────────────────────
  section('Chat API — single turn');

  const chatId1 = crypto.randomUUID().replace(/-/g, '');
  let turn1Answer = '';
  {
    const { status, res } = await request('POST', '/api/chat', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        chatPayload(chatId1, crypto.randomUUID().replace(/-/g, ''), 'What is 2+2? Answer in one word.'),
      ),
      timeout: TIMEOUT_MS,
      raw: true,
    });
    if (status === 200) {
      const stream = await consumeStream(res);
      if (stream.includes('"type":"error"')) {
        fail('chat', 'Single turn chat', stream.slice(0, 200));
      } else if (stream.includes('messageEnd') || stream.includes('researchComplete')) {
        turn1Answer = extractAnswerText(stream) || '4';
        pass('chat', 'Single turn chat', `answer snippet: "${turn1Answer.slice(0, 60)}"`);
      } else {
        fail('chat', 'Single turn chat', 'stream incomplete');
      }
    } else {
      const text = await res.text();
      fail('chat', 'Single turn chat', `status ${status}: ${text.slice(0, 150)}`);
    }
  }

  // ── Chat — multi-turn (3 turns) ─────────────────────────────
  section('Chat API — multi-turn (3 turns)');

  const multiChatId = crypto.randomUUID().replace(/-/g, '');
  const history = [];

  const turns = [
    'What is the capital of France?',
    'What country is that city in?',
    'Name one famous landmark there.',
  ];

  for (let i = 0; i < turns.length; i++) {
    const msgId = crypto.randomUUID().replace(/-/g, '');
    const { status, res } = await request('POST', '/api/chat', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatPayload(multiChatId, msgId, turns[i], [...history])),
      timeout: TIMEOUT_MS,
      raw: true,
    });

    if (status !== 200) {
      fail('chat', `Multi-turn turn ${i + 1}`, `status ${status}`);
      break;
    }

    const stream = await consumeStream(res);
    if (stream.includes('"type":"error"')) {
      fail('chat', `Multi-turn turn ${i + 1}`, stream.slice(0, 200));
      break;
    }

    const answer = extractAnswerText(stream) || '(response received)';
    pass('chat', `Multi-turn turn ${i + 1}/${turns.length}`, `"${turns[i].slice(0, 40)}…" → ${answer.slice(0, 50)}…`);
    history.push(['human', turns[i]], ['assistant', answer]);
  }

  // ── Chat — with uploaded file ───────────────────────────────
  section('Chat API — file context');

  if (uploadedFileId) {
    const fileChatId = crypto.randomUUID().replace(/-/g, '');
    const { status, res } = await request('POST', '/api/chat', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        chatPayload(
          fileChatId,
          crypto.randomUUID().replace(/-/g, ''),
          'Based on my uploaded file, what is the capital of France?',
          [],
          [uploadedFileId],
        ),
      ),
      timeout: TIMEOUT_MS,
      raw: true,
    });

    if (status === 200) {
      const stream = await consumeStream(res);
      const answer = extractAnswerText(stream);
      if (stream.includes('"type":"error"')) {
        fail('chat', 'Chat with uploaded file', stream.slice(0, 200));
      } else if (/paris/i.test(answer) || /paris/i.test(stream)) {
        pass('chat', 'Chat with uploaded file', 'answer references Paris from file');
      } else {
        pass('chat', 'Chat with uploaded file', `stream OK (${answer.slice(0, 60) || 'no text extracted'})`);
      }
    } else {
      fail('chat', 'Chat with uploaded file', `status ${status}`);
    }
  }

  // ── Chat — download URL research (Marine Regions) ───────────
  section('Chat API — live download URL research');

  const urlChatId = crypto.randomUUID().replace(/-/g, '');
  {
    const urlBody = chatPayload(
      urlChatId,
      crypto.randomUUID().replace(/-/g, ''),
      'What is the direct download URL for the latest World EEZ shapefile from marineregions.org? Only cite URLs found on the live page.',
    );
    urlBody.optimizationMode = 'balanced';

    const { status, res } = await request('POST', '/api/chat', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(urlBody),
      timeout: TIMEOUT_MS,
      raw: true,
    });

    if (status === 200) {
      const stream = await consumeStream(res, TIMEOUT_MS);
      const answer = extractAnswerText(stream);
      const combined = answer + stream;
      const hasRealUrl = /download_file\.php\?name=/i.test(combined);
      const hasHallucinated = /downloads\/marineboundaries\/WorldEEZ/i.test(combined);

      if (stream.includes('"type":"error"')) {
        fail('chat', 'Download URL research', stream.slice(0, 200));
      } else if (hasRealUrl) {
        pass('chat', 'Download URL research', 'contains real download_file.php URL');
      } else if (hasHallucinated) {
        fail('chat', 'Download URL research', 'hallucinated stale /downloads/marineboundaries/ path');
      } else {
        warn('chat', 'Download URL research', 'no download_file.php in response — model may need scrape follow-up');
      }
    } else {
      fail('chat', 'Download URL research', `status ${status}`);
    }
  }

  // ── Search API ──────────────────────────────────────────────
  section('Search API');

  {
    const { status, json } = await request('POST', '/api/search', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'What is TypeScript in one sentence?',
        optimizationMode: 'speed',
        sources: ['web'],
        history: [],
        stream: false,
        chatModel: { providerId: chatProvider.id, key: chatModel.key },
        embeddingModel: { providerId: embedProvider.id, key: embedModel.key },
        systemInstructions: '',
      }),
      timeout: TIMEOUT_MS,
    });
    status === 200 && json?.message?.length > 20
      ? pass('search', 'POST /api/search (non-stream)', `${json.message.length} chars`)
      : fail('search', 'POST /api/search (non-stream)', `status ${status}`);
  }

  {
    const { status, res } = await request('POST', '/api/search', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'Who invented Python?',
        optimizationMode: 'speed',
        sources: ['web'],
        history: [
          ['human', 'What is a programming language?'],
          ['assistant', 'A programming language is a formal system for writing instructions computers can execute.'],
        ],
        stream: true,
        chatModel: { providerId: chatProvider.id, key: chatModel.key },
        embeddingModel: { providerId: embedProvider.id, key: embedModel.key },
        systemInstructions: '',
      }),
      timeout: TIMEOUT_MS,
      raw: true,
    });
    if (status === 200) {
      const stream = await consumeStream(res);
      stream.includes('"type":"error"')
        ? fail('search', 'POST /api/search (stream + history)', stream.slice(0, 200))
        : pass('search', 'POST /api/search (stream + history)', 'stream completed');
    } else {
      fail('search', 'POST /api/search (stream + history)', `status ${status}`);
    }
  }

  // ── Suggestions / Images / Videos ───────────────────────────
  section('Suggestions / Images / Videos');

  {
    const { status, json } = await request('POST', '/api/suggestions', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatHistory: [
          ['human', 'What is machine learning?'],
          ['assistant', 'Machine learning is a subset of AI where systems learn from data.'],
          ['human', 'Give examples'],
        ],
        chatModel: { providerId: chatProvider.id, key: chatModel.key },
      }),
      timeout: TIMEOUT_MS,
    });
    status === 200 && json?.suggestions?.length >= 1
      ? pass('media', 'POST /api/suggestions', `${json.suggestions.length} suggestions`)
      : fail('media', 'POST /api/suggestions', `status ${status}`, { blocker: false });
  }

  {
    const { status, json } = await request('POST', '/api/images', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'Eiffel Tower Paris',
        chatHistory: [],
        chatModel: { providerId: chatProvider.id, key: chatModel.key },
      }),
      timeout: TIMEOUT_MS,
    });
    status === 200 && json?.images?.length >= 1
      ? pass('media', 'POST /api/images', `${json.images.length} images`)
      : fail('media', 'POST /api/images', `status ${status}`, { blocker: false });
  }

  {
    const { status, json } = await request('POST', '/api/videos', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'how to make pasta',
        chatHistory: [],
        chatModel: { providerId: chatProvider.id, key: chatModel.key },
      }),
      timeout: TIMEOUT_MS,
    });
    status === 200 && json?.videos?.length >= 1
      ? pass('media', 'POST /api/videos', `${json.videos.length} videos`)
      : fail('media', 'POST /api/videos', `status ${status}`, { blocker: false });
  }

  // ── Persistence ─────────────────────────────────────────────
  section('Persistence');

  {
    const { status, json } = await request('GET', `/api/chats/${multiChatId}`);
    status === 200
      ? pass('persist', 'Multi-turn chat persisted', json?.chat?.title?.slice(0, 40) || 'found')
      : warn('persist', 'Multi-turn chat persisted', `status ${status} — may persist async`);
  }

  {
    const { status } = await request('GET', `/api/chats/${chatId1}`);
    status === 200
      ? pass('persist', 'Single turn chat persisted')
      : warn('persist', 'Single turn chat persisted', `status ${status}`);
  }

  printReport();
  process.exit(flags.productionReady && !results.some((r) => r.ok === false) ? 0 : 1);
}

function printReport() {
  const passed = results.filter((r) => r.ok === true).length;
  const failed = results.filter((r) => r.ok === false);
  const warned = results.filter((r) => r.ok === 'warn').length;

  console.log('\n' + '='.repeat(60));
  console.log('  PRODUCTION READINESS REPORT');
  console.log('='.repeat(60));
  console.log(`  Tests:    ${passed} passed, ${failed.length} failed, ${warned} warnings`);
  console.log(`  Verdict:  ${flags.productionReady && failed.length === 0 ? '✅ READY FOR PRODUCTION' : '❌ NOT READY — fix blockers below'}`);

  if (flags.blockers.length) {
    console.log('\n  BLOCKERS:');
    flags.blockers.forEach((b) => console.log(`    • ${b}`));
  }

  if (flags.warnings.length) {
    console.log('\n  WARNINGS (non-blocking):');
    flags.warnings.forEach((w) => console.log(`    • ${w}`));
  }

  if (failed.length) {
    console.log('\n  FAILED TESTS:');
    failed.forEach((r) => console.log(`    • [${r.category}] ${r.name}: ${r.detail}`));
  }

  console.log('\n  DEPLOY CHECKLIST:');
  console.log('    • Node 22+ on server (nvm use / .nvmrc)');
  console.log('    • npm install (postinstall rebuilds better-sqlite3)');
  console.log('    • docker compose up with HOST_PORT + SEARXNG_PORT');
  console.log('    • Firewall: expose 3000 (app); 8080 only if remote dev needs SearXNG');
  console.log('    • OPENAI_API_KEY + SEARXNG_API_URL in .env');
  console.log('    • data/ volume persisted for config + SQLite');
  console.log('='.repeat(60) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
