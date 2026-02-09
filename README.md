# Swagger API MCP Server

[![License](https://img.shields.io/github/license/NekoTarou/swagger-api-mcp-server.svg)](https://github.com/NekoTarou/swagger-api-mcp-server/blob/main/LICENSE)
[![Build & Test](https://github.com/NekoTarou/swagger-api-mcp-server/actions/workflows/publish.yml/badge.svg)](https://github.com/NekoTarou/swagger-api-mcp-server/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/swagger-api-mcp-server.svg)](https://www.npmjs.com/package/swagger-api-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/swagger-api-mcp-server.svg)](https://www.npmjs.com/package/swagger-api-mcp-server)
[![Node.js Version](https://img.shields.io/node/v/swagger-api-mcp-server.svg)](https://nodejs.org)

[English](./README.md) | [中文](./README_zh.md)

An MCP (Model Context Protocol) server that parses **Swagger 2.0** and **OpenAPI 3.x** specifications, exposing API structure through MCP tools. Features a local file-cache architecture that reduces token usage by 85-95% compared to inline responses.

## Features

- **Swagger 2.0 & OpenAPI 3.x** — Full dual-format support
- **Smart Caching** — Spec parsed once, stored as local JSON files; tools return compact summaries + file paths (~200 chars vs 5-20KB)
- **10 MCP Tools** — Load, browse, search, and call APIs directly
- **Two Transport Modes** — stdio (for CLI/IDE integration) and HTTP (for multi-session web use)
- **2-Phase API Calls** — Preview requests before executing them
- **Zero External Parsers** — Custom `$ref` resolver with circular reference protection

## Prerequisites

- **Node.js >= 24**

## Quick Start

### Install from npm

```bash
npm install -g swagger-api-mcp-server
```

### Or clone and build

```bash
git clone https://github.com/NekoTarou/swagger-api-mcp-server.git
cd swagger-api-mcp-server
npm install
npm run build
```

### Run

```bash
# stdio mode (default) — for MCP clients like Claude Desktop
npm start

# Auto-load a spec on startup
SWAGGER_URL=https://petstore.swagger.io/v2/swagger.json npm start

# HTTP mode — multi-session with Express
npm run start:http
```

## MCP Client Configuration

### Claude Desktop

Add to your Claude Desktop config file (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "swagger-api": {
      "command": "npx",
      "args": ["-y", "swagger-api-mcp-server"],
      "env": {
        "SWAGGER_URL": "https://petstore.swagger.io/v2/swagger.json"
      }
    }
  }
}
```

### Cursor / VS Code

Add to your MCP settings:

```json
{
  "mcpServers": {
    "swagger-api": {
      "command": "npx",
      "args": ["-y", "swagger-api-mcp-server"],
      "env": {
        "SWAGGER_URL": "https://your-api.example.com/openapi.json"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `swagger_load_spec` | Load a Swagger/OpenAPI spec from URL, parse and cache it |
| `swagger_update_cache` | Re-fetch spec and rebuild cache |
| `swagger_get_info` | Get API metadata (title, version, servers, auth schemes) |
| `swagger_list_tags` | List all tags with endpoint counts |
| `swagger_list_paths` | List endpoints with filtering (tag, method, keyword) and pagination |
| `swagger_get_endpoint` | Get endpoint summary + cached file path for full details |
| `swagger_list_schemas` | List schema definitions with filtering and pagination |
| `swagger_get_schema` | Get schema summary + cached file path for full definition |
| `swagger_search` | Search across endpoints and schemas by keyword |
| `swagger_call_api` | Execute HTTP requests with 2-phase confirmation |

## Cache Architecture

When a spec is loaded, it's parsed once and stored as structured JSON files:

```
.swagger-cache/
├── meta.json              # Cache metadata (URL, counts, timestamp)
├── info.json              # Full API info (title, servers, auth)
├── tags.json              # Tag list with endpoint counts
├── paths-index.json       # Endpoint index for fast lookup
├── schemas-index.json     # Schema index for fast lookup
├── endpoints/             # One file per endpoint (deep-resolved)
│   └── GET__users__{id}.json
└── schemas/               # One file per schema (deep-resolved)
    └── User.json
```

Tools return brief summaries with file paths. The LLM reads full details on demand via the `Read` tool — saving **85-95% of tokens** per call.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SWAGGER_URL` | *(empty)* | Auto-load spec on startup |
| `TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_PORT` | `3000` | HTTP server port |
| `MCP_HOST` | `0.0.0.0` | HTTP server host |
| `API_BASE_URL` | *(empty)* | Override API base URL for calls |
| `API_AUTH_TOKEN` | *(empty)* | Bearer token for API calls |
| `CACHE_DIR` | `.swagger-cache` | Custom cache directory path |
| `SESSION_TIMEOUT_MS` | `1800000` | HTTP session timeout (30 min) |
| `MAX_SESSIONS` | `100` | Max concurrent HTTP sessions |

## Development

```bash
npm run dev            # Dev mode with auto-reload (tsx watch)
npm test               # Run tests
npm run build          # TypeScript compilation → dist/
npm run clean          # Remove dist/
```

## License

[MIT](./LICENSE)
