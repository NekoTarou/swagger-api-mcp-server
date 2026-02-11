# Swagger API MCP Server

[![License](https://img.shields.io/github/license/NekoTarou/swagger-api-mcp-server.svg)](https://github.com/NekoTarou/swagger-api-mcp-server/blob/main/LICENSE)
[![Build & Test](https://github.com/NekoTarou/swagger-api-mcp-server/actions/workflows/publish.yml/badge.svg)](https://github.com/NekoTarou/swagger-api-mcp-server/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/swagger-api-mcp-server.svg)](https://www.npmjs.com/package/swagger-api-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/swagger-api-mcp-server.svg)](https://www.npmjs.com/package/swagger-api-mcp-server)
[![Node.js Version](https://img.shields.io/node/v/swagger-api-mcp-server.svg)](https://nodejs.org)
[![MCP Badge](https://lobehub.com/badge/mcp/nekotarou-swagger-api-mcp-server?style=plastic)](https://lobehub.com/mcp/nekotarou-swagger-api-mcp-server)

[English](./README.md) | [中文](./README_zh.md)

一个 MCP (Model Context Protocol) 服务器，用于解析 **Swagger 2.0** 和 **OpenAPI 3.x** 规范，通过 MCP 工具暴露 API 结构。采用本地文件缓存架构，相比内联返回方式可节省 85-95% 的 token 消耗。

## 特性

- **Swagger 2.0 & OpenAPI 3.x** — 完整的双格式支持
- **智能缓存** — 规范只解析一次，存储为本地 JSON 文件；工具仅返回简短摘要 + 文件路径（约 200 字符 vs 5-20KB）
- **11 个 MCP 工具** — 加载、浏览、搜索、调用 API，并支持动态管理认证
- **3 个 MCP 提示词** — 引导式工作流，用于探索、搜索和集成 API
- **3 个 MCP 资源** — 直接访问缓存的 API 信息、端点和 Schema
- **两种传输模式** — stdio（用于 CLI/IDE 集成）和 HTTP（用于多会话 Web 使用）
- **两阶段 API 调用** — 执行前预览请求内容
- **零外部解析器** — 自定义 `$ref` 解析器，支持循环引用保护

## 前置要求

- **Node.js >= 24**

## 快速开始

### 从 npm 安装

```bash
npm install -g swagger-api-mcp-server
```

### 或克隆构建

```bash
git clone https://github.com/NekoTarou/swagger-api-mcp-server.git
cd swagger-api-mcp-server
npm install
npm run build
```

### 运行

```bash
# stdio 模式（默认）— 用于 Claude Desktop 等 MCP 客户端
npm start

# 启动时自动加载规范
SWAGGER_URL=https://petstore.swagger.io/v2/swagger.json npm start

# HTTP 模式 — 多会话 Express 服务器
npm run start:http
```

## MCP 客户端配置

### Claude Desktop

在 Claude Desktop 配置文件（`claude_desktop_config.json`）中添加：

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

在 MCP 设置中添加：

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

## 工具列表

| 工具                   | 说明                                            |
| ---------------------- | ----------------------------------------------- |
| `swagger_load_spec`    | 从 URL 加载 Swagger/OpenAPI 规范，解析并缓存    |
| `swagger_update_cache` | 重新获取规范并重建缓存                          |
| `swagger_get_info`     | 获取 API 元信息（标题、版本、服务器、认证方案） |
| `swagger_list_tags`    | 列出所有标签及对应端点数量                      |
| `swagger_list_paths`   | 列出端点，支持过滤（标签、方法、关键词）和分页  |
| `swagger_get_endpoint` | 获取端点摘要 + 缓存文件路径（包含完整详情）     |
| `swagger_list_schemas` | 列出 Schema 定义，支持过滤和分页                |
| `swagger_get_schema`   | 获取 Schema 摘要 + 缓存文件路径（包含完整定义） |
| `swagger_search`       | 按关键词搜索端点和 Schema                       |
| `swagger_call_api`     | 执行 HTTP 请求，支持两阶段确认                  |
| `swagger_set_auth`     | 运行时动态设置或清除 Authorization 请求头       |

## 提示词（Prompts）

| 提示词                   | 参数             | 说明                                         |
| ------------------------ | ---------------- | -------------------------------------------- |
| `swagger_explore_api`    | `url`            | 引导式工作流：加载并全面浏览一个 API 规范    |
| `swagger_find_endpoint`  | `keyword`        | 按关键词搜索端点并查看完整详情               |
| `swagger_integrate_api`  | `url`, `task`    | 根据任务描述找到合适端点并执行 API 调用      |

## 资源（Resources）

| 资源             | URI                       | 说明                                      |
| ---------------- | ------------------------- | ----------------------------------------- |
| `api-info`       | `swagger://api/info`      | API 基本信息（标题、版本、服务器、认证）  |
| `api-endpoints`  | `swagger://api/endpoints` | 所有 API 端点索引                         |
| `api-schemas`    | `swagger://api/schemas`   | 所有 Schema/模型定义索引                  |

## 缓存架构

加载规范后，解析一次并存储为结构化 JSON 文件：

```
.swagger-cache/
├── meta.json              # 缓存元信息（URL、数量统计、时间戳）
├── info.json              # 完整 API 信息（标题、服务器、认证）
├── tags.json              # 标签列表及端点数量
├── paths-index.json       # 端点索引，用于快速查找
├── schemas-index.json     # Schema 索引，用于快速查找
├── endpoints/             # 每个端点一个文件（已深度解析 $ref）
│   └── GET__users__{id}.json
└── schemas/               # 每个 Schema 一个文件（已深度解析 $ref）
    └── User.json
```

工具返回简短摘要和文件路径，LLM 按需通过 `Read` 工具读取完整详情 — 每次调用可节省 **85-95% 的 token**。

## 环境变量

| 变量                 | 默认值           | 说明                                                                  |
| -------------------- | ---------------- | --------------------------------------------------------------------- |
| `SWAGGER_URL`        | _(空)_           | 启动时自动加载的规范 URL                                              |
| `TRANSPORT`          | `stdio`          | 传输模式：`stdio` 或 `http`                                           |
| `MCP_PORT`           | `3000`           | HTTP 服务器端口                                                       |
| `MCP_HOST`           | `0.0.0.0`        | HTTP 服务器主机                                                       |
| `API_BASE_URL`       | _(空)_           | 覆盖 API 调用的基础 URL                                               |
| `API_AUTH_TOKEN`     | _(空)_           | 初始 Authorization 请求头值（可通过 `swagger_set_auth` 在运行时更新） |
| `CACHE_DIR`          | `.swagger-cache` | 自定义缓存目录路径                                                    |
| `SESSION_TIMEOUT_MS` | `1800000`        | HTTP 会话超时时间（30 分钟）                                          |
| `MAX_SESSIONS`       | `100`            | 最大并发 HTTP 会话数                                                  |

## 开发

```bash
npm run dev            # 开发模式，自动重载（tsx watch）
npm test               # 运行测试
npm run build          # TypeScript 编译 → dist/
npm run clean          # 清除 dist/
```

## 许可证

[MIT](./LICENSE)
