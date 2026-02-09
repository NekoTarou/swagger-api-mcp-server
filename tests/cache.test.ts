import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  getCacheDir,
  endpointCacheFileName,
  schemaCacheFileName,
  generateCache,
  clearCache,
  cacheExists,
  getCacheMeta,
  readCacheJSON,
  getCacheFilePath,
  ensureCacheLoaded,
} from "../src/cache.js";
import type {
  CacheMeta,
  CacheInfo,
  CacheTag,
  CachePathEntry,
  CacheSchemaEntry,
  CacheEndpointDetail,
} from "../src/cache-types.js";

// ============================================================
// Test Fixtures
// ============================================================

const testCacheDir = path.resolve(".test-swagger-cache");

const swagger2Spec: Record<string, unknown> = {
  swagger: "2.0",
  info: { title: "Cache Test API", version: "1.0.0", description: "For testing cache" },
  host: "api.example.com",
  basePath: "/v1",
  schemes: ["https"],
  consumes: ["application/json"],
  produces: ["application/json"],
  tags: [
    { name: "users", description: "User operations" },
  ],
  securityDefinitions: {
    apiKey: { type: "apiKey", name: "X-API-Key", in: "header" },
  },
  definitions: {
    User: {
      type: "object",
      required: ["id", "name"],
      properties: {
        id: { type: "integer", format: "int64" },
        name: { type: "string" },
        email: { type: "string", format: "email" },
      },
    },
    Error: {
      type: "object",
      properties: {
        code: { type: "integer" },
        message: { type: "string" },
      },
    },
  },
  paths: {
    "/users": {
      get: {
        tags: ["users"],
        summary: "List users",
        operationId: "listUsers",
        parameters: [
          { name: "limit", in: "query", type: "integer", required: false },
        ],
        responses: {
          "200": {
            description: "Success",
            schema: { type: "array", items: { $ref: "#/definitions/User" } },
          },
        },
      },
      post: {
        tags: ["users"],
        summary: "Create user",
        operationId: "createUser",
        parameters: [
          { name: "body", in: "body", required: true, schema: { $ref: "#/definitions/User" } },
        ],
        responses: {
          "201": { description: "Created", schema: { $ref: "#/definitions/User" } },
        },
      },
    },
    "/users/{id}": {
      parameters: [
        { name: "id", in: "path", type: "integer", required: true },
      ],
      get: {
        tags: ["users"],
        summary: "Get user by ID",
        operationId: "getUser",
        responses: {
          "200": { description: "Success", schema: { $ref: "#/definitions/User" } },
        },
      },
    },
  },
};

const openapi3Spec: Record<string, unknown> = {
  openapi: "3.0.3",
  info: { title: "Cache Test API v3", version: "2.0.0" },
  servers: [{ url: "https://api.example.com/v2", description: "Production" }],
  tags: [{ name: "pets", description: "Pet operations" }],
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["name"],
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
        },
      },
    },
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
    },
  },
  paths: {
    "/pets": {
      get: {
        tags: ["pets"],
        summary: "List pets",
        operationId: "listPets",
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
              },
            },
          },
        },
      },
    },
  },
};

// ============================================================
// Setup / Teardown
// ============================================================

beforeEach(() => {
  process.env.CACHE_DIR = testCacheDir;
  clearCache();
});

afterEach(() => {
  clearCache();
  delete process.env.CACHE_DIR;
});

// ============================================================
// Path Helpers
// ============================================================

describe("getCacheDir", () => {
  it("returns CACHE_DIR env when set", () => {
    process.env.CACHE_DIR = "/tmp/my-cache";
    expect(getCacheDir()).toBe(path.resolve("/tmp/my-cache"));
    process.env.CACHE_DIR = testCacheDir;
  });

  it("returns default .swagger-cache when env not set", () => {
    delete process.env.CACHE_DIR;
    expect(getCacheDir()).toBe(path.resolve(".swagger-cache"));
    process.env.CACHE_DIR = testCacheDir;
  });
});

describe("endpointCacheFileName", () => {
  it("converts GET /users to GET__users.json", () => {
    expect(endpointCacheFileName("GET", "/users")).toBe("GET__users.json");
  });

  it("converts GET /users/{id} to GET__users__id.json", () => {
    expect(endpointCacheFileName("GET", "/users/{id}")).toBe("GET__users__id.json");
  });

  it("converts POST /users/{id}/orders to POST__users__id__orders.json", () => {
    expect(endpointCacheFileName("POST", "/users/{id}/orders")).toBe("POST__users__id__orders.json");
  });

  it("uppercases method", () => {
    expect(endpointCacheFileName("get", "/pets")).toBe("GET__pets.json");
  });
});

describe("schemaCacheFileName", () => {
  it("converts simple name", () => {
    expect(schemaCacheFileName("User")).toBe("User.json");
  });

  it("sanitizes special characters", () => {
    expect(schemaCacheFileName("My Schema/V2")).toBe("My_Schema_V2.json");
  });
});

// ============================================================
// Cache Generation — Swagger 2.0
// ============================================================

describe("generateCache (Swagger 2.0)", () => {
  it("creates cache directory structure", async () => {
    await generateCache(swagger2Spec, "https://example.com/swagger.json");

    expect(fs.existsSync(testCacheDir)).toBe(true);
    expect(fs.existsSync(path.join(testCacheDir, "meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(testCacheDir, "info.json"))).toBe(true);
    expect(fs.existsSync(path.join(testCacheDir, "tags.json"))).toBe(true);
    expect(fs.existsSync(path.join(testCacheDir, "paths-index.json"))).toBe(true);
    expect(fs.existsSync(path.join(testCacheDir, "schemas-index.json"))).toBe(true);
    expect(fs.existsSync(path.join(testCacheDir, "endpoints"))).toBe(true);
    expect(fs.existsSync(path.join(testCacheDir, "schemas"))).toBe(true);
  });

  it("returns correct CacheMeta", async () => {
    const meta = await generateCache(swagger2Spec, "https://example.com/swagger.json");

    expect(meta.specUrl).toBe("https://example.com/swagger.json");
    expect(meta.specTitle).toBe("Cache Test API");
    expect(meta.specVersion).toBe("1.0.0");
    expect(meta.specFormat).toBe("Swagger 2.0");
    expect(meta.endpointCount).toBe(3);
    expect(meta.schemaCount).toBe(2);
    expect(meta.tagCount).toBe(1);
    expect(meta.cachedAt).toBeTruthy();
    expect(meta.cacheDir).toBe(path.resolve(testCacheDir));
  });

  it("writes correct meta.json", async () => {
    await generateCache(swagger2Spec, "https://example.com/swagger.json");
    const meta = readCacheJSON<CacheMeta>("meta.json");

    expect(meta.specUrl).toBe("https://example.com/swagger.json");
    expect(meta.endpointCount).toBe(3);
    expect(meta.schemaCount).toBe(2);
  });

  it("writes correct info.json", async () => {
    await generateCache(swagger2Spec, "https://example.com/swagger.json");
    const info = readCacheJSON<CacheInfo>("info.json");

    expect(info.title).toBe("Cache Test API");
    expect(info.version).toBe("1.0.0");
    expect(info.description).toBe("For testing cache");
    expect(info.specFormat).toBe("Swagger 2.0");
    expect(info.servers).toHaveLength(1);
    expect(info.servers[0].url).toBe("https://api.example.com/v1");
    expect(info.securitySchemes).toHaveProperty("apiKey");
  });

  it("writes correct tags.json", async () => {
    await generateCache(swagger2Spec, "https://example.com/swagger.json");
    const tags = readCacheJSON<CacheTag[]>("tags.json");

    expect(tags).toHaveLength(1);
    expect(tags[0].name).toBe("users");
    expect(tags[0].description).toBe("User operations");
    expect(tags[0].endpointCount).toBe(3);
  });

  it("writes correct paths-index.json", async () => {
    await generateCache(swagger2Spec, "https://example.com/swagger.json");
    const index = readCacheJSON<CachePathEntry[]>("paths-index.json");

    expect(index).toHaveLength(3);

    const getUsers = index.find((e) => e.method === "GET" && e.path === "/users");
    expect(getUsers).toBeDefined();
    expect(getUsers!.summary).toBe("List users");
    expect(getUsers!.operationId).toBe("listUsers");
    expect(getUsers!.tags).toEqual(["users"]);
    expect(getUsers!.cacheFile).toBe("endpoints/GET__users.json");

    const postUsers = index.find((e) => e.method === "POST" && e.path === "/users");
    expect(postUsers).toBeDefined();
    expect(postUsers!.operationId).toBe("createUser");
  });

  it("writes correct schemas-index.json", async () => {
    await generateCache(swagger2Spec, "https://example.com/swagger.json");
    const index = readCacheJSON<CacheSchemaEntry[]>("schemas-index.json");

    expect(index).toHaveLength(2);

    const userSchema = index.find((e) => e.name === "User");
    expect(userSchema).toBeDefined();
    expect(userSchema!.type).toBe("object");
    expect(userSchema!.propertyCount).toBe(3);
    expect(userSchema!.cacheFile).toBe("schemas/User.json");
  });

  it("writes individual endpoint files", async () => {
    await generateCache(swagger2Spec, "https://example.com/swagger.json");

    const filePath = path.join(testCacheDir, "endpoints", "GET__users.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const detail = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CacheEndpointDetail;
    expect(detail.method).toBe("GET");
    expect(detail.path).toBe("/users");
    expect(detail.summary).toBe("List users");
    expect(detail.parameters).toHaveLength(1);
    expect(detail.parameters[0].name).toBe("limit");
  });

  it("writes individual schema files with resolved $refs", async () => {
    await generateCache(swagger2Spec, "https://example.com/swagger.json");

    const filePath = path.join(testCacheDir, "schemas", "User.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const schema = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    expect(schema["type"]).toBe("object");
    expect(schema["properties"]).toBeDefined();
    expect(schema["required"]).toEqual(["id", "name"]);
  });
});

// ============================================================
// Cache Generation — OpenAPI 3.x
// ============================================================

describe("generateCache (OpenAPI 3.x)", () => {
  it("creates correct cache for OpenAPI 3.x spec", async () => {
    const meta = await generateCache(openapi3Spec, "https://example.com/openapi.json");

    expect(meta.specFormat).toBe("OpenAPI 3.0.3");
    expect(meta.endpointCount).toBe(1);
    expect(meta.schemaCount).toBe(1);
  });

  it("writes correct info.json for OpenAPI 3.x", async () => {
    await generateCache(openapi3Spec, "https://example.com/openapi.json");
    const info = readCacheJSON<CacheInfo>("info.json");

    expect(info.title).toBe("Cache Test API v3");
    expect(info.servers).toHaveLength(1);
    expect(info.servers[0].url).toBe("https://api.example.com/v2");
    expect(info.servers[0].description).toBe("Production");
    expect(info.securitySchemes).toHaveProperty("bearerAuth");
  });

  it("resolves $ref in endpoint responses", async () => {
    await generateCache(openapi3Spec, "https://example.com/openapi.json");

    const filePath = path.join(testCacheDir, "endpoints", "GET__pets.json");
    const detail = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CacheEndpointDetail;

    expect(detail.responses).toHaveLength(1);
    const resp200 = detail.responses[0];
    expect(resp200.statusCode).toBe("200");
    expect(resp200.content).toBeDefined();
    // The $ref should be resolved in the response schema
    const jsonContent = resp200.content!["application/json"];
    expect(jsonContent.schema).toBeDefined();
  });
});

// ============================================================
// Cache Reading
// ============================================================

describe("cacheExists", () => {
  it("returns false when no cache", () => {
    expect(cacheExists()).toBe(false);
  });

  it("returns true after generation", async () => {
    await generateCache(swagger2Spec, "https://example.com/swagger.json");
    expect(cacheExists()).toBe(true);
  });
});

describe("getCacheMeta", () => {
  it("returns null when no cache", () => {
    expect(getCacheMeta()).toBeNull();
  });

  it("returns meta after generation", async () => {
    await generateCache(swagger2Spec, "https://example.com/swagger.json");
    const meta = getCacheMeta();
    expect(meta).not.toBeNull();
    expect(meta!.specTitle).toBe("Cache Test API");
  });
});

describe("readCacheJSON", () => {
  it("reads and parses cache file", async () => {
    await generateCache(swagger2Spec, "https://example.com/swagger.json");
    const tags = readCacheJSON<CacheTag[]>("tags.json");
    expect(Array.isArray(tags)).toBe(true);
    expect(tags.length).toBeGreaterThan(0);
  });

  it("throws on missing file", () => {
    expect(() => readCacheJSON("nonexistent.json")).toThrow();
  });
});

describe("getCacheFilePath", () => {
  it("returns absolute path", () => {
    const p = getCacheFilePath("endpoints/GET__users.json");
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toContain("endpoints");
  });
});

describe("ensureCacheLoaded", () => {
  it("throws when no cache", () => {
    expect(() => ensureCacheLoaded()).toThrow("No cache available");
  });

  it("returns meta when cache exists", async () => {
    await generateCache(swagger2Spec, "https://example.com/swagger.json");
    const meta = ensureCacheLoaded();
    expect(meta.specTitle).toBe("Cache Test API");
  });
});

// ============================================================
// Cache Cleanup
// ============================================================

describe("clearCache", () => {
  it("removes cache directory", async () => {
    await generateCache(swagger2Spec, "https://example.com/swagger.json");
    expect(fs.existsSync(testCacheDir)).toBe(true);

    clearCache();
    expect(fs.existsSync(testCacheDir)).toBe(false);
  });

  it("does not throw when no cache exists", () => {
    expect(() => clearCache()).not.toThrow();
  });
});

// ============================================================
// Overwrite / Regeneration
// ============================================================

describe("cache overwrite", () => {
  it("overwrites existing cache with new spec", async () => {
    await generateCache(swagger2Spec, "https://example.com/swagger.json");
    const meta1 = getCacheMeta()!;
    expect(meta1.specTitle).toBe("Cache Test API");
    expect(meta1.endpointCount).toBe(3);

    await generateCache(openapi3Spec, "https://example.com/openapi.json");
    const meta2 = getCacheMeta()!;
    expect(meta2.specTitle).toBe("Cache Test API v3");
    expect(meta2.endpointCount).toBe(1);
    expect(meta2.specUrl).toBe("https://example.com/openapi.json");
  });
});
