import type {
  SchemaObject,
  ParameterInfo,
  EndpointDetail,
  ResponseInfo,
} from "./types.js";

// ============================================================
// $ref Resolution
// ============================================================

/**
 * Resolve a JSON $ref pointer (e.g. "#/components/schemas/User") against a spec.
 */
export function resolveRef(spec: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref
    .slice(2)
    .split("/")
    .map((p) => decodeURIComponent(p.replace(/~1/g, "/").replace(/~0/g, "~")));
  let current: unknown = spec;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Deep-resolve all $ref pointers in an object.
 * Tracks visited refs to avoid infinite loops from circular references.
 */
export function deepResolve(
  spec: Record<string, unknown>,
  obj: unknown,
  visited: Set<string> = new Set(),
  depth: number = 0
): unknown {
  if (depth > 20) return obj; // safety limit
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => deepResolve(spec, item, visited, depth + 1));
  }

  const record = obj as Record<string, unknown>;
  if (typeof record["$ref"] === "string") {
    const ref = record["$ref"];
    if (visited.has(ref)) {
      return { $circular_ref: ref };
    }
    visited.add(ref);
    const resolved = resolveRef(spec, ref);
    if (resolved !== undefined) {
      return deepResolve(spec, resolved, new Set(visited), depth + 1);
    }
    return record;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = deepResolve(spec, value, new Set(visited), depth + 1);
  }
  return result;
}

/**
 * Extract the schema name from a $ref string.
 * e.g. "#/components/schemas/User" => "User"
 *      "#/definitions/User" => "User"
 */
export function refToName(ref: string): string {
  const parts = ref.split("/");
  return parts[parts.length - 1];
}

// ============================================================
// Spec Version Helpers
// ============================================================

export function getSpecVersion(
  spec: Record<string, unknown>
): "2.0" | "3.0" | "3.1" | "unknown" {
  if (spec["swagger"] === "2.0") return "2.0";
  const openapi = spec["openapi"] as string | undefined;
  if (openapi?.startsWith("3.1")) return "3.1";
  if (openapi?.startsWith("3.0") || openapi?.startsWith("3.")) return "3.0";
  return "unknown";
}

export function getSchemas(
  spec: Record<string, unknown>
): Record<string, SchemaObject> {
  const version = getSpecVersion(spec);
  if (version === "2.0") {
    return (spec["definitions"] as Record<string, SchemaObject>) ?? {};
  }
  const components = spec["components"] as Record<string, unknown> | undefined;
  return (components?.["schemas"] as Record<string, SchemaObject>) ?? {};
}

export function getServers(
  spec: Record<string, unknown>
): Array<{ url: string; description?: string }> {
  const version = getSpecVersion(spec);
  if (version === "2.0") {
    const host = (spec["host"] as string) ?? "localhost";
    const basePath = (spec["basePath"] as string) ?? "/";
    const schemes = (spec["schemes"] as string[]) ?? ["https"];
    return [{ url: `${schemes[0]}://${host}${basePath}`, description: "API Server" }];
  }
  return (spec["servers"] as Array<{ url: string; description?: string }>) ?? [];
}

export function getSecuritySchemes(
  spec: Record<string, unknown>
): Record<string, unknown> {
  const version = getSpecVersion(spec);
  if (version === "2.0") {
    return (spec["securityDefinitions"] as Record<string, unknown>) ?? {};
  }
  const components = spec["components"] as Record<string, unknown> | undefined;
  return (components?.["securitySchemes"] as Record<string, unknown>) ?? {};
}

export function getTags(spec: Record<string, unknown>): Array<{ name: string; description?: string }> {
  return (spec["tags"] as Array<{ name: string; description?: string }>) ?? [];
}

export function getPaths(
  spec: Record<string, unknown>
): Record<string, Record<string, unknown>> {
  return (spec["paths"] as Record<string, Record<string, unknown>>) ?? {};
}

// ============================================================
// Operation Extraction Helpers
// ============================================================

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head", "options", "trace"];

export function extractOperations(
  spec: Record<string, unknown>
): Array<{ path: string; method: string; operation: Record<string, unknown> }> {
  const paths = getPaths(spec);
  const operations: Array<{
    path: string;
    method: string;
    operation: Record<string, unknown>;
  }> = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method];
      if (op && typeof op === "object") {
        operations.push({
          path,
          method: method.toUpperCase(),
          operation: op as Record<string, unknown>,
        });
      }
    }
  }
  return operations;
}

/**
 * Extract parameters from an operation, merging path-level and operation-level params.
 * Handles both Swagger 2.0 and OpenAPI 3.x parameter formats.
 */
export function extractParameters(
  spec: Record<string, unknown>,
  path: string,
  operation: Record<string, unknown>
): ParameterInfo[] {
  const pathItem = getPaths(spec)[path] as Record<string, unknown> | undefined;
  const pathParams = (pathItem?.["parameters"] as unknown[]) ?? [];
  const opParams = (operation["parameters"] as unknown[]) ?? [];

  // Operation params override path params (by name + in)
  const merged = new Map<string, ParameterInfo>();

  for (const raw of [...pathParams, ...opParams]) {
    const param = deepResolve(spec, raw) as Record<string, unknown>;
    if (!param || typeof param !== "object") continue;

    const name = param["name"] as string;
    const location = param["in"] as string;
    if (!name || !location) continue;

    const schema = param["schema"]
      ? (deepResolve(spec, param["schema"]) as SchemaObject)
      : extractSwagger2ParamSchema(param);

    merged.set(`${location}:${name}`, {
      name,
      in: location,
      required: (param["required"] as boolean) ?? (location === "path"),
      description: param["description"] as string | undefined,
      schema,
      deprecated: param["deprecated"] as boolean | undefined,
    });
  }
  return Array.from(merged.values());
}

/**
 * For Swagger 2.0, parameter schema is inline (type, format, etc.).
 */
function extractSwagger2ParamSchema(
  param: Record<string, unknown>
): SchemaObject {
  return {
    type: param["type"] as string | undefined,
    format: param["format"] as string | undefined,
    enum: param["enum"] as unknown[] | undefined,
    default: param["default"],
    minimum: param["minimum"] as number | undefined,
    maximum: param["maximum"] as number | undefined,
    items: param["items"] as SchemaObject | undefined,
  };
}

/**
 * Extract request body. Handles both Swagger 2.0 (body param) and OpenAPI 3.x (requestBody).
 */
export function extractRequestBody(
  spec: Record<string, unknown>,
  operation: Record<string, unknown>
): { description?: string; required?: boolean; content: Record<string, { schema?: SchemaObject }> } | undefined {
  const version = getSpecVersion(spec);

  if (version === "2.0") {
    // In Swagger 2.0, body params are defined in parameters with in: "body"
    const params = (operation["parameters"] as unknown[]) ?? [];
    for (const raw of params) {
      const param = deepResolve(spec, raw) as Record<string, unknown>;
      if (param?.["in"] === "body") {
        const schema = deepResolve(spec, param["schema"]) as SchemaObject | undefined;
        const consumes = (operation["consumes"] as string[]) ??
          (spec["consumes"] as string[]) ?? ["application/json"];
        const content: Record<string, { schema?: SchemaObject }> = {};
        for (const ct of consumes) {
          content[ct] = { schema };
        }
        return {
          description: param["description"] as string | undefined,
          required: param["required"] as boolean | undefined,
          content,
        };
      }
    }
    // Check for formData parameters
    const formParams = params
      .map((raw) => deepResolve(spec, raw) as Record<string, unknown>)
      .filter((p) => p?.["in"] === "formData");
    if (formParams.length > 0) {
      const properties: Record<string, SchemaObject> = {};
      const required: string[] = [];
      for (const fp of formParams) {
        const name = fp["name"] as string;
        properties[name] = extractSwagger2ParamSchema(fp);
        if (fp["required"]) required.push(name);
      }
      const consumes = (operation["consumes"] as string[]) ??
        (spec["consumes"] as string[]) ?? ["application/x-www-form-urlencoded"];
      const content: Record<string, { schema?: SchemaObject }> = {};
      for (const ct of consumes) {
        content[ct] = {
          schema: { type: "object", properties, required: required.length > 0 ? required : undefined },
        };
      }
      return { content };
    }
    return undefined;
  }

  // OpenAPI 3.x
  const requestBody = operation["requestBody"]
    ? (deepResolve(spec, operation["requestBody"]) as Record<string, unknown>)
    : undefined;
  if (!requestBody) return undefined;

  const content = requestBody["content"] as Record<string, Record<string, unknown>> | undefined;
  if (!content) return undefined;

  const resolvedContent: Record<string, { schema?: SchemaObject }> = {};
  for (const [mediaType, mediaObj] of Object.entries(content)) {
    resolvedContent[mediaType] = {
      schema: mediaObj["schema"]
        ? (deepResolve(spec, mediaObj["schema"]) as SchemaObject)
        : undefined,
    };
  }

  return {
    description: requestBody["description"] as string | undefined,
    required: requestBody["required"] as boolean | undefined,
    content: resolvedContent,
  };
}

/**
 * Extract responses from an operation.
 */
export function extractResponses(
  spec: Record<string, unknown>,
  operation: Record<string, unknown>
): ResponseInfo[] {
  const responses = operation["responses"] as Record<string, unknown> | undefined;
  if (!responses) return [];

  const result: ResponseInfo[] = [];
  for (const [statusCode, rawResp] of Object.entries(responses)) {
    const resp = deepResolve(spec, rawResp) as Record<string, unknown>;
    if (!resp || typeof resp !== "object") continue;

    const version = getSpecVersion(spec);
    let content: Record<string, { schema?: SchemaObject }> | undefined;

    if (version === "2.0") {
      // Swagger 2.0: schema is directly on the response
      const schema = resp["schema"]
        ? (deepResolve(spec, resp["schema"]) as SchemaObject)
        : undefined;
      if (schema) {
        const produces = (spec["produces"] as string[]) ?? ["application/json"];
        content = {};
        for (const ct of produces) {
          content[ct] = { schema };
        }
      }
    } else {
      // OpenAPI 3.x: content with media types
      const rawContent = resp["content"] as Record<string, Record<string, unknown>> | undefined;
      if (rawContent) {
        content = {};
        for (const [mediaType, mediaObj] of Object.entries(rawContent)) {
          content[mediaType] = {
            schema: mediaObj["schema"]
              ? (deepResolve(spec, mediaObj["schema"]) as SchemaObject)
              : undefined,
          };
        }
      }
    }

    result.push({
      statusCode,
      description: resp["description"] as string | undefined,
      content,
    });
  }
  return result;
}

// ============================================================
// Formatting Helpers
// ============================================================

/**
 * Format a schema object into a readable string representation.
 */
export function formatSchemaType(schema: SchemaObject | undefined, depth: number = 0): string {
  if (!schema) return "unknown";
  if (depth > 5) return "...";

  if (schema.$ref) return refToName(schema.$ref);
  if (schema.allOf) {
    return schema.allOf.map((s) => formatSchemaType(s, depth + 1)).join(" & ");
  }
  if (schema.oneOf) {
    return schema.oneOf.map((s) => formatSchemaType(s, depth + 1)).join(" | ");
  }
  if (schema.anyOf) {
    return schema.anyOf.map((s) => formatSchemaType(s, depth + 1)).join(" | ");
  }

  if (schema.type === "array") {
    const itemType = formatSchemaType(schema.items, depth + 1);
    return `${itemType}[]`;
  }

  if (schema.type === "object" && schema.properties) {
    if (depth > 2) return "object";
    const props = Object.entries(schema.properties)
      .map(([k, v]) => `${k}: ${formatSchemaType(v, depth + 1)}`)
      .join(", ");
    return `{ ${props} }`;
  }

  if (schema.enum) {
    return schema.enum.map((e) => JSON.stringify(e)).join(" | ");
  }

  const base = schema.type ?? "unknown";
  return schema.format ? `${base}(${schema.format})` : base;
}

/**
 * Format a schema's properties into a detailed table-like string.
 */
export function formatSchemaProperties(
  schema: SchemaObject,
  indent: string = ""
): string {
  if (!schema.properties) return `${indent}(no properties)`;
  const requiredSet = new Set(schema.required ?? []);
  const lines: string[] = [];

  for (const [name, prop] of Object.entries(schema.properties)) {
    const req = requiredSet.has(name) ? " *required*" : "";
    const type = formatSchemaType(prop);
    const desc = prop.description ? ` — ${prop.description}` : "";
    const enumStr = prop.enum ? ` [enum: ${prop.enum.join(", ")}]` : "";
    const defaultStr = prop.default !== undefined ? ` (default: ${JSON.stringify(prop.default)})` : "";
    lines.push(`${indent}- **${name}**: \`${type}\`${req}${enumStr}${defaultStr}${desc}`);
  }
  return lines.join("\n");
}

/**
 * Format endpoint details as markdown.
 */
export function formatEndpointMarkdown(detail: EndpointDetail): string {
  const lines: string[] = [];
  const badge = detail.deprecated ? " ~~DEPRECATED~~" : "";
  lines.push(`## ${detail.method} ${detail.path}${badge}`);
  lines.push("");

  if (detail.summary) lines.push(`**Summary:** ${detail.summary}`);
  if (detail.description) lines.push(`**Description:** ${detail.description}`);
  if (detail.operationId) lines.push(`**Operation ID:** \`${detail.operationId}\``);
  if (detail.tags?.length) lines.push(`**Tags:** ${detail.tags.join(", ")}`);
  lines.push("");

  // Parameters
  if (detail.parameters.length > 0) {
    lines.push("### Parameters");
    lines.push("");
    for (const param of detail.parameters) {
      const req = param.required ? " *required*" : "";
      const type = formatSchemaType(param.schema);
      const desc = param.description ? ` — ${param.description}` : "";
      const depStr = param.deprecated ? " ~~deprecated~~" : "";
      lines.push(`- **${param.name}** (in: \`${param.in}\`, type: \`${type}\`)${req}${depStr}${desc}`);
    }
    lines.push("");
  }

  // Request Body
  if (detail.requestBody) {
    lines.push("### Request Body");
    if (detail.requestBody.description) {
      lines.push(`${detail.requestBody.description}`);
    }
    if (detail.requestBody.required) {
      lines.push("*Required*");
    }
    lines.push("");
    for (const [mediaType, mediaObj] of Object.entries(detail.requestBody.content)) {
      lines.push(`**Content-Type:** \`${mediaType}\``);
      if (mediaObj.schema) {
        lines.push("```");
        lines.push(JSON.stringify(mediaObj.schema, null, 2).slice(0, 3000));
        lines.push("```");
      }
      lines.push("");
    }
  }

  // Responses
  if (detail.responses.length > 0) {
    lines.push("### Responses");
    lines.push("");
    for (const resp of detail.responses) {
      lines.push(`#### ${resp.statusCode}${resp.description ? ` — ${resp.description}` : ""}`);
      if (resp.content) {
        for (const [mediaType, mediaObj] of Object.entries(resp.content)) {
          lines.push(`**Content-Type:** \`${mediaType}\``);
          if (mediaObj.schema) {
            lines.push("```");
            lines.push(JSON.stringify(mediaObj.schema, null, 2).slice(0, 3000));
            lines.push("```");
          }
        }
      }
      lines.push("");
    }
  }

  // Security
  if (detail.security && detail.security.length > 0) {
    lines.push("### Security");
    for (const secReq of detail.security) {
      for (const [name, scopes] of Object.entries(secReq)) {
        lines.push(`- **${name}**${scopes.length > 0 ? `: ${scopes.join(", ")}` : ""}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================================
// Error Handling
// ============================================================

export function handleError(error: unknown): string {
  if (error instanceof Error) {
    const parts: string[] = [`Error: ${error.message}`];
    if ("code" in error) parts.push(`Code: ${(error as { code: string }).code}`);
    if ("status" in error) parts.push(`Status: ${(error as { status: number }).status}`);
    return parts.join("\n");
  }
  return `Error: ${String(error)}`;
}

// ============================================================
// Character Limit
// ============================================================

export const CHARACTER_LIMIT = 50000;

export function truncateIfNeeded(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n... (truncated, total ${text.length} characters. Use filters or pagination to narrow results.)`
  );
}
