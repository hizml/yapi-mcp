#!/usr/bin/env node
// yapi-mcp.mjs — 零依赖 YApi MCP Server（stdio / NDJSON）
//
// 用途：为 Claude Code 暴露 YApi 的项目/分类/接口查询与写入能力。
// 环境：YAPI_BASE_URL（如 http://your-yapi-host）、YAPI_TOKEN（格式 projectId:tokenValue）。
// 传输：标准输入/输出，每行一个 JSON-RPC 2.0 消息；任何日志只写 stderr，绝不污染 stdout。
//
// 本文件替代有 bug 的 npm 包 @yogeliu/yapi-mcp-server：该包把 Zod schema 对象
// 直接当作 inputSchema 返回，序列化后为非法结构，导致客户端 "tools fetch failed"。
// 这里所有 inputSchema 都是手写的合法 JSON Schema（plain object），从根上修复。

import readline from 'node:readline';

// ───────────────────────── 常量 ─────────────────────────
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'yapi-mcp', version: '1.0.0' };
const REQUEST_TIMEOUT_MS = 15000;
const MAX_MATCHES = 50;
const MAX_TEXT_BYTES = 100 * 1024;
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

// ───────────────────────── 1. 配置层 ─────────────────────────
function parseConfig() {
  const baseUrl = (process.env.YAPI_BASE_URL || '').replace(/\/+$/, '');
  const token = process.env.YAPI_TOKEN || '';
  const [projectIdStr, tokenValue] = token.split(':');
  const defaultProjectId = Number(projectIdStr);
  const isValid = baseUrl && tokenValue && Number.isFinite(defaultProjectId);
  if (!isValid) {
    console.error('[yapi-mcp] 配置无效：需设置 YAPI_BASE_URL 与 YAPI_TOKEN（格式 projectId:tokenValue）');
    process.exit(1);
  }
  return { baseUrl, tokenValue, defaultProjectId };
}

// ───────────────────────── 2. HTTP 层 ─────────────────────────
function wrapFetchError(err) {
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return new Error(`YApi 请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`);
  }
  return new Error(`YApi 网络错误: ${err.message}`);
}

async function unwrap(res) {
  if (!res.ok) throw new Error(`YApi HTTP ${res.status}`);
  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error('YApi 返回非 JSON 响应');
  }
  if (payload.errcode !== 0) {
    throw new Error(`YApi 错误 ${payload.errcode}: ${payload.errmsg || '未知错误'}`);
  }
  return payload.data;
}

function buildUrl(cfg, endpoint, params) {
  const url = new URL(cfg.baseUrl + endpoint);
  url.searchParams.set('token', cfg.tokenValue);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  return url;
}

async function yapiGet(cfg, endpoint, params = {}) {
  try {
    const res = await fetch(buildUrl(cfg, endpoint, params), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return await unwrap(res);
  } catch (err) {
    throw err.message.startsWith('YApi') ? err : wrapFetchError(err);
  }
}

async function yapiPost(cfg, endpoint, body = {}) {
  try {
    const res = await fetch(cfg.baseUrl + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ...body, token: cfg.tokenValue }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return await unwrap(res);
  } catch (err) {
    throw err.message.startsWith('YApi') ? err : wrapFetchError(err);
  }
}

// ───────────────────────── 3. 参数校验与工具函数 ─────────────────────────
function throwParamError(message) {
  const err = new Error(message);
  err.isParamError = true;
  throw err;
}

function requireArgs(args, ...keys) {
  const missing = keys.filter((k) => args[k] === undefined || args[k] === null);
  if (missing.length > 0) throwParamError(`缺少必填参数: ${missing.join(', ')}`);
}

function toInt(value) {
  const num = Number(value);
  return Number.isInteger(num) ? num : NaN;
}

function toApiSummary(api) {
  return {
    id: api._id ?? api.id,
    project_id: api.project_id,
    catid: api.catid,
    title: api.title,
    path: api.path,
    method: api.method,
  };
}

function isKeywordMatch(api, keyword) {
  return (api.title || '').toLowerCase().includes(keyword)
    || (api.path || '').toLowerCase().includes(keyword);
}

// yapi 的请求体/响应体结构以字符串存储，模型若误传对象则序列化为字符串
function normalizeBodyFields(args) {
  const out = { ...args };
  for (const field of ['req_body_other', 'res_body']) {
    if (out[field] !== undefined && typeof out[field] === 'object') {
      out[field] = JSON.stringify(out[field]);
    }
  }
  return out;
}

function truncateText(text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_TEXT_BYTES) return text;
  return `${text.slice(0, MAX_TEXT_BYTES)}\n... (已截断，完整大小 ${bytes} 字节)`;
}

// ───────────────────────── 4. 工具实现 ─────────────────────────
async function listProjects(args, cfg) {
  const data = await yapiGet(cfg, '/api/project/get', { id: cfg.defaultProjectId });
  return { projects: [{ id: data._id, name: data.name, desc: data.desc }] };
}

const LIST_PAGE_SIZE = 100;

// 该 yapi 的 /api/interface/list 忽略 catid、默认仅返回前若干条，
// 必须以 project_id + page + limit 分页拉取才能取全；按 id 去重作保险。
async function fetchAllInterfaces(cfg, projectId) {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= 50; page++) {
    const data = await yapiGet(cfg, '/api/interface/list', { project_id: projectId, page, limit: LIST_PAGE_SIZE });
    const list = data.list || [];
    for (const api of list) {
      const summary = toApiSummary(api);
      if (!seen.has(summary.id)) { seen.add(summary.id); all.push(summary); }
    }
    if (list.length < LIST_PAGE_SIZE) break;
  }
  return all;
}

async function getCategories(args, cfg) {
  requireArgs(args, 'project_id');
  const projectId = toInt(args.project_id);
  if (Number.isNaN(projectId)) throwParamError('project_id 必须为整数');
  const categories = await yapiGet(cfg, '/api/interface/getCatMenu', { project_id: projectId });
  const apis = await fetchAllInterfaces(cfg, projectId);
  const byCat = new Map();
  for (const api of apis) {
    if (!byCat.has(api.catid)) byCat.set(api.catid, []);
    byCat.get(api.catid).push(api);
  }
  const result = categories.map((cat) => ({
    id: cat._id,
    name: cat.name,
    count: (byCat.get(cat._id) || []).length,
    apis: byCat.get(cat._id) || [],
  }));
  return { categories: result };
}

async function searchApis(args, cfg) {
  requireArgs(args, 'query');
  const projectId = args.project_id === undefined ? cfg.defaultProjectId : toInt(args.project_id);
  if (Number.isNaN(projectId)) throwParamError('project_id 必须为整数');
  const keyword = String(args.query).toLowerCase();
  const method = args.method ? String(args.method).toUpperCase() : null;
  const matches = (await fetchAllInterfaces(cfg, projectId))
    .filter((api) => isKeywordMatch(api, keyword) && (!method || api.method === method));
  return {
    project_id: projectId,
    query: args.query,
    method,
    total: matches.length,
    matches: matches.slice(0, MAX_MATCHES),
    truncated: matches.length > MAX_MATCHES,
  };
}

async function getApiDetails(args, cfg) {
  requireArgs(args, 'api_id');
  const apiId = toInt(args.api_id);
  if (Number.isNaN(apiId)) throwParamError('api_id 必须为整数');
  return await yapiGet(cfg, '/api/interface/get', { id: apiId });
}

async function saveApi(args, cfg) {
  requireArgs(args, 'project_id', 'catid');
  const projectId = toInt(args.project_id);
  const catid = toInt(args.catid);
  if (Number.isNaN(projectId) || Number.isNaN(catid)) throwParamError('project_id 与 catid 必须为整数');
  const { api_id, project_id: _pid, catid: _cid, ...rest } = normalizeBodyFields(args);
  const isUpdate = api_id !== undefined;
  const payload = { ...rest, project_id: projectId, catid };
  if (isUpdate) payload.id = toInt(api_id);
  const endpoint = isUpdate ? '/api/interface/up' : '/api/interface/add';
  const data = await yapiPost(cfg, endpoint, payload);
  return { success: true, action: isUpdate ? 'updated' : 'created', api_id: isUpdate ? payload.id : data?._id };
}

// ───────────────────────── 5. 工具表（inputSchema 为合法 JSON Schema） ─────────────────────────
const TOOLS = [
  {
    name: 'yapi_list_projects',
    description: '列出当前 token 配置的 YApi 项目信息（项目 ID、名称、描述）。无参数。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: listProjects,
  },
  {
    name: 'yapi_get_categories',
    description: '获取指定项目的接口分类列表（分类 ID、名称，以及每个分类下的接口概要）。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: '项目 ID。省略时使用 token 中的 projectId。' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    handler: getCategories,
  },
  {
    name: 'yapi_search_apis',
    description: '在项目内按关键词搜索接口（匹配 title/path，可选按 method 过滤），返回接口列表。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，按子串匹配接口 title 或 path（不区分大小写）。' },
        project_id: { type: 'integer', description: '项目 ID。省略时使用 token 中的 projectId。' },
        method: { type: 'string', enum: HTTP_METHODS, description: '可选。按 HTTP 方法过滤。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: searchApis,
  },
  {
    name: 'yapi_get_api_details',
    description: '获取接口详细信息（请求参数、请求头、请求体类型与结构、响应体等）。',
    inputSchema: {
      type: 'object',
      properties: {
        api_id: { type: 'integer', description: '接口 ID（可由 search_apis 或 get_categories 结果获得）。' },
      },
      required: ['api_id'],
      additionalProperties: false,
    },
    handler: getApiDetails,
  },
  {
    name: 'yapi_save_api',
    description: '创建或更新 YApi 接口。带 api_id 走更新（/api/interface/up），不带走创建（/api/interface/add）。至少需提供 project_id 与 catid。',
    inputSchema: {
      type: 'object',
      properties: {
        api_id: { type: 'integer', description: '要更新的接口 ID。提供时为更新；省略时为创建。' },
        project_id: { type: 'integer', description: '目标项目 ID。' },
        catid: { type: 'integer', description: '目标分类 ID。' },
        title: { type: 'string', description: '接口标题。' },
        path: { type: 'string', description: '接口路径，例如 /api/foo/bar。' },
        method: { type: 'string', enum: HTTP_METHODS, description: 'HTTP 方法。' },
        desc: { type: 'string', description: '接口描述。' },
        req_query: {
          type: 'array',
          description: 'query 参数列表。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              required: { type: 'string', enum: ['1', '0'], description: '是否必需："1" 或 "0"。' },
              desc: { type: 'string' },
              example: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        req_headers: {
          type: 'array',
          description: '请求头列表。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
              required: { type: 'string', enum: ['1', '0'], description: '是否必需："1" 或 "0"。' },
              desc: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        req_body_type: { type: 'string', enum: ['json', 'form', 'raw'], description: '请求体类型。' },
        req_body_other: { type: 'string', description: '请求体结构，json 类型时为 JSON Schema 字符串。' },
        res_body: { type: 'string', description: '响应体结构，JSON Schema 字符串。' },
      },
      required: ['project_id', 'catid'],
      additionalProperties: false,
    },
    handler: saveApi,
  },
];

// ───────────────────────── 6. 协议层 ─────────────────────────
function handleInitialize() {
  return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
}

function handleListTools() {
  return {
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  };
}

async function handleCallTool(req, cfg) {
  const { name, arguments: args } = req.params || {};
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throwParamError(`未知工具: ${name}`);
  const result = await tool.handler(args || {}, cfg);
  return { content: [{ type: 'text', text: truncateText(JSON.stringify(result, null, 2)) }] };
}

async function route(req, cfg) {
  switch (req.method) {
    case 'initialize': return handleInitialize();
    case 'notifications/initialized': return undefined;
    case 'tools/list': return handleListTools();
    case 'tools/call': return await handleCallTool(req, cfg);
    default: {
      const err = new Error(`不支持的方法: ${req.method}`);
      err.jsonrpcCode = -32601;
      throw err;
    }
  }
}

// ───────────────────────── 7. JSON-RPC 框架与主循环 ─────────────────────────
function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function resultResponse(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function errorResponse(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function log(...args) {
  if (process.env.DEBUG) console.error('[yapi-mcp]', ...args);
}

function isValidRequest(req) {
  return req && typeof req === 'object' && req.jsonrpc === '2.0' && typeof req.method === 'string';
}

function respondError(id, err) {
  if (err.jsonrpcCode) return errorResponse(id, err.jsonrpcCode, err.message);
  // 参数错误 / 业务错误 / 网络 yapi 错误 → tool 级 isError
  return resultResponse(id, { isError: true, content: [{ type: 'text', text: err.message }] });
}

async function handleMessage(req, cfg) {
  if (!isValidRequest(req)) return errorResponse(req?.id ?? null, -32600, 'Invalid Request');
  const isNotification = req.id === undefined || req.id === null;
  try {
    const result = await route(req, cfg);
    if (result === undefined || isNotification) return;
    resultResponse(req.id, result);
  } catch (err) {
    if (isNotification) return log('通知处理错误:', err);
    respondError(req.id, err);
  }
}

async function main() {
  const cfg = parseConfig();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      return errorResponse(null, -32700, 'Parse error');
    }
    handleMessage(req, cfg).catch((err) => log('未捕获消息错误:', err));
  });

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.on('uncaughtException', (err) => { log('uncaughtException:', err); process.exit(1); });
  process.on('unhandledRejection', (err) => { log('unhandledRejection:', err); process.exit(1); });

  log(`YApi MCP Server 已启动（项目 ${cfg.defaultProjectId}, ${cfg.baseUrl}）`);
}

main();
