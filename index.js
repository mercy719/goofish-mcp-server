const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { z } = require('zod');

const PROFILE_DIR = process.env.GOOFISH_PROFILE_DIR || path.join(process.cwd(), '.profiles', 'goofish');
const HEADLESS = process.env.GOOFISH_HEADLESS === '1';

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function isoFromMs(ms) {
  if (!ms) return null;
  try { return new Date(Number(ms)).toISOString(); } catch { return null; }
}

function priceFromParts(parts) {
  if (!Array.isArray(parts)) return null;
  const txt = parts
    .filter(p => ['integer', 'decimal'].includes(p?.type))
    .map(p => String(p.text || ''))
    .join('');
  if (!txt) return null;
  const n = Number(txt);
  return Number.isFinite(n) ? n : txt;
}

function normalizeSearchItems(resultList, limit = 10) {
  return (resultList || []).slice(0, limit).map((row) => {
    const main = row?.data?.item?.main || {};
    const ex = main.exContent || {};
    const clickArgs = main?.clickParam?.args || {};
    const itemId = ex.itemId || clickArgs.item_id || clickArgs.id || null;
    return {
      item_id: itemId ? String(itemId) : null,
      title: ex.title || main?.titleSpan?.content || ex?.detailParams?.title || null,
      price: priceFromParts(ex.price),
      url: itemId ? `https://www.goofish.com/item?id=${itemId}` : null,
      seller: ex.userNickName || ex.userNick || null,
      location: ex.area || null,
      publish_time: isoFromMs(clickArgs.publishTime),
      raw: row,
    };
  });
}

function makeMonitorSnapshot(keyword, items, dedupeKey) {
  return {
    ok: true,
    keyword,
    checked_at: new Date().toISOString(),
    dedupe_key: dedupeKey,
    items,
    count: items.length,
  };
}

function normalizeDetailData(data, itemId, finalUrl) {
  const item = data?.itemDO || {};
  const seller = data?.sellerDO || {};
  const images = Array.isArray(item.imageInfos)
    ? item.imageInfos.map(img => img?.url).filter(Boolean)
    : [];

  const attributes = {};
  for (const label of item.cpvLabels || []) {
    if (label?.propertyName && label?.valueName) {
      attributes[label.propertyName] = label.valueName;
    }
  }

  const price = item.soldPrice ? Number(item.soldPrice) : null;
  const originalPrice = item.originalPrice && item.originalPrice !== '0' ? Number(item.originalPrice) : null;
  const location = seller.city || seller.publishCity || null;
  const sellerName = seller.nick || seller.uniqueName || null;

  return {
    item_id: String(item.itemId || itemId),
    title: item.title || null,
    price: Number.isFinite(price) ? price : item.soldPrice || null,
    original_price: Number.isFinite(originalPrice) ? originalPrice : (item.originalPrice || null),
    seller: sellerName,
    location,
    description: item.desc || null,
    images,
    attributes,
    url: finalUrl,
    raw: data,
  };
}

class GoofishRuntime {
  constructor() {
    ensureDir(PROFILE_DIR);
    this.contextPromise = null;
  }

  async getContext() {
    if (!this.contextPromise) {
      this.contextPromise = chromium.launchPersistentContext(PROFILE_DIR, {
        headless: HEADLESS,
        viewport: { width: 1440, height: 1200 },
      });
    }
    return this.contextPromise;
  }

  async newPage(url) {
    const context = await this.getContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return page;
  }

  async ensureGoofishReady(page) {
    await page.waitForTimeout(3000);
    const hasMtop = await page.evaluate(() => !!(window.lib && window.lib.mtop));
    if (!hasMtop) throw new Error('Goofish page context missing window.lib.mtop; login/session may not be ready');
  }

  async searchItems(keyword, limit = 10) {
    const url = `https://www.goofish.com/search?q=${encodeURIComponent(keyword)}`;
    const page = await this.newPage(url);
    try {
      await this.ensureGoofishReady(page);
      const resp = await page.evaluate(async (kw) => {
        const data = { pageNumber: 1, keyword: kw, rowsPerPage: 30, searchReqFromPage: 'pcSearch' };
        return await window.lib.mtop.request({
          api: 'mtop.taobao.idlemtopsearch.pc.search',
          v: '1.0',
          type: 'POST',
          appKey: '34839810',
          accountSite: 'xianyu',
          dataType: 'json',
          timeout: 20000,
          needLoginPC: false,
          showErrorToast: false,
          needLogin: false,
          sessionOption: 'AutoLoginOnly',
          ecode: 0,
          data,
        });
      }, keyword);
      const items = normalizeSearchItems(resp?.data?.resultList || [], limit);
      return { ok: true, items, count: items.length, source_url: url, source: 'mtop-browser-context' };
    } finally {
      await page.close();
    }
  }

  async getItemDetail({ item_id, url }) {
    const finalUrl = url || `https://www.goofish.com/item?id=${encodeURIComponent(item_id)}`;
    const finalItemId = item_id || new URL(finalUrl).searchParams.get('id');
    const page = await this.newPage(finalUrl);
    try {
      await this.ensureGoofishReady(page);
      const resp = await page.evaluate(async (id) => {
        return await window.lib.mtop.request({
          api: 'mtop.taobao.idle.pc.detail',
          v: '1.0',
          type: 'POST',
          appKey: '34839810',
          accountSite: 'xianyu',
          dataType: 'json',
          timeout: 20000,
          needLoginPC: false,
          showErrorToast: false,
          needLogin: false,
          sessionOption: 'AutoLoginOnly',
          ecode: 0,
          data: { itemId: id },
        });
      }, finalItemId);

      return {
        ok: true,
        item: normalizeDetailData(resp?.data || {}, finalItemId, finalUrl),
        source: 'mtop-browser-context-detail',
      };
    } finally {
      await page.close();
    }
  }

  async publishItem({ title, desc, price_yuan, category_id, images = [] }) {
    const page = await this.newPage('https://www.goofish.com/publish');
    const tmpFiles = [];
    try {
      const numericPrice = Number(price_yuan);
      if (!Number.isFinite(numericPrice)) {
        throw new Error('Invalid price_yuan, expected a number');
      }

      const downloadImageToTemp = async (url, redirectCount = 0) => {
        if (redirectCount > 5) throw new Error(`Too many redirects: ${url}`);
        const client = url.startsWith('https://') ? https : http;
        const ext = path.extname(new URL(url).pathname) || '.jpg';
        const tmpPath = path.join(os.tmpdir(), `goofish_img_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`);

        await new Promise((resolve, reject) => {
          const req = client.get(url, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
              res.resume();
              const redirectedUrl = new URL(res.headers.location, url).toString();
              downloadImageToTemp(redirectedUrl, redirectCount + 1).then(resolve).catch(reject);
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`Failed to download image (${res.statusCode}): ${url}`));
              return;
            }
            const writer = fs.createWriteStream(tmpPath);
            res.pipe(writer);
            writer.on('finish', () => {
              writer.close(() => resolve(tmpPath));
            });
            writer.on('error', reject);
          });
          req.on('error', reject);
        });

        return tmpPath;
      };

      const fillFirst = async (selectors, value) => {
        for (const selector of selectors) {
          const locator = page.locator(selector).first();
          if ((await locator.count()) > 0) {
            await locator.click({ timeout: 5000 });
            await locator.fill(String(value));
            return true;
          }
        }
        return false;
      };

      try {
        await page.waitForSelector('input, textarea, [contenteditable="true"]', { timeout: 30000 });
      } catch (error) {
        return { ok: false, error: 'Form did not load - login may have expired' };
      }

      if (Array.isArray(images) && images.length > 0) {
        const uploadPaths = [];
        for (const src of images) {
          if (!src) continue;
          if (/^https?:\/\//i.test(src)) {
            const tmpPath = await downloadImageToTemp(src);
            tmpFiles.push(tmpPath);
            uploadPaths.push(tmpPath);
          } else {
            const resolved = path.resolve(src);
            if (!fs.existsSync(resolved)) {
              return { ok: false, error: `Image file not found: ${resolved}` };
            }
            uploadPaths.push(resolved);
          }
        }

        if (uploadPaths.length > 0) {
          let fileInput = page.locator('input[type="file"]').first();
          if ((await fileInput.count()) === 0) {
            await page.click('text=上传', { timeout: 5000 }).catch(() => {});
            await page.waitForSelector('input[type="file"]', { timeout: 10000 });
            fileInput = page.locator('input[type="file"]').first();
          }
          if ((await fileInput.count()) === 0) {
            return { ok: false, error: 'Failed to find image upload input' };
          }
          await fileInput.setInputFiles(uploadPaths);
          await page.waitForTimeout(1000);
        }
      }

      const titleFilled = await fillFirst([
        'input[placeholder*="标题"]',
        'input[placeholder*="宝贝"]',
        'input[placeholder*="商品"]',
        'input[type="text"]',
      ], title);
      if (!titleFilled) {
        return { ok: false, error: 'Failed to find title input' };
      }

      const descFilled = await fillFirst([
        'textarea[placeholder*="描述"]',
        'textarea',
        '[contenteditable="true"]',
      ], desc);
      if (!descFilled) {
        return { ok: false, error: 'Failed to find description input' };
      }

      const priceFilled = await fillFirst([
        'input[placeholder*="价格"]',
        'input[placeholder*="售价"]',
        'input[type="number"]',
      ], String(numericPrice));
      if (!priceFilled) {
        return { ok: false, error: 'Failed to find price input' };
      }

      const submitBtn = page.locator('button:has-text("发布"), button:has-text("确认发布"), [role="button"]:has-text("发布")').first();
      if ((await submitBtn.count()) === 0) {
        return { ok: false, error: 'Failed to find publish button' };
      }
      await submitBtn.click({ timeout: 10000 });

      let success = false;
      const successTextWait = Promise.race([
        page.waitForSelector('text=发布成功', { timeout: 15000 }),
        page.waitForSelector('text=已发布', { timeout: 15000 }),
        page.waitForSelector('text=宝贝发布成功', { timeout: 15000 }),
        page.waitForSelector('text=审核中', { timeout: 15000 }),
      ]);
      await Promise.race([
        page.waitForURL(/item\?id=|\/item\//, { timeout: 15000 }).then(() => { success = true; }),
        successTextWait.then(() => { success = true; }),
      ]).catch(() => {});

      if (!success) {
        return { ok: false, error: 'Failed to submit form' };
      }

      const currentUrl = page.url();
      const parsed = /[?&]id=(\d+)|\/item\/(\d+)/.exec(currentUrl);
      const itemId = parsed ? (parsed[1] || parsed[2]) : null;

      return {
        ok: true,
        item_id: itemId ? String(itemId) : null,
      };
    } catch (error) {
      return {
        ok: false,
        error: 'Failed to submit form',
        details: error instanceof Error ? error.message : String(error),
      };
    } finally {
      for (const p of tmpFiles) {
        try { fs.unlinkSync(p); } catch {}
      }
      await page.close();
    }
  }

  async monitorKeyword(keyword, maxItems = 20, dedupeKey = 'item_id') {
    const result = await this.searchItems(keyword, maxItems);
    return { ...makeMonitorSnapshot(keyword, result.items, dedupeKey), source: result.source, source_url: result.source_url };
  }
}

const runtime = new GoofishRuntime();
const server = new Server({ name: 'goofish-mcp-server', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search_items',
      description: 'Search Goofish/Xianyu items by keyword using a logged-in Playwright browser context. Example queries: iphone 15 pro, sony a7, dyson v12.',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
        required: ['keyword'],
      },
    },
    {
      name: 'get_item_detail',
      description: 'Get Goofish/Xianyu item detail by item_id or URL.',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          url: { type: 'string' },
        },
        anyOf: [{ required: ['item_id'] }, { required: ['url'] }],
      },
    },
    {
      name: 'monitor_keyword',
      description: 'Return a normalized Goofish/Xianyu keyword snapshot for monitoring.',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          max_items: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          dedupe_key: { type: 'string', default: 'item_id' },
        },
        required: ['keyword'],
      },
    },
    {
      name: 'publish_item',
      description: 'Publish a new Goofish/Xianyu second-hand item listing.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '商品标题' },
          desc: { type: 'string', description: '商品描述' },
          price_yuan: { type: 'number', description: '售价（元），如 99.5' },
          category_id: { type: 'string', description: '分类ID（可选）' },
          images: { type: 'array', items: { type: 'string' }, description: '图片本地路径列表（如 /tmp/img.jpg），可选' },
        },
        required: ['title', 'desc', 'price_yuan'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === 'search_items') {
    const parsed = z.object({ keyword: z.string(), limit: z.number().int().min(1).max(50).default(10) }).parse(args);
    const result = await runtime.searchItems(parsed.keyword, parsed.limit);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  if (name === 'get_item_detail') {
    const parsed = z.object({ item_id: z.string().optional(), url: z.string().optional() }).refine(v => v.item_id || v.url, 'item_id or url is required').parse(args);
    const result = await runtime.getItemDetail(parsed);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  if (name === 'monitor_keyword') {
    const parsed = z.object({ keyword: z.string(), max_items: z.number().int().min(1).max(100).default(20), dedupe_key: z.string().default('item_id') }).parse(args);
    const result = await runtime.monitorKeyword(parsed.keyword, parsed.max_items, parsed.dedupe_key);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  if (name === 'publish_item') {
    const parsed = z.object({
      title: z.string(),
      desc: z.string(),
      price_yuan: z.number(),
      category_id: z.string().optional(),
      images: z.array(z.string()).optional(),
    }).parse(args);
    const result = await runtime.publishItem(parsed);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
