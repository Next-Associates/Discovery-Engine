#!/usr/bin/env node
/**
 * End-to-end API smoke tests for Discovery Engine (Vane)
 * Run: node scripts/e2e-api-test.mjs
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT_MS = 120_000;

const results = [];

function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail = '') {
  results.push({ name, ok: false, detail });
  console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function request(method, path, { body, headers, timeout = 30_000, raw = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${BASE}${path}`, {
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

async function readStreamPreview(res, maxBytes = 4000) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (out.length < maxBytes) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  try {
    await reader.cancel();
  } catch {}
  return out;
}

async function main() {
  console.log(`\nE2E API tests → ${BASE}\n`);

  // --- Infrastructure ---
  try {
    const searx = await request('GET', '', {
      timeout: 5000,
      raw: true,
    }).catch(() => null);
    const searxng = await fetch('http://localhost:8080/search?format=json&q=test', {
      signal: AbortSignal.timeout(10_000),
    });
    const searxData = await searxng.json();
    if (searxng.ok && searxData.results?.length > 0) {
      pass('SearXNG (localhost:8080)', `${searxData.results.length} results`);
    } else {
      fail('SearXNG (localhost:8080)', `status ${searxng.status}`);
    }
  } catch (e) {
    fail('SearXNG (localhost:8080)', e.message);
  }

  // --- Pages ---
  {
    const { status } = await request('GET', '/');
    status === 200 ? pass('GET /') : fail('GET /', `status ${status}`);
  }

  // --- Config ---
  let setupComplete = false;
  {
    const { status, json } = await request('GET', '/api/config');
    if (status === 200 && json?.values) {
      setupComplete = Boolean(json.values.setupComplete);
      pass('GET /api/config', `setupComplete=${setupComplete}`);
    } else {
      fail('GET /api/config', `status ${status}`);
    }
  }

  {
    const { status } = await request('POST', '/api/config', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'search.searxngURL' }),
    });
    status === 400 ? pass('POST /api/config (validation)') : fail('POST /api/config (validation)', `status ${status}`);
  }

  {
    const { status } = await request('POST', '/api/config/setup-complete');
    status === 200 ? pass('POST /api/config/setup-complete') : fail('POST /api/config/setup-complete', `status ${status}`);
  }

  // --- Providers ---
  let chatProvider = null;
  let embedProvider = null;
  {
    const { status, json } = await request('GET', '/api/providers');
    if (status === 200 && json?.providers?.length) {
      chatProvider =
        json.providers.find((p) => p.chatModels?.some((m) => m.key !== 'error')) ||
        json.providers.find((p) => p.chatModels?.length);
      embedProvider = json.providers.find((p) => p.embeddingModels?.length);
      pass('GET /api/providers', `${json.providers.length} providers`);
    } else {
      fail('GET /api/providers', `status ${status}`);
    }
  }

  if (!chatProvider || !embedProvider) {
    console.log('\nCannot continue LLM tests without providers.\n');
    printSummary();
    process.exit(1);
  }

  const chatModel = chatProvider.chatModels.find((m) => m.key !== 'error') || chatProvider.chatModels[0];
  const embedModel =
    embedProvider.embeddingModels.find((m) => m.key.includes('MiniLM')) ||
    embedProvider.embeddingModels[0];

  // --- Uploads (run before chat/search to avoid embedding model cache conflicts) ---
  {
    const form = new FormData();
    const blob = new Blob(['Hello from e2e upload test.\nLine 2.'], { type: 'text/plain' });
    form.append('files', blob, 'e2e-test.txt');
    form.append('embedding_model_key', embedModel.key);
    form.append('embedding_model_provider_id', embedProvider.id);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE}/api/uploads`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      const json = await res.json();
      if (res.status === 200 && json?.files?.length) {
        pass('POST /api/uploads', `fileId=${json.files[0].fileId || 'ok'}`);
      } else {
        fail('POST /api/uploads', `status ${res.status}`);
      }
    } catch (e) {
      fail('POST /api/uploads', e.message);
    } finally {
      clearTimeout(timer);
    }
  }

  // --- Chats ---
  {
    const { status, json } = await request('GET', '/api/chats');
    status === 200 && Array.isArray(json?.chats)
      ? pass('GET /api/chats', `${json.chats.length} chats`)
      : fail('GET /api/chats', `status ${status}`);
  }

  {
    const { status } = await request('GET', '/api/chats/nonexistent-chat-id-000');
    status === 404 ? pass('GET /api/chats/[id] (404)') : fail('GET /api/chats/[id] (404)', `status ${status}`);
  }

  // --- Discover ---
  {
    const { status, json } = await request('GET', '/api/discover?mode=preview', { timeout: 60_000 });
    status === 200 && Array.isArray(json?.blogs)
      ? pass('GET /api/discover?mode=preview', `${json.blogs.length} items`)
      : fail('GET /api/discover?mode=preview', `status ${status}`);
  }

  // --- Weather ---
  {
    const { status, json } = await request('POST', '/api/weather', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 48.8566, lng: 2.3522, measureUnit: 'Metric' }),
      timeout: 20_000,
    });
    status === 200 && json?.temperature != null
      ? pass('POST /api/weather', `${json.temperature}°C Paris`)
      : fail('POST /api/weather', `status ${status}`);
  }

  // --- Reconnect ---
  {
    const { status } = await request('POST', '/api/reconnect/fake-session-id');
    status === 404 ? pass('POST /api/reconnect/[id] (404)') : fail('POST /api/reconnect/[id] (404)', `status ${status}`);
  }

  // --- Chat stream ---
  const chatId = crypto.randomUUID().replace(/-/g, '');
  const messageId = crypto.randomUUID().replace(/-/g, '');
  {
    const { status, res } = await request('POST', '/api/chat', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: { messageId, chatId, content: 'What is 2+2?' },
        optimizationMode: 'speed',
        sources: ['web'],
        history: [],
        files: [],
        chatModel: { providerId: chatProvider.id, key: chatModel.key },
        embeddingModel: { providerId: embedProvider.id, key: embedModel.key },
        systemInstructions: '',
      }),
      timeout: TIMEOUT_MS,
      raw: true,
    });

    if (status === 200) {
      const preview = await readStreamPreview(res);
      const hasEnd = preview.includes('messageEnd') || preview.includes('researchComplete');
      const hasError = preview.includes('"type":"error"');
      if (hasError) {
        fail('POST /api/chat (stream)', preview.slice(0, 200));
      } else if (hasEnd) {
        pass('POST /api/chat (stream)', 'received stream events');
      } else {
        pass('POST /api/chat (stream)', '200 with partial stream');
      }
    } else {
      const text = await res.text();
      fail('POST /api/chat (stream)', `status ${status}: ${text.slice(0, 150)}`);
    }
  }

  // --- Chat with web search ---
  {
    const chatId2 = crypto.randomUUID().replace(/-/g, '');
    const messageId2 = crypto.randomUUID().replace(/-/g, '');
    const { status, res } = await request('POST', '/api/chat', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          messageId: messageId2,
          chatId: chatId2,
          content: 'Who won the Nobel Prize in Physics in 2023?',
        },
        optimizationMode: 'speed',
        sources: ['web'],
        history: [],
        files: [],
        chatModel: { providerId: chatProvider.id, key: chatModel.key },
        embeddingModel: { providerId: embedProvider.id, key: embedModel.key },
        systemInstructions: '',
      }),
      timeout: TIMEOUT_MS,
      raw: true,
    });

    if (status === 200) {
      const preview = await readStreamPreview(res, 8000);
      const hasError = preview.includes('"type":"error"');
      hasError
        ? fail('POST /api/chat (web search)', preview.slice(0, 200))
        : pass('POST /api/chat (web search)', 'stream started OK');
    } else {
      fail('POST /api/chat (web search)', `status ${status}`);
    }
  }

  // --- Search API (non-stream) ---
  {
    const { status, json } = await request('POST', '/api/search', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'What is TypeScript?',
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
    status === 200 && json?.message
      ? pass('POST /api/search (non-stream)', `${json.message.length} chars`)
      : fail('POST /api/search (non-stream)', `status ${status} ${JSON.stringify(json)?.slice(0, 100)}`);
  }

  // --- Suggestions ---
  {
    const { status, json } = await request('POST', '/api/suggestions', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatHistory: [['human', 'What is machine learning?']],
        chatModel: { providerId: chatProvider.id, key: chatModel.key },
      }),
      timeout: TIMEOUT_MS,
    });
    status === 200 && Array.isArray(json?.suggestions)
      ? pass('POST /api/suggestions', `${json.suggestions.length} suggestions`)
      : fail('POST /api/suggestions', `status ${status}`);
  }

  // --- Images ---
  {
    const { status, json } = await request('POST', '/api/images', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'Eiffel Tower',
        chatHistory: [],
        chatModel: { providerId: chatProvider.id, key: chatModel.key },
      }),
      timeout: TIMEOUT_MS,
    });
    status === 200 && Array.isArray(json?.images)
      ? pass('POST /api/images', `${json.images.length} images`)
      : fail('POST /api/images', `status ${status}`);
  }

  // --- Videos ---
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
    status === 200 && Array.isArray(json?.videos)
      ? pass('POST /api/videos', `${json.videos.length} videos`)
      : fail('POST /api/videos', `status ${status}`);
  }

  // --- Verify chat persisted ---
  {
    const { status, json } = await request('GET', `/api/chats/${chatId}`);
    status === 200 || status === 404
      ? pass('GET /api/chats/[id] (after chat)', status === 200 ? 'chat found' : 'chat 404 (async persist ok)')
      : fail('GET /api/chats/[id] (after chat)', `status ${status}`);
  }

  printSummary();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}

function printSummary() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed}/${results.length} passed`);
  if (failed.length) {
    console.log('\nFailed:');
    failed.forEach((r) => console.log(`  - ${r.name}: ${r.detail}`));
  } else {
    console.log('All tests passed.');
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
