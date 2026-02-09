#!/usr/bin/env node

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import axios from "axios";
import yaml from "js-yaml";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { ToolMetadata, SessionInfo } from "./types.js";
import type { CacheInfo, CachePathEntry, CacheSchemaEntry, CacheTag } from "./cache-types.js";
import {
  getSpecVersion,
  getServers,
  handleError,
  truncateIfNeeded,
} from "./utils.js";
import {
  generateCache,
  clearCache,
  cacheExists,
  getCacheMeta,
  readCacheJSON,
  getCacheFilePath,
  ensureCacheLoaded,
} from "./cache.js";

// ============================================================
// Environment Configuration
// ============================================================

const SWAGGER_URL = process.env.SWAGGER_URL ?? "";
const TRANSPORT = process.env.TRANSPORT ?? "stdio";
const MCP_PORT = parseInt(process.env.MCP_PORT ?? "3000", 10);
const MCP_HOST = process.env.MCP_HOST ?? "0.0.0.0";
const API_BASE_URL = process.env.API_BASE_URL ?? "";
const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN ?? "";

// Session management (HTTP mode)
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS ?? "1800000", 10);
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS ?? "100", 10);
const SESSION_CLEANUP_INTERVAL_MS = parseInt(process.env.SESSION_CLEANUP_INTERVAL_MS ?? "60000", 10);
const ENABLE_SESSION_DEBUG = process.env.ENABLE_SESSION_DEBUG === "true";

// ============================================================
// Global State
// ============================================================

let loadedSpec: Record<string, unknown> | null = null;
let specSourceUrl: string = "";

const toolRegistry = new Map<string, ToolMetadata>();

// ============================================================
// Spec Loading
// ============================================================

async function loadSpecFromUrl(
  url: string,
  headers?: Record<string, string>
): Promise<Record<string, unknown>> {
  const requestHeaders: Record<string, string> = {
    Accept: "application/json, application/yaml, text/yaml, */*",
    ...headers,
  };

  const response = await axios.get(url, {
    headers: requestHeaders,
    timeout: 30000,
    responseType: "text",
  });

  let data = response.data;
  if (typeof data === "string") {
    // Try JSON first, then YAML
    try {
      data = JSON.parse(data);
    } catch {
      data = yaml.load(data);
    }
  }

  if (!data || typeof data !== "object") {
    throw new Error("Invalid spec: parsed result is not an object");
  }

  const spec = data as Record<string, unknown>;
  const version = getSpecVersion(spec);
  if (version === "unknown") {
    throw new Error(
      "Unrecognized spec format. Expected Swagger 2.0 or OpenAPI 3.x. " +
        'Ensure the document has a "swagger" or "openapi" field.'
    );
  }

  return spec;
}

function ensureSpecLoaded(): Record<string, unknown> {
  if (!loadedSpec) {
    throw new Error(
      "No Swagger/OpenAPI spec loaded. Use swagger_load_spec to load one first, " +
        "or set SWAGGER_URL environment variable."
    );
  }
  return loadedSpec;
}

/**
 * Load spec and generate cache. Returns summary text.
 */
async function loadAndCache(
  url: string,
  headers?: Record<string, string>
): Promise<{ spec: Record<string, unknown>; summary: string }> {
  const spec = await loadSpecFromUrl(url, headers);
  loadedSpec = spec;
  specSourceUrl = url;

  // Check if cache already exists for same URL
  const existingMeta = getCacheMeta();
  if (existingMeta && existingMeta.specUrl === url) {
    const version = getSpecVersion(spec);
    const info = (spec["info"] as Record<string, unknown>) ?? {};
    const summary = [
      `Spec loaded (cache reused).`,
      ``,
      `- **Format:** ${version === "2.0" ? "Swagger 2.0" : `OpenAPI ${spec["openapi"]}`}`,
      `- **Title:** ${info["title"] ?? "N/A"}`,
      `- **Version:** ${info["version"] ?? "N/A"}`,
      `- **Endpoints:** ${existingMeta.endpointCount}`,
      `- **Schemas:** ${existingMeta.schemaCount}`,
      `- **Tags:** ${existingMeta.tagCount}`,
      `- **Source:** ${url}`,
      `- **Cache:** ${existingMeta.cacheDir}`,
    ];
    return { spec, summary: summary.join("\n") };
  }

  // Generate fresh cache
  const meta = await generateCache(spec, url);

  const summary = [
    `Spec loaded and cached successfully!`,
    ``,
    `- **Format:** ${meta.specFormat}`,
    `- **Title:** ${meta.specTitle}`,
    `- **Version:** ${meta.specVersion}`,
    `- **Endpoints:** ${meta.endpointCount}`,
    `- **Schemas:** ${meta.schemaCount}`,
    `- **Tags:** ${meta.tagCount}`,
    `- **Source:** ${url}`,
    `- **Cache:** ${meta.cacheDir}`,
  ];
  return { spec, summary: summary.join("\n") };
}

// ============================================================
// Tool Registration Helper
// ============================================================

function registerToolWithMetadata(
  server: McpServer,
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: z.ZodTypeAny;
    annotations: ToolMetadata["annotations"];
  },
  handler: (params: Record<string, unknown>) => Promise<{
    isError?: boolean;
    content: Array<{ type: "text"; text: string }>;
  }>
): void {
  const metadata: ToolMetadata = {
    name,
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema,
    annotations: config.annotations,
  };
  toolRegistry.set(name, metadata);

  server.registerTool(name, {
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema,
    annotations: config.annotations,
  }, handler);
}

function toolMetadataToJson(meta: ToolMetadata): Record<string, unknown> {
  return {
    name: meta.name,
    title: meta.title,
    description: meta.description,
    inputSchema: zodToJsonSchema(meta.inputSchema),
    annotations: meta.annotations,
  };
}

// ============================================================
// Server Factory
// ============================================================

function createServer(): McpServer {
  const server = new McpServer({
    name: "swagger-api-mcp-server",
    version: "1.0.0",
  });

  registerTools(server);
  return server;
}

// ============================================================
// Tool Definitions
// ============================================================

function registerTools(server: McpServer): void {
  // --------------------------------------------------------
  // 1. swagger_load_spec
  // --------------------------------------------------------
  const LoadSpecSchema = z
    .object({
      url: z.string().min(1, "URL is required").describe("URL of the Swagger/OpenAPI spec (JSON or YAML)"),
      headers: z
        .record(z.string())
        .optional()
        .describe("Optional HTTP headers for fetching the spec (e.g. authorization)"),
    })
    .strict();

  registerToolWithMetadata(
    server,
    "swagger_load_spec",
    {
      title: "Load Swagger/OpenAPI Spec",
      description:
        "Load and parse a Swagger 2.0 or OpenAPI 3.x specification from a URL. " +
        "Supports both JSON and YAML formats. The loaded spec is parsed, cached to local " +
        "JSON files, and used by all subsequent tools. Must be called first before using " +
        "other tools (unless SWAGGER_URL env var is set).",
      inputSchema: LoadSpecSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const { url, headers } = params as z.infer<typeof LoadSpecSchema>;
        const { summary } = await loadAndCache(url, headers);
        return {
          content: [{ type: "text" as const, text: summary }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: handleError(error) }],
        };
      }
    }
  );

  // --------------------------------------------------------
  // 2. swagger_update_cache (NEW)
  // --------------------------------------------------------
  const UpdateCacheSchema = z
    .object({
      url: z
        .string()
        .optional()
        .describe("URL of the spec to reload. If omitted, re-fetches the previously loaded URL."),
      headers: z
        .record(z.string())
        .optional()
        .describe("Optional HTTP headers for fetching the spec"),
    })
    .strict();

  registerToolWithMetadata(
    server,
    "swagger_update_cache",
    {
      title: "Update Spec Cache",
      description:
        "Re-fetch the Swagger/OpenAPI spec and rebuild the local file cache. " +
        "Use this when the upstream spec has changed. Optionally provide a new URL.",
      inputSchema: UpdateCacheSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const { url, headers } = params as z.infer<typeof UpdateCacheSchema>;
        const targetUrl = url ?? specSourceUrl;
        if (!targetUrl) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "No URL provided and no spec was previously loaded. Provide a url parameter.",
              },
            ],
          };
        }

        // Clear old cache and regenerate
        clearCache();
        const spec = await loadSpecFromUrl(targetUrl, headers);
        loadedSpec = spec;
        specSourceUrl = targetUrl;
        const meta = await generateCache(spec, targetUrl);

        const summary = [
          `Cache rebuilt successfully!`,
          ``,
          `- **Format:** ${meta.specFormat}`,
          `- **Title:** ${meta.specTitle}`,
          `- **Version:** ${meta.specVersion}`,
          `- **Endpoints:** ${meta.endpointCount}`,
          `- **Schemas:** ${meta.schemaCount}`,
          `- **Tags:** ${meta.tagCount}`,
          `- **Source:** ${targetUrl}`,
          `- **Cache:** ${meta.cacheDir}`,
        ];

        return {
          content: [{ type: "text" as const, text: summary.join("\n") }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: handleError(error) }],
        };
      }
    }
  );

  // --------------------------------------------------------
  // 3. swagger_get_info
  // --------------------------------------------------------
  const GetInfoSchema = z.object({}).strict();

  registerToolWithMetadata(
    server,
    "swagger_get_info",
    {
      title: "Get API Info",
      description:
        "Get general metadata about the loaded API specification. Returns a brief summary " +
        "and the path to info.json which contains full details (title, version, description, " +
        "servers, authentication schemes, contact info). Use the Read tool on the file path " +
        "to see complete information.",
      inputSchema: GetInfoSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const meta = ensureCacheLoaded();
        const infoPath = getCacheFilePath("info.json");
        const info = readCacheJSON<CacheInfo>("info.json");

        const lines = [
          `**${info.title}** v${info.version} (${info.specFormat})`,
          info.description ? `${info.description.slice(0, 200)}` : "",
          `Servers: ${info.servers.map((s) => s.url).join(", ") || "none"}`,
          `Security schemes: ${Object.keys(info.securitySchemes).join(", ") || "none"}`,
          ``,
          `Full details: ${infoPath}`,
        ].filter(Boolean);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: handleError(error) }],
        };
      }
    }
  );

  // --------------------------------------------------------
  // 4. swagger_list_tags
  // --------------------------------------------------------
  const ListTagsSchema = z.object({}).strict();

  registerToolWithMetadata(
    server,
    "swagger_list_tags",
    {
      title: "List API Tags",
      description:
        "List all tags defined in the API spec. Tags are used to group related endpoints. " +
        "Also shows how many endpoints belong to each tag.",
      inputSchema: ListTagsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        ensureCacheLoaded();
        const tags = readCacheJSON<CacheTag[]>("tags.json");

        const lines: string[] = [];
        lines.push(`# API Tags (${tags.length} total)`);
        lines.push(``);

        for (const tag of tags) {
          lines.push(
            `- **${tag.name}** (${tag.endpointCount} endpoint${tag.endpointCount !== 1 ? "s" : ""})${tag.description ? ` — ${tag.description}` : ""}`
          );
        }

        if (tags.length === 0) {
          lines.push("No tags defined in this API.");
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: handleError(error) }],
        };
      }
    }
  );

  // --------------------------------------------------------
  // 5. swagger_list_paths
  // --------------------------------------------------------
  const ListPathsSchema = z
    .object({
      tag: z.string().optional().describe("Filter by tag name"),
      method: z
        .string()
        .optional()
        .describe("Filter by HTTP method (GET, POST, PUT, DELETE, etc.)"),
      keyword: z
        .string()
        .optional()
        .describe("Filter by keyword in path, summary, or operationId"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Maximum results to return (default 50)"),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Number of results to skip for pagination"),
    })
    .strict();

  registerToolWithMetadata(
    server,
    "swagger_list_paths",
    {
      title: "List API Endpoints",
      description:
        "List all API endpoints with method, path, summary, and tags. " +
        "Supports filtering by tag, HTTP method, and keyword search. " +
        "Use pagination (limit/offset) for large APIs. Each entry includes " +
        "a cacheFile path for detailed info.",
      inputSchema: ListPathsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        ensureCacheLoaded();
        const { tag, method, keyword, limit, offset } = params as z.infer<
          typeof ListPathsSchema
        >;

        let entries = readCacheJSON<CachePathEntry[]>("paths-index.json");

        // Apply filters
        if (tag) {
          entries = entries.filter((e) =>
            e.tags.some((t) => t.toLowerCase() === tag.toLowerCase())
          );
        }
        if (method) {
          const m = method.toUpperCase();
          entries = entries.filter((e) => e.method === m);
        }
        if (keyword) {
          const kw = keyword.toLowerCase();
          entries = entries.filter((e) => {
            return (
              e.path.toLowerCase().includes(kw) ||
              (e.summary ?? "").toLowerCase().includes(kw) ||
              (e.operationId ?? "").toLowerCase().includes(kw) ||
              (e.description ?? "").toLowerCase().includes(kw)
            );
          });
        }

        const total = entries.length;
        const paged = entries.slice(offset, offset + limit);

        const lines: string[] = [];
        lines.push(`# API Endpoints (${paged.length} of ${total})`);
        if (offset > 0) lines.push(`*(offset: ${offset})*`);
        lines.push(``);

        for (const e of paged) {
          const deprecated = e.deprecated ? " ~~DEPRECATED~~" : "";
          const opId = e.operationId ? ` \`${e.operationId}\`` : "";
          lines.push(`- **${e.method}** \`${e.path}\`${deprecated}${opId}`);
          if (e.summary) lines.push(`  ${e.summary}`);
          if (e.tags.length > 0) lines.push(`  Tags: ${e.tags.join(", ")}`);
        }

        if (total > offset + limit) {
          lines.push(``);
          lines.push(
            `*${total - offset - limit} more endpoints. Use offset=${offset + limit} to see next page.*`
          );
        }

        return {
          content: [{ type: "text" as const, text: truncateIfNeeded(lines.join("\n")) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: handleError(error) }],
        };
      }
    }
  );

  // --------------------------------------------------------
  // 6. swagger_get_endpoint
  // --------------------------------------------------------
  const GetEndpointSchema = z
    .object({
      path: z.string().min(1).describe("API endpoint path (e.g. /users/{id})"),
      method: z.string().min(1).describe("HTTP method (GET, POST, PUT, DELETE, etc.)"),
    })
    .strict();

  registerToolWithMetadata(
    server,
    "swagger_get_endpoint",
    {
      title: "Get Endpoint Details",
      description:
        "Get a brief summary of a specific API endpoint and the path to its cached JSON file " +
        "containing complete details (parameters, request body, responses, security). " +
        "Use the Read tool on the returned file path to see the full endpoint definition.",
      inputSchema: GetEndpointSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        ensureCacheLoaded();
        const { path: apiPath, method } = params as z.infer<typeof GetEndpointSchema>;
        const m = method.toUpperCase();

        const index = readCacheJSON<CachePathEntry[]>("paths-index.json");
        const entry = index.find(
          (e) => e.path === apiPath && e.method === m
        );

        if (!entry) {
          // Try fuzzy match
          const similar = index
            .filter((e) => e.path.toLowerCase().includes(apiPath.toLowerCase()))
            .slice(0, 5);
          const methodMatch = index.filter((e) => e.path === apiPath);
          if (methodMatch.length > 0) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Method "${m}" not found for path "${apiPath}". Available methods: ${methodMatch.map((e) => e.method).join(", ")}`,
                },
              ],
            };
          }
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Path "${apiPath}" not found.${similar.length > 0 ? ` Similar paths:\n${similar.map((e) => `  - ${e.method} ${e.path}`).join("\n")}` : ""}`,
              },
            ],
          };
        }

        const filePath = getCacheFilePath(entry.cacheFile);
        const deprecated = entry.deprecated ? " [DEPRECATED]" : "";
        const lines = [
          `**${entry.method} ${entry.path}**${deprecated}`,
          entry.summary ? entry.summary : "",
          entry.operationId ? `Operation ID: \`${entry.operationId}\`` : "",
          entry.tags.length > 0 ? `Tags: ${entry.tags.join(", ")}` : "",
          ``,
          `Full details: ${filePath}`,
        ].filter(Boolean);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: handleError(error) }],
        };
      }
    }
  );

  // --------------------------------------------------------
  // 7. swagger_list_schemas
  // --------------------------------------------------------
  const ListSchemasSchema = z
    .object({
      keyword: z.string().optional().describe("Filter schemas by name or description keyword"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Maximum results to return (default 50)"),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Number of results to skip for pagination"),
    })
    .strict();

  registerToolWithMetadata(
    server,
    "swagger_list_schemas",
    {
      title: "List Schema Definitions",
      description:
        "List all model/schema definitions in the API spec. Shows schema name, " +
        "type, description, and property count. Supports keyword filtering and pagination.",
      inputSchema: ListSchemasSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        ensureCacheLoaded();
        const { keyword, limit, offset } = params as z.infer<typeof ListSchemasSchema>;

        let entries = readCacheJSON<CacheSchemaEntry[]>("schemas-index.json");

        if (keyword) {
          const kw = keyword.toLowerCase();
          entries = entries.filter(
            (e) =>
              e.name.toLowerCase().includes(kw) ||
              (e.description ?? "").toLowerCase().includes(kw)
          );
        }

        const total = entries.length;
        const paged = entries.slice(offset, offset + limit);

        const lines: string[] = [];
        lines.push(`# Schema Definitions (${paged.length} of ${total})`);
        if (offset > 0) lines.push(`*(offset: ${offset})*`);
        lines.push(``);

        for (const entry of paged) {
          const type = entry.type ?? "object";
          const propInfo =
            entry.propertyCount > 0 ? `, ${entry.propertyCount} properties` : "";
          const desc = entry.description ? ` — ${entry.description}` : "";
          lines.push(`- **${entry.name}** (\`${type}\`${propInfo})${desc}`);
        }

        if (total === 0) {
          lines.push("No schemas defined in this API.");
        }

        if (total > offset + limit) {
          lines.push(``);
          lines.push(
            `*${total - offset - limit} more schemas. Use offset=${offset + limit} to see next page.*`
          );
        }

        return {
          content: [{ type: "text" as const, text: truncateIfNeeded(lines.join("\n")) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: handleError(error) }],
        };
      }
    }
  );

  // --------------------------------------------------------
  // 8. swagger_get_schema
  // --------------------------------------------------------
  const GetSchemaSchema = z
    .object({
      name: z.string().min(1).describe("Schema/model name (e.g. 'User', 'OrderResponse')"),
    })
    .strict();

  registerToolWithMetadata(
    server,
    "swagger_get_schema",
    {
      title: "Get Schema Details",
      description:
        "Get a brief summary of a specific schema/model and the path to its cached JSON file " +
        "containing the complete deep-resolved definition (all properties, types, required fields, " +
        "enums, defaults, nested structures). Use the Read tool on the returned file path " +
        "to see the full schema.",
      inputSchema: GetSchemaSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        ensureCacheLoaded();
        const { name } = params as z.infer<typeof GetSchemaSchema>;

        const index = readCacheJSON<CacheSchemaEntry[]>("schemas-index.json");
        const entry = index.find((e) => e.name === name);

        if (!entry) {
          const similar = index
            .filter((e) => e.name.toLowerCase().includes(name.toLowerCase()))
            .slice(0, 10);
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Schema "${name}" not found.${similar.length > 0 ? ` Similar schemas:\n${similar.map((e) => `  - ${e.name}`).join("\n")}` : ""}`,
              },
            ],
          };
        }

        const filePath = getCacheFilePath(entry.cacheFile);
        const lines = [
          `**${entry.name}** (\`${entry.type ?? "object"}\`, ${entry.propertyCount} properties)`,
          entry.description ? entry.description.slice(0, 200) : "",
          ``,
          `Full schema: ${filePath}`,
        ].filter(Boolean);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: handleError(error) }],
        };
      }
    }
  );

  // --------------------------------------------------------
  // 9. swagger_search
  // --------------------------------------------------------
  const SearchSchema = z
    .object({
      keyword: z.string().min(1).describe("Search keyword"),
      scope: z
        .enum(["all", "paths", "schemas"])
        .default("all")
        .describe("Search scope: 'all', 'paths', or 'schemas'"),
    })
    .strict();

  registerToolWithMetadata(
    server,
    "swagger_search",
    {
      title: "Search API Spec",
      description:
        "Search across the API specification by keyword. Searches in endpoint paths, " +
        "summaries, descriptions, operation IDs, and schema names. Returns matching items " +
        "with their cache file paths for detailed lookup.",
      inputSchema: SearchSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        ensureCacheLoaded();
        const { keyword, scope } = params as z.infer<typeof SearchSchema>;
        const kw = keyword.toLowerCase();

        const lines: string[] = [];
        lines.push(`# Search Results for "${keyword}"`);
        lines.push(``);

        // Search paths
        if (scope === "all" || scope === "paths") {
          const index = readCacheJSON<CachePathEntry[]>("paths-index.json");
          const matches = index.filter((e) => {
            return (
              e.path.toLowerCase().includes(kw) ||
              (e.summary ?? "").toLowerCase().includes(kw) ||
              (e.description ?? "").toLowerCase().includes(kw) ||
              (e.operationId ?? "").toLowerCase().includes(kw)
            );
          });

          lines.push(`## Endpoints (${matches.length} matches)`);
          lines.push(``);
          for (const e of matches.slice(0, 30)) {
            const filePath = getCacheFilePath(e.cacheFile);
            lines.push(
              `- **${e.method}** \`${e.path}\`${e.summary ? ` — ${e.summary}` : ""}`
            );
            lines.push(`  ${filePath}`);
          }
          if (matches.length > 30) {
            lines.push(`  *(${matches.length - 30} more matches...)*`);
          }
          if (matches.length === 0) {
            lines.push(`  (no matching endpoints)`);
          }
          lines.push(``);
        }

        // Search schemas
        if (scope === "all" || scope === "schemas") {
          const index = readCacheJSON<CacheSchemaEntry[]>("schemas-index.json");
          const matches = index.filter((e) => {
            return (
              e.name.toLowerCase().includes(kw) ||
              (e.description ?? "").toLowerCase().includes(kw)
            );
          });

          lines.push(`## Schemas (${matches.length} matches)`);
          lines.push(``);
          for (const e of matches.slice(0, 20)) {
            const filePath = getCacheFilePath(e.cacheFile);
            lines.push(`- **${e.name}** (\`${e.type ?? "object"}\`, ${e.propertyCount} props)`);
            lines.push(`  ${filePath}`);
          }
          if (matches.length > 20) {
            lines.push(`  *(${matches.length - 20} more matches...)*`);
          }
          if (matches.length === 0) {
            lines.push(`  (no matching schemas)`);
          }
          lines.push(``);
        }

        return {
          content: [{ type: "text" as const, text: truncateIfNeeded(lines.join("\n")) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: handleError(error) }],
        };
      }
    }
  );

  // --------------------------------------------------------
  // 10. swagger_call_api
  // --------------------------------------------------------
  const CallApiSchema = z
    .object({
      path: z.string().min(1).describe("API endpoint path (e.g. /users/{id})"),
      method: z
        .string()
        .min(1)
        .describe("HTTP method (GET, POST, PUT, DELETE, etc.)"),
      path_params: z
        .record(z.string())
        .optional()
        .describe("Path parameter values (e.g. { id: '123' })"),
      query_params: z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Query parameters"),
      headers: z
        .record(z.string())
        .optional()
        .describe("Additional request headers"),
      body: z.unknown().optional().describe("Request body (JSON)"),
      base_url: z
        .string()
        .optional()
        .describe("Override base URL (default from spec or API_BASE_URL env)"),
      confirmed: z
        .boolean()
        .default(false)
        .describe(
          "Set to true to actually execute the request. " +
          "When false (default), shows a preview of the request."
        ),
    })
    .strict();

  registerToolWithMetadata(
    server,
    "swagger_call_api",
    {
      title: "Call API Endpoint",
      description:
        "Execute an actual HTTP request to an API endpoint. Uses a 2-phase confirmation: " +
        "first call shows a preview of the request, second call with confirmed=true executes it. " +
        "Uses the base URL from the spec, API_BASE_URL env var, or the base_url parameter.",
      inputSchema: CallApiSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const {
          path,
          method,
          path_params,
          query_params,
          headers,
          body,
          base_url,
          confirmed,
        } = params as z.infer<typeof CallApiSchema>;

        // Determine base URL
        let baseUrl = base_url ?? API_BASE_URL;
        if (!baseUrl && loadedSpec) {
          const servers = getServers(loadedSpec);
          if (servers.length > 0) {
            baseUrl = servers[0].url;
          }
        }
        // Fallback: try cache info
        if (!baseUrl && cacheExists()) {
          try {
            const info = readCacheJSON<CacheInfo>("info.json");
            if (info.servers.length > 0) {
              baseUrl = info.servers[0].url;
            }
          } catch {
            // ignore
          }
        }
        if (!baseUrl) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Error: No base URL available. Provide base_url parameter, set API_BASE_URL env var, or load a spec with server info.",
              },
            ],
          };
        }

        // Remove trailing slash from baseUrl
        baseUrl = baseUrl.replace(/\/+$/, "");

        // Substitute path parameters
        let resolvedPath = path;
        if (path_params) {
          for (const [key, value] of Object.entries(path_params)) {
            resolvedPath = resolvedPath.replace(`{${key}}`, encodeURIComponent(value));
          }
        }

        const fullUrl = `${baseUrl}${resolvedPath}`;
        const m = method.toUpperCase();

        // Build preview
        const preview = [
          `## API Call Preview`,
          ``,
          `- **Method:** ${m}`,
          `- **URL:** ${fullUrl}`,
        ];

        if (query_params && Object.keys(query_params).length > 0) {
          preview.push(`- **Query Params:** ${JSON.stringify(query_params)}`);
        }
        if (headers && Object.keys(headers).length > 0) {
          preview.push(`- **Custom Headers:** ${JSON.stringify(headers)}`);
        }
        if (API_AUTH_TOKEN) {
          preview.push(`- **Auth:** Bearer token (from env)`);
        }
        if (body !== undefined) {
          preview.push(`- **Body:**`);
          preview.push("```json");
          preview.push(JSON.stringify(body, null, 2));
          preview.push("```");
        }

        if (!confirmed) {
          preview.push(``);
          preview.push(
            `This is a preview. Set \`confirmed: true\` to execute the request.`
          );
          return {
            content: [{ type: "text" as const, text: preview.join("\n") }],
          };
        }

        // Execute the request
        const requestHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...headers,
        };
        if (API_AUTH_TOKEN) {
          requestHeaders["Authorization"] = API_AUTH_TOKEN.startsWith("Bearer ")
            ? API_AUTH_TOKEN
            : `Bearer ${API_AUTH_TOKEN}`;
        }

        const response = await axios({
          method: m.toLowerCase() as "get" | "post" | "put" | "delete" | "patch" | "head" | "options",
          url: fullUrl,
          params: query_params,
          data: body,
          headers: requestHeaders,
          timeout: 30000,
          validateStatus: () => true, // Accept all status codes
        });

        const result = [
          `## API Response`,
          ``,
          `- **Status:** ${response.status} ${response.statusText}`,
          `- **URL:** ${m} ${fullUrl}`,
        ];

        // Response headers (selected)
        const respHeaders = response.headers;
        const importantHeaders = [
          "content-type",
          "x-request-id",
          "x-rate-limit-remaining",
          "retry-after",
        ];
        const headerLines: string[] = [];
        for (const h of importantHeaders) {
          if (respHeaders[h]) {
            headerLines.push(`  - ${h}: ${respHeaders[h]}`);
          }
        }
        if (headerLines.length > 0) {
          result.push(`- **Response Headers:**`);
          result.push(...headerLines);
        }

        // Response body
        result.push(``);
        result.push(`### Response Body`);
        result.push("```json");
        const bodyStr =
          typeof response.data === "string"
            ? response.data
            : JSON.stringify(response.data, null, 2);
        result.push(bodyStr.slice(0, 10000));
        if (bodyStr.length > 10000) {
          result.push(`... (truncated, total ${bodyStr.length} characters)`);
        }
        result.push("```");

        return {
          content: [{ type: "text" as const, text: truncateIfNeeded(result.join("\n")) }],
        };
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const parts = [`Error calling API:`];
          if (error.response) {
            parts.push(`Status: ${error.response.status} ${error.response.statusText}`);
            parts.push(`Body: ${JSON.stringify(error.response.data).slice(0, 2000)}`);
          } else if (error.code === "ECONNABORTED") {
            parts.push("Request timed out. Check that the API server is reachable.");
          } else if (error.code === "ECONNREFUSED") {
            parts.push("Connection refused. Check that the API server is running.");
          } else {
            parts.push(error.message);
          }
          return {
            isError: true,
            content: [{ type: "text" as const, text: parts.join("\n") }],
          };
        }
        return {
          isError: true,
          content: [{ type: "text" as const, text: handleError(error) }],
        };
      }
    }
  );
}

// ============================================================
// Transport: Stdio
// ============================================================

async function runStdio(): Promise<void> {
  const server = createServer();

  // Auto-load spec if SWAGGER_URL is set
  if (SWAGGER_URL) {
    try {
      console.error(`Loading spec from SWAGGER_URL: ${SWAGGER_URL}`);
      const { summary } = await loadAndCache(SWAGGER_URL);
      console.error(summary.replace(/\*\*/g, ""));
    } catch (error) {
      console.error(`Warning: Failed to load spec from SWAGGER_URL: ${handleError(error)}`);
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("swagger-api-mcp-server running via stdio");
}

// ============================================================
// Transport: HTTP (Streamable)
// ============================================================

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  const sessions = new Map<string, SessionInfo>();

  // Session cleanup interval
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivityAt.getTime() > SESSION_TIMEOUT_MS) {
        console.error(`Session ${id} timed out, cleaning up`);
        const transport = session.transport as StreamableHTTPServerTransport;
        transport.close();
        sessions.delete(id);
      }
    }
  }, SESSION_CLEANUP_INTERVAL_MS);

  // Auto-load spec if SWAGGER_URL is set
  if (SWAGGER_URL) {
    try {
      console.error(`Loading spec from SWAGGER_URL: ${SWAGGER_URL}`);
      const { summary } = await loadAndCache(SWAGGER_URL);
      console.error(summary.replace(/\*\*/g, ""));
    } catch (error) {
      console.error(`Warning: Failed to load spec from SWAGGER_URL: ${handleError(error)}`);
    }
  }

  // POST /mcp - JSON-RPC requests
  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (session) {
      // Existing session
      session.lastActivityAt = new Date();
      session.requestCount++;
      const transport = session.transport as StreamableHTTPServerTransport;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session
    if (sessions.size >= MAX_SESSIONS) {
      res.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Max sessions reached. Try again later." },
        id: null,
      });
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    const newSessionId = transport.sessionId;
    if (newSessionId) {
      sessions.set(newSessionId, {
        transport,
        server,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        requestCount: 1,
      });
    }
  });

  // GET /mcp - SSE stream
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const session = sessions.get(sessionId)!;
    session.lastActivityAt = new Date();
    const transport = session.transport as StreamableHTTPServerTransport;
    await transport.handleRequest(req, res);
  });

  // DELETE /mcp - Terminate session
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      const transport = session.transport as StreamableHTTPServerTransport;
      transport.close();
      sessions.delete(sessionId);
      res.status(200).json({ message: "Session terminated" });
    } else {
      res.status(404).json({ error: "Session not found" });
    }
  });

  // GET /health - Health check
  app.get("/health", (_req, res) => {
    const meta = getCacheMeta();
    res.json({
      status: "ok",
      server: "swagger-api-mcp-server",
      version: "1.0.0",
      activeSessions: sessions.size,
      specLoaded: loadedSpec !== null,
      cacheAvailable: cacheExists(),
      specTitle: meta?.specTitle ?? (loadedSpec
        ? (loadedSpec["info"] as Record<string, unknown>)?.["title"] ?? "N/A"
        : null),
    });
  });

  // GET /tools - List all tools
  app.get("/tools", (_req, res) => {
    const tools = Array.from(toolRegistry.values()).map(toolMetadataToJson);
    res.json({ tools, count: tools.length });
  });

  // GET /tools/:toolName - Tool details
  app.get("/tools/:toolName", (req, res) => {
    const meta = toolRegistry.get(req.params.toolName);
    if (!meta) {
      res.status(404).json({ error: `Tool "${req.params.toolName}" not found` });
      return;
    }
    res.json(toolMetadataToJson(meta));
  });

  // GET /sessions - Debug session info
  if (ENABLE_SESSION_DEBUG) {
    app.get("/sessions", (_req, res) => {
      const info = Array.from(sessions.entries()).map(([id, s]) => ({
        id,
        createdAt: s.createdAt,
        lastActivityAt: s.lastActivityAt,
        requestCount: s.requestCount,
      }));
      res.json({ sessions: info, count: info.length });
    });
  }

  const httpServer = app.listen(MCP_PORT, MCP_HOST, () => {
    console.error(
      `swagger-api-mcp-server running on http://${MCP_HOST}:${MCP_PORT}/mcp`
    );
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.error("Shutting down...");
    clearInterval(cleanupInterval);
    for (const [, session] of sessions) {
      const transport = session.transport as StreamableHTTPServerTransport;
      transport.close();
    }
    httpServer.close(() => {
      console.error("Server stopped");
      process.exit(0);
    });
  });
}

// ============================================================
// Main Entry Point
// ============================================================

async function main(): Promise<void> {
  if (TRANSPORT === "http") {
    await runHTTP();
  } else {
    await runStdio();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
