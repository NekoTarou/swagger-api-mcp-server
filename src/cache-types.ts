import type { ParameterInfo, RequestBodyInfo, ResponseInfo } from "./types.js";

// ============================================================
// Cache File Interfaces
// ============================================================

export interface CacheMeta {
  specUrl: string;
  specTitle: string;
  specVersion: string;
  specFormat: string;
  endpointCount: number;
  schemaCount: number;
  tagCount: number;
  cachedAt: string; // ISO 8601
  cacheDir: string; // absolute path
}

export interface CacheInfo {
  title: string;
  version: string;
  description?: string;
  termsOfService?: string;
  contact?: { name?: string; url?: string; email?: string };
  license?: { name?: string; url?: string };
  specFormat: string;
  specSource: string;
  servers: Array<{ url: string; description?: string }>;
  securitySchemes: Record<string, unknown>;
  globalSecurity?: Array<Record<string, string[]>>;
}

export interface CacheTag {
  name: string;
  description?: string;
  endpointCount: number;
}

export interface CachePathEntry {
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  operationId?: string;
  deprecated?: boolean;
  cacheFile: string; // relative path within cache dir, e.g. "endpoints/GET__users__{id}.json"
}

export interface CacheSchemaEntry {
  name: string;
  type?: string;
  description?: string;
  propertyCount: number;
  cacheFile: string; // relative path within cache dir, e.g. "schemas/User.json"
}

export interface CacheEndpointDetail {
  method: string;
  path: string;
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters: ParameterInfo[];
  requestBody?: RequestBodyInfo;
  responses: ResponseInfo[];
  security?: Array<Record<string, string[]>>;
}
