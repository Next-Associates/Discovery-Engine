# Discovery Engine — Search API Endpoint Reference

**Server (live):** `http://31.97.33.98:3000`
**Recommended endpoint for OCTO01 integration:** `POST /api/search`
**Last verified:** 2026-06-07 (tested end-to-end, working)

---

## 1. There are TWO endpoints — use the right one

| | `/api/chat` | `/api/search` ✅ |
|---|---|---|
| Purpose | Powers the **web UI** | **Programmatic API** (built for integrations like OCTO01) |
| Output | NDJSON stream of UI "blocks" (`block`, `updateBlock`, `messageEnd`) — hard to parse | Clean JSON `{ message, sources }` when `stream:false` |
| Persists to DB | Yes (creates chat rows) | No (ephemeral `chatId`) |
| Required fields | `messageId`, `chatId`, `content`, models | `query`, `sources`, models |

**For OCTO01 → Discovery Engine, use `/api/search`.** It is designed for machine consumption.

Source files:
- `/Users/mac/NEXTECH/Discovery-Engine/src/app/api/search/route.ts`
- `/Users/mac/NEXTECH/Discovery-Engine/src/app/api/chat/route.ts`

---

## 2. `/api/search` — Request Payload

```jsonc
{
  "query": "string",                  // REQUIRED — the search/question
  "sources": ["web"],                 // REQUIRED — any of: "web" | "discussions" | "academic"
  "optimizationMode": "speed",        // "speed" | "balanced" | "quality"  (default "speed")
  "stream": false,                    // false = one JSON blob; true = NDJSON stream (default false)
  "history": [],                      // [["human","..."],["assistant","..."]]
  "systemInstructions": "",           // optional — anti-hallucination / directive rules go HERE
  "chatModel":      { "providerId": "...", "key": "..." },   // REQUIRED
  "embeddingModel": { "providerId": "...", "key": "..." }    // REQUIRED
}
```

### Field notes
- `query` and `sources` are the only hard-required body fields (validated in `route.ts`).
- `sources` valid values (from `src/lib/agents/search/types.ts`): `'web' | 'discussions' | 'academic'`.
- `optimizationMode`: `speed` | `balanced` | `quality`.
- `stream`: `false` returns a single JSON object; `true` returns newline-delimited JSON.
- `systemInstructions`: free-text directives injected into the agent — this is where source-trust ranking and "answer only from scraped content" rules belong.

---

## 3. Provider / Model IDs (pulled live from the server)

Discover any time with:
```bash
curl -s http://31.97.33.98:3000/api/providers
```

**Chat provider (OpenRouter / OpenAI-compatible):**
- `providerId = 39bb5a3a-a67e-43c4-9a9f-712bb5fe6077`
- `key` = any model, e.g.:
  - `anthropic/claude-haiku-4.5`
  - `anthropic/claude-sonnet-4.6`
  - `anthropic/claude-opus-4.8`
  - `deepseek/deepseek-chat`
  - `openrouter/auto`

**Embedding provider (Transformers, runs locally on the server):**
- `providerId = 0a7f8efe-1b33-4733-b8ed-4389f0693663`
- `key` options:
  - `Xenova/all-MiniLM-L6-v2`
  - `mixedbread-ai/mxbai-embed-large-v1`
  - `Xenova/nomic-embed-text-v1`

---

## 4. `/api/search` — Response Output

### `stream: false` → single JSON object
```jsonc
{
  "message": "## Latest World EEZ Dataset...\nversion 12, released October 25, 2023[1]...",
  "sources": [
    {
      "content": "World EEZ v12 (2023-10-25, 122 MB) - downloads: 37024 [GeoPackage] [Shapefile]...",
      "metadata": {
        "title": "Marine Regions Downloads",
        "url": "https://www.marineregions.org/downloads.php"
      }
    }
  ]
}
```

- `message` = LLM prose answer with `[n]` citations.
- `sources[]` = **the raw scraped page text + URL** → this is the **ground truth**.

### `stream: true` → newline-delimited JSON
```
{"type":"init","data":"Stream connected"}
{"type":"sources","data":[ ...source objects... ]}
{"type":"response","data":"token chunk"}
{"type":"response","data":"token chunk"}
...
{"type":"done"}
```

---

## 5. How to Test (verified working)

```bash
curl -s -X POST http://31.97.33.98:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What is the latest World EEZ dataset version on marineregions.org?",
    "sources": ["web"],
    "optimizationMode": "speed",
    "stream": false,
    "chatModel":      { "providerId": "39bb5a3a-a67e-43c4-9a9f-712bb5fe6077", "key": "anthropic/claude-haiku-4.5" },
    "embeddingModel": { "providerId": "0a7f8efe-1b33-4733-b8ed-4389f0693663", "key": "Xenova/all-MiniLM-L6-v2" }
  }'
```

### Actual result of this test
- `message` returned: *"World EEZ v12, released October 25, 2023..."*
- `sources[0].content` contained the **live-scraped** text from `marineregions.org/downloads.php`:
  ```
  World EEZ v12 (2023-10-25, 122 MB) - downloads: 37024 [GeoPackage] [Shapefile] [0 to 360 Degrees] [Low res] [KML] [Change history] [Known issues]
  World 24 Nautical Miles Zone (Contiguous Zone) v4 (2023-10-25, 46 MB) ...
  World High Seas v2 (2024-10-10, 6.85 MB) ...
  ```

---

## 6. Key Architectural Finding (staleness / hallucination)

The test returned `World EEZ v12 (2023-10-25)` — **and this time it was NOT hallucinated.**

- The `sources[].content` field is **real live-scraped content**, not LLM memory. v12 genuinely IS the current version on the live page.
- The earlier hallucination ("Inferred standard path" download URLs) came from the **`message`** field, where the LLM *embellished* beyond what was scraped.

**Takeaways for OCTO01:**
1. **Trust `sources[].content` and `sources[].metadata.url`** — this is the verified ground truth.
2. **Treat `message` as a hint only** — never extract facts or URLs from it.
3. The extraction LLM in OCTO01 should parse assets/URLs **out of `sources[]`**, never out of `message`.
4. Pass strict directives via `systemInstructions` (source-trust ranking, "report only URLs that physically appear in scraped content").

---

## 7. Quick Reference — minimal valid request

```json
{
  "query": "<your requirement>",
  "sources": ["web"],
  "chatModel":      { "providerId": "39bb5a3a-a67e-43c4-9a9f-712bb5fe6077", "key": "anthropic/claude-haiku-4.5" },
  "embeddingModel": { "providerId": "0a7f8efe-1b33-4733-b8ed-4389f0693663", "key": "Xenova/all-MiniLM-L6-v2" }
}
```
