# yapi-mcp

> 零依赖的 [YApi](https://github.com/YMFE/yapi) [MCP](https://modelcontextprotocol.io) server，为 Claude Code 及任意 MCP 客户端暴露 YApi 的接口管理能力。

## 为什么有这个

npm 上的 `@yogeliu/yapi-mcp-server` 存在两个导致**完全不可用**的缺陷：

1. **`inputSchema` 序列化错误**：把 Zod schema 对象本身当作 `inputSchema` 返回，`JSON.stringify` 后变成 `{"_def":...}` 非法结构，MCP 客户端校验失败、报 `tools fetch failed`，所有工具都加载不出来。
2. **接口列表策略错误**：YApi 的 `/api/interface/list` 在多数版本上**忽略 `catid`** 且默认仅返回前若干条，原包「遍历分类」的策略会让结果大量重复并漏掉绝大多数接口；同时接口 id 字段（`_id`）取错，导致拿不到有效 id。

本项目从零重写，**零运行时依赖**（仅用 Node ≥18 内置 `fetch`），手写合法 JSON Schema，并以 project 级分页 + 去重拉取接口，彻底修复上述问题。

## 提供的工具

| 工具 | 说明 |
|---|---|
| `yapi_list_projects` | 列出 token 配置的项目信息（id / 名称 / 描述） |
| `yapi_get_categories` | 获取项目分类及每个分类下的接口 |
| `yapi_search_apis` | 按关键词（title / path）搜索接口，可选 method 过滤 |
| `yapi_get_api_details` | 获取单个接口完整详情（参数 / 请求头 / 请求体 / 响应体等） |
| `yapi_save_api` | 创建或更新接口（带 `api_id` 走更新，否则创建） |

## 安装

### 方式一：npx 直接跑（推荐）

无需安装，MCP 配置里写：
```json
{ "command": "npx", "args": ["-y", "@mail-tom/yapi-mcp"] }
```

### 方式二：克隆源码
```bash
git clone https://github.com/hizml/yapi-mcp.git
```
配置里指向本地文件：
```json
{ "command": "node", "args": ["/absolute/path/to/yapi-mcp/yapi-mcp.mjs"] }
```

## 配置

两个环境变量：
- `YAPI_BASE_URL`：YApi 地址，如 `http://yapi.example.com`
- `YAPI_TOKEN`：格式 `projectId:tokenValue`，在 YApi 项目「设置 → token 配置」获取

### Claude Code（`~/.claude.json`）
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
完整示例见 [`examples/claude-code-config.json`](examples/claude-code-config.json)。

## 特性

- **零依赖**：纯 Node ESM，仅依赖 Node ≥18 内置 `fetch`
- **合法 JSON Schema**：所有 `inputSchema` 手写为标准 JSON Schema，客户端校验通过
- **分页拉全**：project 级分页 + 去重，接口列表准确无遗漏
- **健壮错误处理**：参数错误、网络超时、YApi `errcode` 均转为中文 `isError` 提示，进程不崩溃
- **可调试**：设置 `DEBUG=1` 向 stderr 输出日志

## 已知限制

- 当前为**单 token（单项目）**模式；多项目请配置多个实例
- YApi `/api/interface/list` 的 `total` 字段不可靠，本工具以「分页拉到不足一页」作为终止条件

## License

MIT
