import { describe, it, expect } from "vitest";
import {
  resolveRef,
  deepResolve,
  refToName,
  getSpecVersion,
  getSchemas,
  getServers,
  getSecuritySchemes,
  getTags,
  getPaths,
  extractOperations,
  extractParameters,
  extractRequestBody,
  extractResponses,
  formatSchemaType,
  formatSchemaProperties,
  formatEndpointMarkdown,
  handleError,
  truncateIfNeeded,
  CHARACTER_LIMIT,
} from "../src/utils.js";

// ============================================================
// Test Fixtures
// ============================================================

const swagger2Spec: Record<string, unknown> = {
  swagger: "2.0",
  info: { title: "Test API", version: "1.0.0", description: "A test API" },
  host: "api.example.com",
  basePath: "/v1",
  schemes: ["https"],
  consumes: ["application/json"],
  produces: ["application/json"],
  tags: [
    { name: "users", description: "User operations" },
    { name: "admin", description: "Admin operations" },
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
        name: { type: "string", description: "User name" },
        email: { type: "string", format: "email" },
        role: { type: "string", enum: ["admin", "user", "guest"], default: "user" },
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
          { name: "limit", in: "query", type: "integer", required: false, description: "Max results" },
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
          "400": { description: "Bad request", schema: { $ref: "#/definitions/Error" } },
        },
      },
    },
    "/users/{id}": {
      parameters: [
        { name: "id", in: "path", type: "integer", required: true, description: "User ID" },
      ],
      get: {
        tags: ["users"],
        summary: "Get user by ID",
        operationId: "getUser",
        deprecated: true,
        responses: {
          "200": { description: "Success", schema: { $ref: "#/definitions/User" } },
          "404": { description: "Not found" },
        },
      },
      delete: {
        tags: ["users", "admin"],
        summary: "Delete user",
        operationId: "deleteUser",
        security: [{ apiKey: [] }],
        responses: {
          "204": { description: "Deleted" },
        },
      },
    },
  },
};

const openapi3Spec: Record<string, unknown> = {
  openapi: "3.0.3",
  info: { title: "Test API v3", version: "2.0.0" },
  servers: [
    { url: "https://api.example.com/v2", description: "Production" },
    { url: "http://localhost:3000", description: "Local" },
  ],
  tags: [{ name: "pets", description: "Pet operations" }],
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["name"],
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          tag: { type: "string" },
        },
      },
    },
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
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
      post: {
        tags: ["pets"],
        summary: "Create pet",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Pet" },
            },
          },
        },
        responses: {
          "201": { description: "Created" },
        },
      },
    },
  },
};

// ============================================================
// $ref Resolution
// ============================================================

describe("resolveRef", () => {
  it("resolves a valid $ref in Swagger 2.0", () => {
    const result = resolveRef(swagger2Spec, "#/definitions/User");
    expect(result).toBeDefined();
    expect((result as Record<string, unknown>)["type"]).toBe("object");
  });

  it("resolves a valid $ref in OpenAPI 3.x", () => {
    const result = resolveRef(openapi3Spec, "#/components/schemas/Pet");
    expect(result).toBeDefined();
    expect((result as Record<string, unknown>)["type"]).toBe("object");
  });

  it("returns undefined for non-existent $ref", () => {
    expect(resolveRef(swagger2Spec, "#/definitions/NonExistent")).toBeUndefined();
  });

  it("returns undefined for non-hash $ref", () => {
    expect(resolveRef(swagger2Spec, "external.json#/foo")).toBeUndefined();
  });
});

describe("deepResolve", () => {
  it("resolves nested $ref", () => {
    const obj = { schema: { $ref: "#/definitions/User" } };
    const resolved = deepResolve(swagger2Spec, obj) as Record<string, unknown>;
    const schema = resolved["schema"] as Record<string, unknown>;
    expect(schema["type"]).toBe("object");
    expect(schema["properties"]).toBeDefined();
  });

  it("handles circular $ref without infinite loop", () => {
    const circularSpec: Record<string, unknown> = {
      definitions: {
        Node: {
          type: "object",
          properties: {
            child: { $ref: "#/definitions/Node" },
          },
        },
      },
    };
    const result = deepResolve(circularSpec, { $ref: "#/definitions/Node" }) as Record<string, unknown>;
    expect(result["type"]).toBe("object");
    // child should eventually become a circular ref marker
    const props = result["properties"] as Record<string, unknown>;
    const child = props["child"] as Record<string, unknown>;
    expect(child["$circular_ref"]).toBe("#/definitions/Node");
  });

  it("returns primitives unchanged", () => {
    expect(deepResolve(swagger2Spec, "hello")).toBe("hello");
    expect(deepResolve(swagger2Spec, 42)).toBe(42);
    expect(deepResolve(swagger2Spec, null)).toBeNull();
    expect(deepResolve(swagger2Spec, undefined)).toBeUndefined();
  });

  it("resolves arrays", () => {
    const arr = [{ $ref: "#/definitions/User" }, { $ref: "#/definitions/Error" }];
    const resolved = deepResolve(swagger2Spec, arr) as Array<Record<string, unknown>>;
    expect(resolved).toHaveLength(2);
    expect(resolved[0]["type"]).toBe("object");
  });
});

describe("refToName", () => {
  it("extracts name from Swagger 2.0 ref", () => {
    expect(refToName("#/definitions/User")).toBe("User");
  });

  it("extracts name from OpenAPI 3.x ref", () => {
    expect(refToName("#/components/schemas/Pet")).toBe("Pet");
  });
});

// ============================================================
// Spec Version Helpers
// ============================================================

describe("getSpecVersion", () => {
  it("detects Swagger 2.0", () => {
    expect(getSpecVersion(swagger2Spec)).toBe("2.0");
  });

  it("detects OpenAPI 3.0", () => {
    expect(getSpecVersion(openapi3Spec)).toBe("3.0");
  });

  it("detects OpenAPI 3.1", () => {
    expect(getSpecVersion({ openapi: "3.1.0" })).toBe("3.1");
  });

  it("returns unknown for unrecognized", () => {
    expect(getSpecVersion({})).toBe("unknown");
  });
});

describe("getSchemas", () => {
  it("returns definitions for Swagger 2.0", () => {
    const schemas = getSchemas(swagger2Spec);
    expect(Object.keys(schemas)).toContain("User");
    expect(Object.keys(schemas)).toContain("Error");
  });

  it("returns components.schemas for OpenAPI 3.x", () => {
    const schemas = getSchemas(openapi3Spec);
    expect(Object.keys(schemas)).toContain("Pet");
  });

  it("returns empty object when no schemas", () => {
    expect(getSchemas({ swagger: "2.0" })).toEqual({});
  });
});

describe("getServers", () => {
  it("constructs server URL from Swagger 2.0 host/basePath", () => {
    const servers = getServers(swagger2Spec);
    expect(servers).toHaveLength(1);
    expect(servers[0].url).toBe("https://api.example.com/v1");
  });

  it("returns servers array for OpenAPI 3.x", () => {
    const servers = getServers(openapi3Spec);
    expect(servers).toHaveLength(2);
    expect(servers[0].url).toBe("https://api.example.com/v2");
  });
});

describe("getSecuritySchemes", () => {
  it("returns securityDefinitions for Swagger 2.0", () => {
    const schemes = getSecuritySchemes(swagger2Spec);
    expect(schemes).toHaveProperty("apiKey");
  });

  it("returns components.securitySchemes for OpenAPI 3.x", () => {
    const schemes = getSecuritySchemes(openapi3Spec);
    expect(schemes).toHaveProperty("bearerAuth");
  });
});

describe("getTags", () => {
  it("returns tags from Swagger 2.0", () => {
    const tags = getTags(swagger2Spec);
    expect(tags).toHaveLength(2);
    expect(tags[0].name).toBe("users");
  });

  it("returns tags from OpenAPI 3.x", () => {
    const tags = getTags(openapi3Spec);
    expect(tags).toHaveLength(1);
    expect(tags[0].name).toBe("pets");
  });

  it("returns empty array when no tags", () => {
    expect(getTags({})).toEqual([]);
  });
});

describe("getPaths", () => {
  it("returns paths object", () => {
    const paths = getPaths(swagger2Spec);
    expect(Object.keys(paths)).toContain("/users");
    expect(Object.keys(paths)).toContain("/users/{id}");
  });
});

// ============================================================
// Operation Extraction
// ============================================================

describe("extractOperations", () => {
  it("extracts all operations from Swagger 2.0", () => {
    const ops = extractOperations(swagger2Spec);
    expect(ops).toHaveLength(4); // GET/POST /users + GET/DELETE /users/{id}
    expect(ops[0].method).toBe("GET");
    expect(ops[0].path).toBe("/users");
  });

  it("extracts all operations from OpenAPI 3.x", () => {
    const ops = extractOperations(openapi3Spec);
    expect(ops).toHaveLength(2); // GET/POST /pets
  });
});

describe("extractParameters", () => {
  it("merges path-level and operation-level params (Swagger 2.0)", () => {
    const paths = getPaths(swagger2Spec);
    const getUserOp = (paths["/users/{id}"] as Record<string, unknown>)["get"] as Record<string, unknown>;
    const params = extractParameters(swagger2Spec, "/users/{id}", getUserOp);
    // path-level "id" param should be included
    expect(params.some((p) => p.name === "id" && p.in === "path")).toBe(true);
  });

  it("extracts query parameters (OpenAPI 3.x)", () => {
    const paths = getPaths(openapi3Spec);
    const listPetsOp = (paths["/pets"] as Record<string, unknown>)["get"] as Record<string, unknown>;
    const params = extractParameters(openapi3Spec, "/pets", listPetsOp);
    expect(params).toHaveLength(1);
    expect(params[0].name).toBe("limit");
    expect(params[0].in).toBe("query");
  });
});

describe("extractRequestBody", () => {
  it("extracts body parameter from Swagger 2.0", () => {
    const paths = getPaths(swagger2Spec);
    const createUserOp = (paths["/users"] as Record<string, unknown>)["post"] as Record<string, unknown>;
    const body = extractRequestBody(swagger2Spec, createUserOp);
    expect(body).toBeDefined();
    expect(body!.content["application/json"]).toBeDefined();
  });

  it("extracts requestBody from OpenAPI 3.x", () => {
    const paths = getPaths(openapi3Spec);
    const createPetOp = (paths["/pets"] as Record<string, unknown>)["post"] as Record<string, unknown>;
    const body = extractRequestBody(openapi3Spec, createPetOp);
    expect(body).toBeDefined();
    expect(body!.required).toBe(true);
    expect(body!.content["application/json"]).toBeDefined();
  });

  it("returns undefined when no body", () => {
    const paths = getPaths(swagger2Spec);
    const listUsersOp = (paths["/users"] as Record<string, unknown>)["get"] as Record<string, unknown>;
    const body = extractRequestBody(swagger2Spec, listUsersOp);
    expect(body).toBeUndefined();
  });
});

describe("extractResponses", () => {
  it("extracts responses from Swagger 2.0", () => {
    const paths = getPaths(swagger2Spec);
    const createUserOp = (paths["/users"] as Record<string, unknown>)["post"] as Record<string, unknown>;
    const responses = extractResponses(swagger2Spec, createUserOp);
    expect(responses).toHaveLength(2);
    expect(responses.map((r) => r.statusCode)).toContain("201");
    expect(responses.map((r) => r.statusCode)).toContain("400");
  });

  it("extracts responses from OpenAPI 3.x", () => {
    const paths = getPaths(openapi3Spec);
    const listPetsOp = (paths["/pets"] as Record<string, unknown>)["get"] as Record<string, unknown>;
    const responses = extractResponses(openapi3Spec, listPetsOp);
    expect(responses).toHaveLength(1);
    expect(responses[0].statusCode).toBe("200");
    expect(responses[0].content).toBeDefined();
  });
});

// ============================================================
// Formatting Helpers
// ============================================================

describe("formatSchemaType", () => {
  it("formats primitive types", () => {
    expect(formatSchemaType({ type: "string" })).toBe("string");
    expect(formatSchemaType({ type: "integer", format: "int64" })).toBe("integer(int64)");
  });

  it("formats array types", () => {
    expect(formatSchemaType({ type: "array", items: { type: "string" } })).toBe("string[]");
  });

  it("formats enum types", () => {
    expect(formatSchemaType({ enum: ["a", "b"] })).toBe('"a" | "b"');
  });

  it("returns unknown for undefined", () => {
    expect(formatSchemaType(undefined)).toBe("unknown");
  });

  it("formats $ref types", () => {
    expect(formatSchemaType({ $ref: "#/definitions/User" })).toBe("User");
  });

  it("formats allOf/oneOf", () => {
    expect(formatSchemaType({ allOf: [{ type: "string" }, { type: "integer" }] })).toBe("string & integer");
    expect(formatSchemaType({ oneOf: [{ type: "string" }, { type: "integer" }] })).toBe("string | integer");
  });
});

describe("formatSchemaProperties", () => {
  it("formats properties with required marker", () => {
    const schema = {
      type: "object" as const,
      required: ["name"],
      properties: {
        name: { type: "string" as const, description: "The name" },
        age: { type: "integer" as const },
      },
    };
    const result = formatSchemaProperties(schema);
    expect(result).toContain("**name**");
    expect(result).toContain("*required*");
    expect(result).toContain("The name");
    expect(result).toContain("**age**");
  });
});

describe("formatEndpointMarkdown", () => {
  it("formats an endpoint detail", () => {
    const detail = {
      method: "GET",
      path: "/users/{id}",
      summary: "Get a user",
      operationId: "getUser",
      tags: ["users"],
      deprecated: true,
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "integer" as const } },
      ],
      responses: [
        { statusCode: "200", description: "Success" },
      ],
    };
    const md = formatEndpointMarkdown(detail);
    expect(md).toContain("GET /users/{id}");
    expect(md).toContain("DEPRECATED");
    expect(md).toContain("getUser");
    expect(md).toContain("Parameters");
    expect(md).toContain("Responses");
  });
});

// ============================================================
// Error Handling & Truncation
// ============================================================

describe("handleError", () => {
  it("formats Error objects", () => {
    expect(handleError(new Error("test"))).toBe("Error: test");
  });

  it("formats non-Error values", () => {
    expect(handleError("some string")).toBe("Error: some string");
  });
});

describe("truncateIfNeeded", () => {
  it("returns short text unchanged", () => {
    expect(truncateIfNeeded("hello")).toBe("hello");
  });

  it("truncates long text", () => {
    const long = "a".repeat(CHARACTER_LIMIT + 100);
    const result = truncateIfNeeded(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain("truncated");
  });
});
