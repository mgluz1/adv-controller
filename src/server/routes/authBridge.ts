import type { Request, Response } from "express";
import type { Deps } from "./context.ts";

/** Encaminha uma chamada ao Better Auth pelo handler completo (mantém limite de taxa e checagem de origem). */
export async function viaAuthHandler(deps: Deps, req: Request, path: string, body: unknown) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers))
    if (typeof v === "string" && !["content-length", "content-type", "transfer-encoding"].includes(k)) headers.set(k, v);
  headers.set("content-type", "application/json");
  headers.set("x-forwarded-for", req.ip || "127.0.0.1"); // IP validado pelo Express, não o do cliente
  return deps.auth.handler(new Request(deps.env.appUrl + path, { method: "POST", headers, body: JSON.stringify(body ?? {}) }));
}

export function forwardCookies(from: globalThis.Response, res: Response) {
  for (const c of from.headers.getSetCookie()) res.append("Set-Cookie", c);
}
