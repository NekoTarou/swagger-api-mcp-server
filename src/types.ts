import type { z } from "zod";

// ============================================================
// Tool Metadata
// ============================================================

export interface ToolMetadata {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

// ============================================================
// OpenAPI / Swagger Spec Types
// ============================================================

export interface SpecInfo {
  title: string;
  version: string;
  description?: string;
  termsOfService?: string;
  contact?: {
    name?: string;
    url?: string;
    email?: string;
  };
  license?: {
    name?: string;
    url?: string;
  };
}

export interface SpecServer {
  url: string;
  description?: string;
}

export interface SpecTag {
  name: string;
  description?: string;
}

export interface SpecSecurityScheme {
  type: string;
  name?: string;
  in?: string;
  scheme?: string;
  bearerFormat?: string;
  description?: string;
  flows?: Record<string, unknown>;
}

export interface EndpointSummary {
  method: string;
  path: string;
  summary?: string;
  tags?: string[];
  deprecated?: boolean;
  operationId?: string;
}

export interface ParameterInfo {
  name: string;
  in: string; // "query" | "header" | "path" | "cookie"
  required: boolean;
  description?: string;
  schema?: SchemaObject;
  deprecated?: boolean;
}

export interface SchemaObject {
  type?: string;
  format?: string;
  description?: string;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  example?: unknown;
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  $ref?: string;
  additionalProperties?: boolean | SchemaObject;
  nullable?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  title?: string;
}

export interface RequestBodyInfo {
  description?: string;
  required?: boolean;
  content: Record<
    string,
    {
      schema?: SchemaObject;
    }
  >;
}

export interface ResponseInfo {
  statusCode: string;
  description?: string;
  content?: Record<
    string,
    {
      schema?: SchemaObject;
    }
  >;
  headers?: Record<string, { description?: string; schema?: SchemaObject }>;
}

export interface EndpointDetail {
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

export interface SchemaEntry {
  name: string;
  type?: string;
  description?: string;
  propertyCount: number;
}

// ============================================================
// HTTP Session Management
// ============================================================

export interface SessionInfo {
  transport: unknown;
  server: unknown;
  createdAt: Date;
  lastActivityAt: Date;
  requestCount: number;
}
