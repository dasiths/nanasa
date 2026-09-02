import type { Schema } from "../index.js";
import { CONTROL_API_PREFIX, NanasaControlClient } from "../index.js";

export function path(...segments: string[]): string {
  return `${CONTROL_API_PREFIX}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

export function commandInit(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body: unknown,
  idempotencyKey?: string,
): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
    },
    body: JSON.stringify(body),
  };
}

export function query(values: Record<string, string | number | boolean | undefined>): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) parameters.set(key, String(value));
  }
  return parameters.size === 0 ? "" : `?${parameters.toString()}`;
}

export function request<T>(
  client: NanasaControlClient,
  route: string,
  schema: Schema<T>,
  init?: RequestInit,
): Promise<T> {
  return client.request(route, schema, { ...(init === undefined ? {} : { init }) });
}
