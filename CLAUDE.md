# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm run build          # TypeScript compilation (tsc) → dist/
npm start              # Run server in stdio mode
npm run start:http     # Run server in HTTP mode (port 3000)
npm run dev            # Dev mode with auto-reload (tsx watch)
npm run clean          # Remove dist/
```

To auto-load a spec on startup: `SWAGGER_URL=https://example.com/swagger.json npm start`

## Architecture

This is an MCP (Model Context Protocol) server that parses Swagger 2.0 / OpenAPI 3.x specifications and exposes their contents as MCP tools. The spec is loaded into memory, parsed once into local JSON cache files, and tools return brief summaries + file paths instead of full content (saving 85-95% of tokens).

### Source Layout

- **`src/index.ts`** — Entry point, server factory, all 10 tool registrations, and both transport implementations (stdio + HTTP with Express). The `registerTools()` function contains all tool definitions. Each tool follows the pattern: define a Zod schema → call `registerToolWithMetadata()` with handler.
- **`src/types.ts`** — TypeScript interfaces for tool metadata, OpenAPI schema objects, endpoint details, session info. The spec is typed as `Record<string, unknown>` throughout (not a typed OpenAPI object) — all field access uses bracket notation with explicit casts.
- **`src/utils.ts`** — Pure utility functions: `$ref` resolution with circular reference protection (`deepResolve`), Swagger 2.0 vs OpenAPI 3.x abstraction helpers (`getSchemas`, `getServers`, `extractParameters`, etc.), and markdown formatting for tool output.
- **`src/cache-types.ts`** — TypeScript interfaces for cache files: `CacheMeta`, `CacheInfo`, `CacheTag`, `CachePathEntry`, `CacheSchemaEntry`, `CacheEndpointDetail`.
- **`src/cache.ts`** — Cache manager: generates, reads, and clears the `.swagger-cache/` directory. Exports `generateCache()`, `readCacheJSON()`, `getCacheFilePath()`, `ensureCacheLoaded()`, etc.

### Cache Architecture

When a spec is loaded, it's parsed once and written to `.swagger-cache/` as individual JSON files:

```
.swagger-cache/
├── meta.json              # Cache metadata (URL, counts, timestamp)
├── info.json              # Full API info (title, servers, security schemes)
├── tags.json              # Tag list with endpoint counts
├── paths-index.json       # Endpoint index (method, path, summary, tags, cacheFile)
├── schemas-index.json     # Schema index (name, type, propertyCount, cacheFile)
├── endpoints/             # One JSON file per endpoint (deep-resolved)
│   └── GET__users__{id}.json
└── schemas/               # One JSON file per schema (deep-resolved)
    └── User.json
```

Tools like `swagger_get_endpoint` and `swagger_get_schema` return ~200 chars (summary + file path) instead of 5-20KB of inline markdown. The LLM reads full details on demand via the Read tool.

### Key Design Decisions

- **Local file cache** — Spec is parsed once, written as JSON files. Tools query index files and return file paths, saving 85-95% of tokens.
- **No external OpenAPI parser** — `$ref` resolution is implemented manually in `deepResolve()` with a visited-set for circular refs and depth limit of 20. The spec is fetched via axios and parsed as JSON or YAML (js-yaml fallback).
- **Swagger 2.0 / OpenAPI 3.x dual support** — Helper functions in `utils.ts` abstract the differences (e.g., `definitions` vs `components.schemas`, `host+basePath` vs `servers`, `securityDefinitions` vs `components.securitySchemes`, inline body params vs `requestBody`).
- **Global mutable state** — `loadedSpec` and `specSourceUrl` are module-level variables shared across tools. In HTTP mode each session gets its own `McpServer` instance but shares the same loaded spec and cache.
- **Tool registry** — `Map<string, ToolMetadata>` mirrors registered tools for HTTP discovery endpoints (`GET /tools`, `GET /tools/:name`).
- **2-phase confirmation** — `swagger_call_api` requires `confirmed: true` to execute; default shows a preview.
- **No automatic cache expiry** — Use `swagger_update_cache` to explicitly refresh.

### Transport Modes

- **stdio** (`TRANSPORT=stdio`, default): Single `McpServer` + `StdioServerTransport`. Logs go to stderr.
- **HTTP** (`TRANSPORT=http`): Express server with session management via `mcp-session-id` header. Endpoints: `POST/GET/DELETE /mcp`, `GET /health`, `GET /tools`. Sessions have configurable timeout and max count with periodic cleanup.

### Tool Naming Convention

All tools use the prefix `swagger_` with snake_case: `swagger_load_spec`, `swagger_update_cache`, `swagger_get_info`, `swagger_list_tags`, `swagger_list_paths`, `swagger_get_endpoint`, `swagger_list_schemas`, `swagger_get_schema`, `swagger_search`, `swagger_call_api`.

### Adding a New Tool

1. Define a Zod schema with `.strict()` in `registerTools()` within `src/index.ts`
2. Call `registerToolWithMetadata(server, "swagger_tool_name", { title, description, inputSchema, annotations }, handler)`
3. Handler receives params typed via `z.infer<typeof Schema>`, returns `{ content: [{ type: "text", text }] }`
4. Use `ensureCacheLoaded()` at handler start if the tool needs cached data
5. Wrap handler body in try/catch, return `{ isError: true, ... }` on failure
