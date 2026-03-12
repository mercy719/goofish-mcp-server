# Goofish MCP Server

独立的 Goofish / 闲鱼 MCP server，使用 **Node.js + Playwright**，并通过**页面上下文里的 `window.lib.mtop.request(...)`** 获取搜索数据。

## 当前状态

- ✅ `search_items`：已按真实 Goofish 页面 + mtop 路线实现
- ✅ `get_item_detail`：已接入 `mtop.taobao.idle.pc.detail`，可结构化返回价格、卖家、地区、图片、属性、描述
- ✅ `monitor_keyword`：复用 `search_items`
- ✅ 浏览器登录态持久化：使用 Playwright persistent context

## 安装

```bash
cd goofish-mcp-server
npm install
```

## 运行

```bash
npm start
```

默认使用：

- 浏览器 profile 目录：`./.profiles/goofish`
- 非 headless

可选环境变量：

```bash
GOOFISH_PROFILE_DIR=/path/to/profile
GOOFISH_HEADLESS=1
```

## 第一次登录

首次启动时会打开浏览器 profile。
你需要在这个 profile 里手动登录 Goofish 一次。
后续 session 会复用该登录态。

## MCP tools

### 1. search_items

输入：

```json
{
  "keyword": "iphone 15 pro",
  "limit": 10
}
```

### 2. get_item_detail

输入：

```json
{
  "item_id": "1234567890"
}
```

或：

```json
{
  "url": "https://www.goofish.com/item?id=1234567890"
}
```

### 3. monitor_keyword

输入：

```json
{
  "keyword": "iphone 15 pro",
  "max_items": 20,
  "dedupe_key": "item_id"
}
```

## Claude / OpenClaw 接入思路

把这个进程作为 stdio MCP server 挂进去即可。

配置示例文件：

- `mcp-config-examples.json`

Claude Desktop 核心思路：

```json
{
  "mcpServers": {
    "goofish": {
      "command": "node",
      "args": ["/absolute/path/to/goofish-mcp-server/index.js"],
      "env": {
        "GOOFISH_PROFILE_DIR": "/absolute/path/to/goofish-mcp-server/.profiles/goofish",
        "GOOFISH_HEADLESS": "0"
      }
    }
  }
}
```

## 下一步建议

1. 补强 `get_item_detail` 的真实结构化字段
2. 增加 cookie/export/import 管理
3. 增加自动登录检测和错误提示
4. 增加 remote/http transport
