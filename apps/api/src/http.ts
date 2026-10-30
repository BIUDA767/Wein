import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Logger } from "@phirst/core";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: unknown;
  ip: string;
  cookies: Record<string, string>;
  params: Record<string, string>;
}

export type Handler = (ctx: RequestContext) => Promise<void> | void;

export interface Route {
  method: string;
  pattern: string;
  handler: Handler;
  auth: boolean;
}

export function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

export function error(res: ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}): void {
  json(res, status, { error: message, ...extra });
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Match a route pattern like /api/brokers/:id against a pathname. */
function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const a = pathname.split("/").filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(":")) params[p[i]!.slice(1)] = decodeURIComponent(a[i]!);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

export class Router {
  private routes: Route[] = [];
  private notFound: Handler = (_ctx) => {};

  constructor(private log: Logger) {}

  add(method: string, pattern: string, handler: Handler, auth = true): void {
    this.routes.push({ method, pattern, handler, auth });
  }

  get(pattern: string, handler: Handler, auth = true) { this.add("GET", pattern, handler, auth); }
  post(pattern: string, handler: Handler, auth = true) { this.add("POST", pattern, handler, auth); }
  put(pattern: string, handler: Handler, auth = true) { this.add("PUT", pattern, handler, auth); }
  patch(pattern: string, handler: Handler, auth = true) { this.add("PATCH", pattern, handler, auth); }
  delete(pattern: string, handler: Handler, auth = true) { this.add("DELETE", pattern, handler, auth); }

  setNotFound(handler: Handler): void {
    this.notFound = handler;
  }

  /** Set by the app: resolves a session cookie to a user id, or null. */
  authenticate: (token: string) => Promise<string | null> = async () => null;

  listen(port: number, host = "0.0.0.0"): Promise<void> {
    const server = createServer((req, res) => {
      void this.dispatch(req, res);
    });
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        this.log.info("api listening", { port, host });
        resolve();
      });
    });
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown").split(",")[0]!.trim();
    const cookies = parseCookies(req.headers.cookie);

    let matched = false;
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const params = matchPath(route.pattern, url.pathname);
      if (!params) continue;
      matched = true;

      if (route.auth) {
        const token = cookies["phirst_session"] ?? (req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "");
        const userId = token ? await this.authenticate(token) : null;
        if (!userId) {
          error(res, 401, "Authentication required");
          return;
        }
      }

      try {
        const body = req.method === "GET" || req.method === "HEAD" ? null : await readBody(req);
        await route.handler({ req, res, url, body, ip, cookies, params });
      } catch (err) {
        const message = (err as Error).message;
        this.log.error("request failed", { path: url.pathname, method: req.method, error: message });
        if (!res.headersSent) error(res, 500, message);
      }
      return;
    }

    if (!matched) {
      await this.notFound({ req, res, url, body: null, ip, cookies, params: {} });
    }
  }
}
