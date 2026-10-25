// Chord's operator-message API. Notifications are posted by taking over the owner's thread,
// sending one message, and handing the thread back. Every failure comes back as a result, never a throw.

import type { ChordConfig } from "../config.js";

export const OPERATOR_USER_ID = "ouida-mcp";
const TIMEOUT_MS = 10_000;

export type { ChordConfig };

export interface OwnerThread {
  id: string;
  participantId?: string;
}

export type ChordFailure =
  | { kind: "auth" }
  | { kind: "busy" } // 409 INVALID_STATE: someone already holds the thread
  | { kind: "unavailable"; error: string } // network, timeout, 5xx: the job may be retried
  | { kind: "rejected"; error: string }; // any other 4xx: retrying won't help

export type FindThreadResult = { ok: true; thread: OwnerThread | null } | { ok: false; failure: ChordFailure };
export type TakeOverResult = { ok: true } | { ok: false; failure: ChordFailure };
export type PostMessageResult =
  | { ok: true; deliveryStatus: string; deliveryError?: string }
  | { ok: false; failure: ChordFailure };
export type HandBackResult = { ok: true } | { ok: false; failure: ChordFailure };

export interface ChordClient {
  findOwnerThread(): Promise<FindThreadResult>;
  takeOver(threadId: string, reason: string): Promise<TakeOverResult>;
  postMessage(threadId: string, text: string): Promise<PostMessageResult>;
  handBack(threadId: string, reason: string): Promise<HandBackResult>;
}

export function createChordClient(config: ChordConfig, { timeoutMs = TIMEOUT_MS }: { timeoutMs?: number } = {}): ChordClient {
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown } | { failure: ChordFailure }> {
    try {
      const res = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = await res.json().catch(() => null);
      const failure = classify(res.status, json);
      if (failure) return { failure };
      return { status: res.status, json };
    } catch (err) {
      return { failure: { kind: "unavailable", error: err instanceof Error ? err.message : String(err) } };
    }
  }

  return {
    async findOwnerThread() {
      const query = new URLSearchParams({
        workspace_id: config.workspaceId,
        agent_id: config.menuTeammateId,
        channel_id: "external_chat",
        status: "open",
        limit: "1",
      });
      const r = await call("GET", `/v1/threads?${query}`);
      if ("failure" in r) return { ok: false, failure: r.failure };
      const thread = firstThread(r.json);
      return { ok: true, thread };
    },

    async takeOver(threadId, reason) {
      const r = await call("POST", `/v1/threads/${encodeURIComponent(threadId)}/take-over`, {
        operator_user_id: OPERATOR_USER_ID,
        reason,
      });
      return "failure" in r ? { ok: false, failure: r.failure } : { ok: true };
    },

    async postMessage(threadId, text) {
      const r = await call("POST", `/v1/threads/${encodeURIComponent(threadId)}/messages`, {
        operator_user_id: OPERATOR_USER_ID,
        text,
      });
      if ("failure" in r) return { ok: false, failure: r.failure };
      const delivery = deliveryOf(r.json);
      return { ok: true, deliveryStatus: delivery.status ?? "sent", ...(delivery.error ? { deliveryError: delivery.error } : {}) };
    },

    async handBack(threadId, reason) {
      const r = await call("POST", `/v1/threads/${encodeURIComponent(threadId)}/hand-back`, {
        operator_user_id: OPERATOR_USER_ID,
        reason,
      });
      return "failure" in r ? { ok: false, failure: r.failure } : { ok: true };
    },
  };
}

function classify(status: number, json: unknown): ChordFailure | null {
  if (status === 401 || status === 403) return { kind: "auth" };
  if (status === 409 && JSON.stringify(json ?? "").includes("INVALID_STATE")) return { kind: "busy" };
  if (status >= 500 || status === 429) return { kind: "unavailable", error: `Chord ${status}` };
  if (status >= 400) return { kind: "rejected", error: `Chord ${status}: ${errorText(json)}` };
  return null;
}

function errorText(json: unknown): string {
  const obj = asRecord(json);
  const message = obj?.message ?? obj?.error ?? obj?.detail;
  return typeof message === "string" ? message : "request failed";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstThread(json: unknown): OwnerThread | null {
  const list = Array.isArray(json)
    ? json
    : (["data", "threads", "items", "results"] as const)
        .map((key) => asRecord(json)?.[key])
        .find(Array.isArray);
  const row = asRecord(Array.isArray(list) ? list[0] : undefined);
  if (!row) return null;
  const id = typeof row.id === "string" ? row.id : typeof row.thread_id === "string" ? row.thread_id : "";
  if (!id) return null;
  const participant = asRecord(row.participant);
  const participantId =
    typeof row.participant_id === "string"
      ? row.participant_id
      : typeof row.participant === "string"
        ? row.participant
        : typeof participant?.id === "string"
          ? participant.id
          : undefined;
  return { id, ...(participantId ? { participantId } : {}) };
}

function deliveryOf(json: unknown): { status?: string; error?: string } {
  const obj = asRecord(json);
  const nested = asRecord(obj?.data) ?? asRecord(obj?.message) ?? obj;
  const status = typeof nested?.delivery_status === "string" ? nested.delivery_status : undefined;
  const error = typeof nested?.delivery_error === "string" ? nested.delivery_error : undefined;
  return { status, ...(error ? { error } : {}) };
}
