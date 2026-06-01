# Vane

Vane is a **privacy-focused AI answering engine** that runs entirely on your own hardware. It combines knowledge from the vast internet with support for **local LLMs** (Ollama) and cloud providers (OpenAI, Claude, Groq), delivering accurate answers with **cited sources** while keeping your searches completely private.

![preview](.assets/vane-screenshot.png)

For architecture and how it works, see [docs/architecture/README.md](docs/architecture/README.md).

## Features

- **Support for major AI providers** — Local LLMs through Ollama or cloud providers (OpenAI, Anthropic Claude, Google Gemini, Groq, and more).
- **Smart search modes** — Speed, Balanced, or Quality for different research depths.
- **Pick your sources** — Web, discussions, or academic papers.
- **Widgets** — Weather, calculations, stock prices, and other quick lookups when relevant.
- **Web search powered by SearxNG** — Multiple search engines with private queries.
- **Image and video search** — Visual content alongside text results.
- **File uploads** — Ask questions about PDFs, text files, images, and more.
- **Search specific domains** — Limit searches to particular sites.
- **Smart suggestions** — Query suggestions as you type.
- **Discover** — Browse articles and trending content.
- **Search history** — Saved locally so you can revisit past research.

## Installation

Docker is recommended. You can also run from source.

### Docker (recommended)

From this repository:

```bash
docker compose up -d --build
```

Open http://localhost:3000 and complete setup (API keys, models, etc.). Data is stored in the `vane-data` volume.

Or build and run manually:

```bash
docker build -t vane .
docker run -d -p 3000:3000 -v vane-data:/home/vane/data --name vane vane
```

#### Using your own SearxNG instance

Build the slim image (if your Dockerfile supports it) or set `SEARXNG_API_URL` when running:

```bash
docker run -d -p 3000:3000 \
  -e SEARXNG_API_URL=http://your-searxng-url:8080 \
  -v vane-data:/home/vane/data \
  --name vane vane
```

Your SearxNG instance should have JSON format enabled and Wolfram Alpha enabled.

### Non-Docker installation

1. Install SearXNG with JSON format enabled and Wolfram Alpha enabled.
2. Install dependencies: `npm i`
3. Build: `npm run build`
4. Start: `npm run start`
5. Open http://localhost:3000 and complete setup.

See [docs/installation/UPDATING.md](docs/installation/UPDATING.md) for upgrade steps.

### Troubleshooting

#### Local OpenAI-API-compliant servers

If no chat model providers are configured:

1. Server listens on `0.0.0.0` (not only `127.0.0.1`) on the port in your API URL.
2. Model name matches what your server exposes.
3. API key field is set (use a placeholder if the server does not require a key).

#### Ollama connection errors

1. Confirm the Ollama API URL in settings.
2. **Docker on Windows/Mac:** `http://host.docker.internal:11434`
3. **Docker on Linux:** `http://<host-private-ip>:11434`
4. On Linux, expose Ollama on the network (see [Ollama FAQ](https://github.com/ollama/ollama/blob/main/docs/faq.md#setting-environment-variables-on-linux)) and ensure port 11434 is open.

#### Lemonade connection errors

1. Confirm the Lemonade API URL in settings.
2. **Docker on Windows/Mac:** `http://host.docker.internal:8000`
3. **Docker on Linux:** `http://<host-private-ip>:8000`
4. Lemonade should listen on `0.0.0.0`, not only localhost.

## Using as a search engine

Add a browser site search with URL: `http://localhost:3000/?q=%s` (adjust host/port for your deployment).

## API

Vane exposes an API for integrations. See [docs/API/SEARCH.md](docs/API/SEARCH.md).

## Network access

Vane runs on Next.js. It is reachable on your LAN; use your firewall and reverse proxy as needed for external access.

## Upcoming features

- More widgets, integrations, and search sources
- Custom agents
- Authentication

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for project structure and where to change search behavior, models, and widgets.
