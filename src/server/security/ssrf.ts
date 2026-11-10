import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from 'undici';

export class SsrfBlockedError extends Error {
  constructor(
    readonly reason: string,
    readonly target: string,
  ) {
    super(`destino bloqueado (${reason}): ${target}`);
  }
}

export class FetchLimitError extends Error {}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_PORTS = new Set(['', '80', '443']);

/**
 * Exceções explícitas para desenvolvimento local (ex.: servidor MCP demo em localhost:3100).
 * Formato: host:porta separados por vírgula. Vazio em produção.
 */
function devAllowList(): Set<string> {
  return new Set(
    (process.env.SSRF_ALLOW_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Somente unicast público. Bloqueia privado, loopback, link-local (inclui 169.254.169.254), CGNAT, multicast etc. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);
  if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address();
  return ip.range() === 'unicast';
}

function hostKey(url: URL) {
  return `${url.hostname.toLowerCase().replace(/^\[|\]$/g, '')}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}

export function assertUrlAllowed(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError('url_invalida', String(raw));
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) throw new SsrfBlockedError('esquema', url.protocol);
  if (url.username || url.password) throw new SsrfBlockedError('credenciais_na_url', url.host);
  if (devAllowList().has(hostKey(url))) return url;
  if (!ALLOWED_PORTS.has(url.port)) throw new SsrfBlockedError('porta', url.host);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !isPublicAddress(host)) throw new SsrfBlockedError('ip_nao_publico', host);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new SsrfBlockedError('host_interno', host);
  }
  return url;
}

/**
 * Lookup usado na conexão: valida o IP que será efetivamente conectado.
 * Validar no momento da conexão (e não antes) fecha a janela de DNS rebinding.
 */
function guardedLookup(hostname: string, options: object, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as LookupAddress[];
    const allowedDev = [...devAllowList()].some((h) => h.startsWith(`${hostname.toLowerCase()}:`));
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad && !allowedDev) {
      return callback(Object.assign(new SsrfBlockedError('dns_ip_nao_publico', `${hostname} → ${bad.address}`), { code: 'ESSRF' }), '');
    }
    if ((options as { all?: boolean }).all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

const agent = new Agent({ connect: { lookup: guardedLookup as never, timeout: 10_000 } });

export type SafeFetchOptions = {
  method?: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Cabeçalhos sensíveis só seguem para a origem original; redirect para outra origem os descarta. */
  sensitiveHeaders?: string[];
  signal?: AbortSignal;
};

export type SafeFetchResult = { url: string; status: number; headers: Headers; body: Buffer; truncated: boolean };

/** fetch com SSRF guard em cada salto de redirect, limite de tempo e de bytes (após descompressão). */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 15_000), ...(opts.signal ? [opts.signal] : [])]);
  const sensitive = new Set((opts.sensitiveHeaders ?? ['authorization', 'cookie', 'x-api-key']).map((h) => h.toLowerCase()));
  const origin = assertUrlAllowed(rawUrl).origin;

  let url = assertUrlAllowed(rawUrl);
  let method = opts.method ?? 'GET';
  let body = opts.body;
  for (let hop = 0; ; hop++) {
    const headers = Object.fromEntries(
      Object.entries(opts.headers ?? {}).filter(([k]) => url.origin === origin || !sensitive.has(k.toLowerCase())),
    );
    let res: UndiciResponse;
    try {
      res = await undiciFetch(url, { method, headers, body, redirect: 'manual', signal, dispatcher: agent });
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof SsrfBlockedError) throw cause;
      throw err;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      if (hop >= maxRedirects) throw new FetchLimitError('redirects demais');
      url = assertUrlAllowed(new URL(res.headers.get('location')!, url));
      if (res.status !== 307 && res.status !== 308) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          chunks.push(Buffer.from(value.subarray(0, value.byteLength - (size - maxBytes))));
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(Buffer.from(value));
      }
    }
    return { url: url.toString(), status: res.status, headers: res.headers as unknown as Headers, body: Buffer.concat(chunks), truncated };
  }
}

/**
 * Adaptador com a assinatura de fetch para SDKs (ex.: transporte MCP). Sem timeout próprio:
 * streams SSE do transporte são longos; o chamador limita cada operação.
 */
export function guardedFetchLike() {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = assertUrlAllowed(typeof input === 'string' || input instanceof URL ? input : input.url);
    const res = await undiciFetch(url, { ...(init as object), redirect: 'error', dispatcher: agent } as never);
    return res as unknown as Response;
  };
}
