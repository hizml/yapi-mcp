# yapi-mcp

> English | [中文](README.zh-CN.md)

> A zero-dependency [YApi](https://github.com/YMFE/yapi) [MCP](https://modelcontextprotocol.io) server that exposes YApi's API-management capabilities to Claude Code and any MCP client.

## Why this exists

The npm package `@yogeliu/yapi-mcp-server` has two defects that make it **completely unusable**:

1. **Broken `inputSchema` serialization** — it returns the Zod schema *object* itself as `inputSchema`. After `JSON.stringify` it becomes `{"_def":...}`, an invalid structure. MCP clients reject it with `tools fetch failed`, so none of the tools ever load.
2. **Wrong interface-list strategy** — YApi's `/api/interface/list` **ignores `catid`** on most versions and returns only the first page by default. The original package's "iterate categories" approach causes massive duplication and misses most interfaces; it also reads the wrong id field (`_id`).

This project is rewritten from scratch with **zero runtime dependencies** (only Node ≥18 built-in `fetch`), hand-written valid JSON Schemas, and project-level pagination with dedup — fixing all of the above.

## Tools

| Tool | Description |
|---|---|
| `yapi_list_projects` | List the configured project (id / name / desc) |
| `yapi_get_categories` | List project categories and the APIs under each |
| `yapi_search_apis` | Search APIs by keyword (title / path), optional method filter |
| `yapi_get_api_details` | Full detail of one API (params / headers / body / response) |
| `yapi_save_api` | Create or update an API (with `api_id` → update; without → create) |

## Install

### Option 1: npx (recommended)

No install needed — use it directly in your MCP config:
```json
{ "command": "npx", "args": ["-y", "@mail-tom/yapi-mcp"] }
```

### Option 2: clone
```bash
git clone https://github.com/hizml/yapi-mcp.git
```
Point the config at the local file:
```json
{ "command": "node", "args": ["/absolute/path/to/yapi-mcp/yapi-mcp.mjs"] }
```

## Configuration

Two environment variables:
- `YAPI_BASE_URL` — YApi host, e.g. `http://yapi.example.com`
- `YAPI_TOKEN` — format `projectId:tokenValue`, from the YApi project "Settings → token"

### Claude Code (`~/.claude.json`)
```json
{
  "mcpServers": {
    "yapi": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@mail-tom/yapi-mcp"],
      "env": {
        "YAPI_BASE_URL": "http://your-yapi-host",
        "YAPI_TOKEN": "227:your_token_here"
      }
    }
  }
}
```
Full example: [`examples/claude-code-config.json`](examples/claude-code-config.json).

## Features

- **Zero dependencies** — pure Node ESM, only Node ≥18 built-in `fetch`
- **Valid JSON Schema** — every `inputSchema` is hand-written standard JSON Schema, so clients validate it fine
- **Full pagination** — project-level pagination + dedup, no missing or duplicate APIs
- **Robust errors** — param errors, timeouts, and YApi `errcode` all become `isError` messages; the process never crashes
- **Debuggable** — set `DEBUG=1` to emit logs to stderr

## Known limitations

- Currently **single-token (single-project)**; for multiple projects, run multiple instances
- YApi's `/api/interface/list` `total` field is unreliable, so this tool stops paginating when a page returns fewer than the page size

## License

MIT
