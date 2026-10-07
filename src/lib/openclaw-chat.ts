/**
 * OpenClaw chat client.
 * Uses Barrsa API key for auth; requests go through /api/ai-chat proxy.
 */

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type ChatCompletionOptions = {
  apiKey: string;
  messages: ChatMessage[];
  stream?: boolean;
  model?: string;
};

export type ChatCompletionResult = {
  id: string;
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

/** Non-streaming chat completion. */
export async function chatComplete(
  options: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  const { apiKey, messages, model = "openclaw" } = options;
  const body = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
  };

  let res: Response;
  try {
    res = await fetch("/api/ai-chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      "Unable to connect. Please check your network and try again."
    );
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      error?: string | { message?: string };
    };
    const message =
      typeof err?.error === "string"
        ? err.error
        : err?.error &&
          typeof err.error === "object" &&
          typeof err.error.message === "string"
        ? err.error.message
        : res.status === 401
        ? "Please log in again. Your session may have expired."
        : res.status === 502 || res.status === 503
        ? "OpenClaw gateway is unavailable. Please try again later."
        : res.status >= 500
        ? "OpenClaw server error. Please try again later."
        : `Chat request failed (${res.status}). Please try again.`;
    throw new Error(message);
  }

  const data = (await res.json()) as {
    id?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content =
    data.choices?.[0]?.message?.content ?? "No response from OpenClaw.";

  return {
    id: data.id ?? `chat_${Date.now()}`,
    content,
    usage: data.usage
      ? {
          prompt_tokens: data.usage.prompt_tokens ?? 0,
          completion_tokens: data.usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}

/** Streaming chat completion. Yields content chunks. */
export async function* chatCompleteStream(
  options: ChatCompletionOptions
): AsyncGenerator<string, void, unknown> {
  const { apiKey, messages, model = "openclaw" } = options;
  const body = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
  };

  let res: Response;
  try {
    res = await fetch("/api/ai-chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      "Unable to connect. Please check your network and try again."
    );
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      error?: string | { message?: string };
    };
    const message =
      typeof err?.error === "string"
        ? err.error
        : err?.error &&
          typeof err.error === "object" &&
          typeof err.error.message === "string"
        ? err.error.message
        : res.status === 401
        ? "Please log in again. Your session may have expired."
        : res.status === 502 || res.status === 503
        ? "OpenClaw gateway is unavailable. Please try again later."
        : res.status >= 500
        ? "OpenClaw server error. Please try again later."
        : `Chat request failed (${res.status}). Please try again.`;
    throw new Error(message);
  }

  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("No response stream");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) buffer += tail;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const json = line.slice(6).trim();
          if (json === "[DONE]") continue;
          try {
            const obj = JSON.parse(json) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const content = obj.choices?.[0]?.delta?.content;
            if (content) yield content;
          } catch {
            // skip malformed lines
          }
        }
      }
    }
    // Process any remaining buffer after stream ends
    if (buffer.trim() && buffer.trim().startsWith("data: ")) {
      const json = buffer.trim().slice(6).trim();
      if (json !== "[DONE]") {
        try {
          const obj = JSON.parse(json) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const content = obj.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch { /* skip malformed */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
