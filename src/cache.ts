import fs from "node:fs";
import path from "node:path";

import type {
  CacheMeta,
  CacheInfo,
  CacheTag,
  CachePathEntry,
  CacheSchemaEntry,
  CacheEndpointDetail,
} from "./cache-types.js";

import {
  getSpecVersion,
  getSchemas,
  getServers,
  getSecuritySchemes,
  getTags,
  extractOperations,
  extractParameters,
  extractRequestBody,
  extractResponses,
  deepResolve,
} from "./utils.js";

// ============================================================
// Path Helpers
// ============================================================

export function getCacheDir(): string {
  return path.resolve(process.env.CACHE_DIR ?? ".swagger-cache");
}

/**
 * Convert "GET /users/{id}" to "GET__users__{id}.json"
 */
export function endpointCacheFileName(method: string, apiPath: string): string {
  const safe = apiPath
    .replace(/^\//, "")
    .replace(/\//g, "__")
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9_\-\.]/g, "_");
  return `${method.toUpperCase()}__${safe}.json`;
}

/**
 * Make a schema name filesystem-safe.
 */
export function schemaCacheFileName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
  return `${safe}.json`;
}

// ============================================================
// Cache Generation
// ============================================================

export async function generateCache(
  spec: Record<string, unknown>,
  url: string
): Promise<CacheMeta> {
  const cacheDir = getCacheDir();
  const endpointsDir = path.join(cacheDir, "endpoints");
  const schemasDir = path.join(cacheDir, "schemas");

  // Create directories
  fs.mkdirSync(endpointsDir, { recursive: true });
  fs.mkdirSync(schemasDir, { recursive: true });

  const version = getSpecVersion(spec);
  const info = (spec["info"] as Record<string, unknown>) ?? {};
  const specFormat = version === "2.0" ? "Swagger 2.0" : `OpenAPI ${spec["openapi"]}`;

  // --- info.json ---
  const servers = getServers(spec);
  const secSchemes = getSecuritySchemes(spec);
  const globalSecurity = spec["security"] as Array<Record<string, string[]>> | undefined;

  const cacheInfo: CacheInfo = {
    title: (info["title"] as string) ?? "N/A",
    version: (info["version"] as string) ?? "N/A",
    description: info["description"] as string | undefined,
    termsOfService: info["termsOfService"] as string | undefined,
    contact: info["contact"] as CacheInfo["contact"],
    license: info["license"] as CacheInfo["license"],
    specFormat,
    specSource: url,
    servers,
    securitySchemes: secSchemes,
    globalSecurity,
  };
  writeJSON(path.join(cacheDir, "info.json"), cacheInfo);

  // --- tags.json ---
  const definedTags = getTags(spec);
  const operations = extractOperations(spec);

  const tagCounts = new Map<string, number>();
  for (const op of operations) {
    const tags = (op.operation["tags"] as string[]) ?? ["untagged"];
    for (const tag of tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const allTagNames = new Map<string, string | undefined>();
  for (const t of definedTags) {
    allTagNames.set(t.name, t.description);
  }
  for (const tag of tagCounts.keys()) {
    if (!allTagNames.has(tag)) {
      allTagNames.set(tag, undefined);
    }
  }

  const cacheTags: CacheTag[] = [];
  for (const [name, desc] of allTagNames) {
    cacheTags.push({
      name,
      description: desc,
      endpointCount: tagCounts.get(name) ?? 0,
    });
  }
  writeJSON(path.join(cacheDir, "tags.json"), cacheTags);

  // --- endpoints + paths-index.json ---
  const pathsIndex: CachePathEntry[] = [];

  for (const op of operations) {
    const fileName = endpointCacheFileName(op.method, op.path);
    const relativePath = `endpoints/${fileName}`;

    const operation = op.operation;
    const parameters = extractParameters(spec, op.path, operation);
    const requestBody = extractRequestBody(spec, operation);
    const responses = extractResponses(spec, operation);

    const detail: CacheEndpointDetail = {
      method: op.method,
      path: op.path,
      summary: operation["summary"] as string | undefined,
      description: operation["description"] as string | undefined,
      operationId: operation["operationId"] as string | undefined,
      tags: (operation["tags"] as string[]) ?? [],
      deprecated: operation["deprecated"] as boolean | undefined,
      parameters,
      requestBody,
      responses,
      security: operation["security"] as Array<Record<string, string[]>> | undefined,
    };
    writeJSON(path.join(endpointsDir, fileName), detail);

    pathsIndex.push({
      method: op.method,
      path: op.path,
      summary: operation["summary"] as string | undefined,
      description: operation["description"] as string | undefined,
      tags: (operation["tags"] as string[]) ?? [],
      operationId: operation["operationId"] as string | undefined,
      deprecated: operation["deprecated"] as boolean | undefined,
      cacheFile: relativePath,
    });
  }
  writeJSON(path.join(cacheDir, "paths-index.json"), pathsIndex);

  // --- schemas + schemas-index.json ---
  const schemas = getSchemas(spec);
  const schemasIndex: CacheSchemaEntry[] = [];

  for (const [name, schema] of Object.entries(schemas)) {
    const fileName = schemaCacheFileName(name);
    const relativePath = `schemas/${fileName}`;
    const resolved = deepResolve(spec, schema) as Record<string, unknown>;

    writeJSON(path.join(schemasDir, fileName), resolved);

    const s = schema as Record<string, unknown>;
    schemasIndex.push({
      name,
      type: s["type"] as string | undefined,
      description: s["description"] as string | undefined,
      propertyCount: Object.keys(
        (s["properties"] as Record<string, unknown>) ?? {}
      ).length,
      cacheFile: relativePath,
    });
  }
  writeJSON(path.join(cacheDir, "schemas-index.json"), schemasIndex);

  // --- meta.json ---
  const meta: CacheMeta = {
    specUrl: url,
    specTitle: (info["title"] as string) ?? "N/A",
    specVersion: (info["version"] as string) ?? "N/A",
    specFormat,
    endpointCount: pathsIndex.length,
    schemaCount: schemasIndex.length,
    tagCount: cacheTags.length,
    cachedAt: new Date().toISOString(),
    cacheDir: path.resolve(cacheDir),
  };
  writeJSON(path.join(cacheDir, "meta.json"), meta);

  return meta;
}

// ============================================================
// Cache Reading
// ============================================================

export function cacheExists(): boolean {
  return fs.existsSync(path.join(getCacheDir(), "meta.json"));
}

export function getCacheMeta(): CacheMeta | null {
  if (!cacheExists()) return null;
  return readCacheJSON<CacheMeta>("meta.json");
}

export function readCacheJSON<T>(relativePath: string): T {
  const filePath = path.join(getCacheDir(), relativePath);
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

export function getCacheFilePath(relativePath: string): string {
  return path.resolve(getCacheDir(), relativePath);
}

/**
 * Ensure cache is available. Returns the CacheMeta or throws.
 */
export function ensureCacheLoaded(): CacheMeta {
  const meta = getCacheMeta();
  if (!meta) {
    throw new Error(
      "No cache available. Use swagger_load_spec to load a spec first, " +
        "or set SWAGGER_URL environment variable."
    );
  }
  return meta;
}

// ============================================================
// Cache Cleanup
// ============================================================

export function clearCache(): void {
  const cacheDir = getCacheDir();
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

// ============================================================
// Internal Helpers
// ============================================================

function writeJSON(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}
