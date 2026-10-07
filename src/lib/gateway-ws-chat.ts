/**
 * mawaDao Agent chat via Gateway WebSocket.
 * Uses chat.send / chat events (same protocol as Control UI).
 */

// Must match mawaDao Agent gateway PROTOCOL_VERSION (src/gateway/protocol/schema/protocol-schemas.ts)
const PROTOCOL_VERSION = 3;

function httpToWs(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (u.startsWith("https://")) return u.replace("https://", "wss://");
  if (u.startsWith("http://")) return u.replace("http://", "ws://");
  if (u.startsWith("wss://") || u.startsWith("ws://")) return u;
  return `ws://${u}`;
}

function extractTextFromMessage(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const item = p as Record<string, unknown>;
        if (item?.type === "text" && typeof item.text === "string")
          return item.text;
        return null;
      })
      .filter((v): v is string => typeof v === "string");
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (typeof m.text === "string") return m.text;
  return null;
}

type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

export type GatewayWsChatOptions = {
  wsUrl: string;
  apiKey: string;
  sessionKey?: string;
};

export class GatewayWsChat {
  private ws: WebSocket | null = null;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private connected = false;
  private opts: GatewayWsChatOptions;

  constructor(opts: GatewayWsChatOptions) {
    this.opts = { sessionKey: "main", ...opts };
  }

  get isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = httpToWs(this.opts.wsUrl);
      this.ws = new WebSocket(wsUrl);
      const connectId = crypto.randomUUID();

      // Bound the handshake. Without this, a backend that accepts the TCP
      // connection but never replies with `hello-ok` (e.g. wedged gateway,
      // wrong PROTOCOL_VERSION negotiation) leaves the caller waiting
      // forever and the chat UI shows no error.
      const HANDSHAKE_TIMEOUT_MS = 15_000;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        fn();
      };
      const handshakeTimer = setTimeout(() => {
        settle(() => {
          try { this.ws?.close(); } catch { /* ignore */ }
          this.ws = null;
          reject(new Error(`WebSocket handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`));
        });
      }, HANDSHAKE_TIMEOUT_MS);

      const onMsg = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data ?? "")) as Record<
            string,
            unknown
          >;
          if (msg.type !== "res" || msg.id !== connectId) return;
          this.ws?.removeEventListener("message", onMsg);
          if (
            (msg as { ok?: boolean }).ok &&
            (msg.payload as { type?: string })?.type === "hello-ok"
          ) {
            settle(() => {
              this.connected = true;
              resolve();
            });
          } else {
            const err = (msg as { error?: { message?: string } }).error;
            settle(() => reject(new Error(err?.message ?? "Connection rejected")));
          }
        } catch {
          // ignore
        }
      };

      this.ws.addEventListener("open", () => {
        this.sendConnect(connectId);
      });

      this.ws.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(String(ev.data ?? "")) as Record<
            string,
            unknown
          >;
          this.handleMessage(msg);
        } catch {
          // ignore parse errors
        }
      });

      this.ws.addEventListener("message", onMsg);

      this.ws.addEventListener("close", (ev) => {
        this.connected = false;
        this.ws = null;
        // If close fires before the handshake completes, surface it as
        // a connect error instead of leaving the promise pending.
        settle(() => reject(new Error(`Connection closed before handshake: ${ev.reason || ev.code}`)));
        this.rejectPending(
          new Error(`Connection closed: ${ev.reason || ev.code}`)
        );
      });

      this.ws.addEventListener("error", () => {
        settle(() => reject(new Error("WebSocket connection failed")));
      });
    });
  }

  private sendConnect(connectId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        type: "req",
        id: connectId,
        method: "connect",
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "webchat",
            version: "1",
            platform: "web",
            mode: "webchat",
          },
          auth: { token: this.opts.apiKey },
        },
      })
    );
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.type === "res" && typeof msg.id === "string") {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if ((msg as { ok?: boolean }).ok) {
          pending.resolve(msg.payload);
        } else {
          const err = (msg as { error?: { message?: string } }).error;
          pending.reject(new Error(err?.message ?? "Request failed"));
        }
      }
    }
  }

  private rejectPending(err: Error): void {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }
      const id = crypto.randomUUID();
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  async sendMessage(
    message: string,
    onDelta: (text: string) => void,
    onDone: () => void,
    onError: (err: string) => void
  ): Promise<void> {
    if (!this.isConnected) {
      throw new Error("Not connected to mawaDao Agent");
    }

    const runId = crypto.randomUUID();
    const sessionKey = this.opts.sessionKey ?? "main";

    const res = await this.request<{
      ok?: boolean;
      runId?: string;
      status?: string;
    }>("chat.send", {
      sessionKey,
      message: message.trim(),
      deliver: false,
      idempotencyKey: runId,
    });

    if (
      !res?.ok &&
      (res as { status?: string }).status !== "started" &&
      (res as { status?: string }).status !== "in_flight"
    ) {
      throw new Error("Failed to send message");
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let lastEventAt = Date.now();
      const INACTIVITY_MS = 90_000;

      const handler = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data ?? "")) as Record<
            string,
            unknown
          >;
          if (msg.type !== "event" || msg.event !== "chat") return;

          const payload = msg.payload as ChatEventPayload | undefined;
          if (!payload || payload.sessionKey !== sessionKey) return;
          if (payload.runId && payload.runId !== runId) return;

          lastEventAt = Date.now();

          if (payload.state === "delta") {
            const text = extractTextFromMessage(payload.message);
            if (text) onDelta(text);
          } else if (payload.state === "final" || payload.state === "aborted") {
            settle();
            onDone();
            resolve();
          } else if (payload.state === "error") {
            settle();
            onError(payload.errorMessage ?? "Chat error");
            reject(new Error(payload.errorMessage ?? "Chat error"));
          }
        } catch {
          // ignore
        }
      };

      const onClose = (ev: CloseEvent) => {
        if (settled) return;
        settle();
        const msg = `Connection lost (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`;
        onError(msg);
        reject(new Error(`ws_closed_${ev.code}`));
      };

      const inactivityTimer = setInterval(() => {
        if (settled) return;
        if (Date.now() - lastEventAt > INACTIVITY_MS) {
          settle();
          const msg = `No response from agent (${Math.round(INACTIVITY_MS / 1000)}s inactivity)`;
          onError(msg);
          reject(new Error("ws_inactivity_timeout"));
        }
      }, 10_000);

      const onUnload = () => {
        // Best-effort abort so the gateway stops generating tokens for a
        // run the user is about to throw away. We don't await the response
        // because the tab is going away.
        try {
          void this.request("chat.abort", { runId, sessionKey });
        } catch {
          // ignore
        }
      };

      const settle = () => {
        if (settled) return;
        settled = true;
        clearInterval(inactivityTimer);
        this.ws?.removeEventListener("message", handler);
        this.ws?.removeEventListener("close", onClose);
        if (typeof window !== "undefined") {
          window.removeEventListener("pagehide", onUnload);
          window.removeEventListener("beforeunload", onUnload);
        }
      };

      this.ws?.addEventListener("message", handler);
      this.ws?.addEventListener("close", onClose);
      if (typeof window !== "undefined") {
        window.addEventListener("pagehide", onUnload);
        window.addEventListener("beforeunload", onUnload);
      }
    });
  }

  disconnect(): void {
    this.connected = false;
    this.ws?.close();
    this.ws = null;
    this.rejectPending(new Error("Disconnected"));
  }
}

export function resolveGatewayWsUrl(): string {
  const url =
    process.env.NEXT_PUBLIC_GATEWAY_URL ||
    process.env.NEXT_PUBLIC_GATEWAY_UI_URL ||
    process.env.NEXT_PUBLIC_CONFIG_API_URL?.replace(/\/api\/v1\/?$/, '') ||
    "";
  return url.replace(/\/+$/, "");
}
