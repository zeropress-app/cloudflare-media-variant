export interface Env {
  MEDIA_BUCKET: R2Bucket;
  IMAGES: ImagesBinding;
  ALLOWED_PREFIXES: string;
  DEBUG_LOGS_ENABLED?: string;
  DISABLE_CACHE?: string;
}

type ResizeFit = 'contain' | 'cover' | 'scale-down';
type ResizeFormat = 'auto' | 'webp' | 'avif' | 'png' | 'jpeg';
type OutputFormat = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/avif';

interface ResizeOptions {
  width?: number;
  height?: number;
  fit?: ResizeFit;
  format?: ResizeFormat;
  quality?: number;
}

interface RequestConfig {
  allowedPrefixes: string[];
  debugEnabled: boolean;
  cacheDisabled: boolean;
}

const SUPPORTED_QUERY_KEYS = new Set(['w', 'h', 'fit', 'format', 'q']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);
const MIME_TYPES: Record<string, string> = {
  avif: 'image/avif',
  css: 'text/css; charset=UTF-8',
  gif: 'image/gif',
  html: 'text/html; charset=UTF-8',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript; charset=UTF-8',
  json: 'application/json; charset=UTF-8',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=UTF-8',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  xml: 'application/xml; charset=UTF-8',
};
const AUTO_FALLBACK_FORMAT_BY_EXTENSION: Record<string, OutputFormat> = {
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const app = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      const config = readRequestConfig(env);

      if (method !== 'GET' && method !== 'HEAD') {
        return textResponse('Method Not Allowed', 405, {
          Allow: 'GET, HEAD',
        });
      }

      const r2Key = extractR2Key(url.pathname);
      if (!r2Key) {
        return textResponse('Not Found', 404);
      }

      if (!isAllowedKey(r2Key, config.allowedPrefixes)) {
        debugLog(config, `Denied path outside allowlist: ${r2Key}`);
        return textResponse('Not Found', 404);
      }

      const resizeOptions = parseResizeOptions(url.searchParams);
      if (!resizeOptions) {
        return handleOriginalRequest(request, env, ctx, config, r2Key);
      }

      if (!isImageKey(r2Key)) {
        return textResponse('Resize is supported only for image assets', 400);
      }

      return handleVariantRequest(request, env, ctx, config, url, r2Key, resizeOptions);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid ')) {
        return textResponse(error.message, 400);
      }

      console.error('[media-variant] Unhandled error:', error);
      return textResponse('Internal Server Error', 500);
    }
  },
};

export default app;

function readRequestConfig(env: Env): RequestConfig {
  const allowedPrefixes = (env.ALLOWED_PREFIXES || '')
    .split(',')
    .map((entry) => entry.trim().replace(/^\/+/, ''))
    .filter(Boolean);

  if (allowedPrefixes.length === 0) {
    throw new Error('ALLOWED_PREFIXES must contain at least one prefix');
  }

  return {
    allowedPrefixes,
    debugEnabled: env.DEBUG_LOGS_ENABLED === 'true',
    cacheDisabled: env.DISABLE_CACHE === 'true',
  };
}

function extractR2Key(pathname: string): string | null {
  const raw = pathname.replace(/^\/+/, '');
  if (!raw) return null;

  try {
    const decoded = decodeURIComponent(raw);
    if (!decoded || decoded === '.' || decoded === '..') return null;
    if (decoded.includes('\0')) return null;
    return decoded;
  } catch {
    return null;
  }
}

function isAllowedKey(r2Key: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => r2Key.startsWith(prefix));
}

function parseResizeOptions(searchParams: URLSearchParams): ResizeOptions | null {
  const recognizedEntries = Array.from(searchParams.entries()).filter(([key]) => SUPPORTED_QUERY_KEYS.has(key));
  if (recognizedEntries.length === 0) {
    if (searchParams.size > 0) {
      throw new Error('Invalid resize query parameters');
    }
    return null;
  }

  const width = parsePositiveInt(searchParams.get('w'), 'w');
  const height = parsePositiveInt(searchParams.get('h'), 'h');
  const fit = parseFit(searchParams.get('fit'));
  const format = parseFormat(searchParams.get('format'));
  const quality = parseQuality(searchParams.get('q'));

  if (width === undefined && height === undefined) {
    return null;
  }

  return {
    width,
    height,
    fit,
    format,
    quality,
  };
}

function parsePositiveInt(value: string | null, key: string): number | undefined {
  if (value == null || value === '') return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${key} value`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 4096) {
    throw new Error(`Invalid ${key} value`);
  }

  return parsed;
}

function parseFit(value: string | null): ResizeFit | undefined {
  if (value == null || value === '') return undefined;
  if (value === 'contain' || value === 'cover' || value === 'scale-down') {
    return value;
  }

  throw new Error('Invalid fit value');
}

function parseFormat(value: string | null): ResizeFormat | undefined {
  if (value == null || value === '') return undefined;
  if (value === 'auto' || value === 'webp' || value === 'avif' || value === 'png' || value === 'jpeg') {
    return value;
  }

  throw new Error('Invalid format value');
}

function parseQuality(value: string | null): number | undefined {
  if (value == null || value === '') return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error('Invalid q value');
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('Invalid q value');
  }

  return parsed;
}

async function handleOriginalRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: RequestConfig,
  r2Key: string,
): Promise<Response> {
  const cacheKey = buildCacheRequest(new URL(request.url), request.headers, null);
  const cached = config.cacheDisabled ? null : await caches.default.match(cacheKey);

  if (cached) {
    debugLog(config, `Original cache hit: ${r2Key}`);
    return request.method === 'HEAD' ? stripBody(cached) : cached;
  }

  const object = request.method === 'HEAD'
    ? await env.MEDIA_BUCKET.head(r2Key)
    : await env.MEDIA_BUCKET.get(r2Key);

  if (!object) {
    return textResponse('Not Found', 404);
  }

  const response = buildObjectResponse(request.method, object, r2Key);
  if (!config.cacheDisabled && request.method === 'GET') {
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  }

  return response;
}

async function handleVariantRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: RequestConfig,
  url: URL,
  r2Key: string,
  resizeOptions: ResizeOptions,
): Promise<Response> {
  const object = await env.MEDIA_BUCKET.get(r2Key);
  if (!object || !object.body) {
    return textResponse('Not Found', 404);
  }

  const outputFormat = resolveOutputFormat(r2Key, resizeOptions.format, request.headers.get('Accept'));
  const autoFormatVariant = resizeOptions.format === 'auto' ? outputFormat : null;
  const cacheKey = buildCacheRequest(url, request.headers, autoFormatVariant);
  const cached = config.cacheDisabled ? null : await caches.default.match(cacheKey);

  if (cached) {
    debugLog(config, `Variant cache hit: ${r2Key}`);
    return request.method === 'HEAD' ? stripBody(cached) : cached;
  }

  try {
    const transformed = await env.IMAGES
      .input(object.body)
      .transform({
        width: resizeOptions.width,
        height: resizeOptions.height,
        fit: resizeOptions.fit,
      })
      .output({
        format: outputFormat,
        quality: resizeOptions.quality,
      });

    const transformedResponse = await transformed.response();
    const response = request.method === 'HEAD' ? stripBody(transformedResponse) : transformedResponse;
    const cacheable = withCacheHeaders(response, resizeOptions.format === 'auto');

    if (!config.cacheDisabled && request.method === 'GET' && cacheable.ok) {
      ctx.waitUntil(caches.default.put(cacheKey, cacheable.clone()));
    }

    return cacheable;
  } catch (error) {
    console.error('[media-variant] Transform failed:', error);
    return textResponse('Unable to transform image', 500);
  }
}

function resolveOutputFormat(
  r2Key: string,
  requestedFormat: ResizeFormat | undefined,
  acceptHeader: string | null,
): OutputFormat {
  if (requestedFormat === 'avif') return 'image/avif';
  if (requestedFormat === 'webp') return 'image/webp';
  if (requestedFormat === 'png') return 'image/png';
  if (requestedFormat === 'jpeg') return 'image/jpeg';

  const normalizedAccept = (acceptHeader || '').toLowerCase();
  if (normalizedAccept.includes('image/avif')) return 'image/avif';
  if (normalizedAccept.includes('image/webp')) return 'image/webp';

  return AUTO_FALLBACK_FORMAT_BY_EXTENSION[getExtension(r2Key)] || 'image/png';
}

function buildObjectResponse(method: string, object: R2ObjectBody | R2Object, r2Key: string): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('cache-control', getCacheControl());

  if (!headers.has('content-type')) {
    headers.set('content-type', inferMimeType(r2Key));
  }

  if ('httpEtag' in object && object.httpEtag) {
    headers.set('etag', object.httpEtag);
  }

  if ('size' in object && typeof object.size === 'number') {
    headers.set('content-length', String(object.size));
  }

  const body = method === 'HEAD' || !('body' in object) ? null : object.body;
  return new Response(body, {
    status: 200,
    headers,
  });
}

function inferMimeType(r2Key: string): string {
  const extension = getExtension(r2Key);
  return MIME_TYPES[extension] || 'application/octet-stream';
}

function getExtension(r2Key: string): string {
  const lastSegment = r2Key.split('/').pop() || '';
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex < 0) return '';
  return lastSegment.slice(dotIndex + 1).toLowerCase();
}

function isImageKey(r2Key: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(r2Key));
}

function getCacheControl(): string {
  return 'public, max-age=31536000, immutable';
}

function buildCacheRequest(url: URL, headers: Headers, autoFormatVariant: string | null): Request {
  const normalizedUrl = new URL(url.toString());
  const keptEntries = Array.from(normalizedUrl.searchParams.entries())
    .filter(([key]) => SUPPORTED_QUERY_KEYS.has(key))
    .sort(([keyA, valueA], [keyB, valueB]) => (
      keyA === keyB ? valueA.localeCompare(valueB) : keyA.localeCompare(keyB)
    ));

  normalizedUrl.search = '';
  for (const [key, value] of keptEntries) {
    normalizedUrl.searchParams.append(key, value);
  }
  if (autoFormatVariant) {
    normalizedUrl.searchParams.set('__auto_format', autoFormatVariant);
  }

  return new Request(normalizedUrl.toString(), {
    method: 'GET',
    headers,
  });
}

function stripBody(response: Response): Response {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function withCacheHeaders(response: Response, varyAccept: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', getCacheControl());
  if (varyAccept) {
    headers.set('vary', 'Accept');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function textResponse(message: string, status: number, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'text/plain; charset=UTF-8');
  return new Response(message, { status, headers });
}

function debugLog(config: RequestConfig, message: string): void {
  if (config.debugEnabled) {
    console.log(`[media-variant] ${message}`);
  }
}
