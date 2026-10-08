// ─── mawa proxy — forward Slack messages to per-user mawa instances ───


interface GatewayProxyInput {
  mawadaoUserId: string;
  tenantId?: string | null;
  tenantSubdomain?: string | null;
  gatewayInstanceUrl?: string | null;
  authToken?: string | null;
  message: string;
  sessionKey: string;
  channelMeta: {
    platform: 'slack';
    teamId: string;
    channelId: string;
    userId: string;
    threadTs: string | null;
    messageTs: string;
    channelType: string;
    workspaceName: string | null;
  };
}

interface GatewayProxyOutput {
  text: string;
  metadata?: Record<string, unknown>;
}

/**
 * Resolve the mawa runtime URL for a given mawaDao user.
 * Uses the tenant's runtime URL (tenants.backend_url); throws if there is none.
 */
function resolveGatewayUrl(input: GatewayProxyInput): string {
  if (input.gatewayInstanceUrl) {
    return input.gatewayInstanceUrl.replace(/\/+$/, '') + '/v1/chat/completions';
  }

  throw new Error(
    `Cannot resolve mawa URL for user ${input.mawadaoUserId}: no runtime URL for the tenant`,
  );
}

/**
 * Forward a Slack message to the user's mawa instance and return the response.
 * Uses POST /v1/chat/completions (OpenAI-compatible API).
 */
export async function forwardToGateway(input: GatewayProxyInput): Promise<GatewayProxyOutput> {
  const url = resolveGatewayUrl(input);

  const body = {
    model: 'openclaw',
    messages: [
      {
        role: 'user',
        content: input.message,
      },
    ],
    // Pass Slack context as metadata so mawa skills can use it
    metadata: {
      session_key: input.sessionKey,
      channel: {
        platform: input.channelMeta.platform,
        team_id: input.channelMeta.teamId,
        channel_id: input.channelMeta.channelId,
        user_id: input.channelMeta.userId,
        thread_ts: input.channelMeta.threadTs,
        message_ts: input.channelMeta.messageTs,
        channel_type: input.channelMeta.channelType,
        workspace_name: input.channelMeta.workspaceName,
      },
    },
  };

  console.log(`[gateway-proxy] Forwarding to ${url} for user ${input.mawadaoUserId} (auth=${!!input.authToken}, tenant=${input.tenantId ?? 'none'})`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (input.authToken) {
    headers['Authorization'] = `Bearer ${input.authToken}`;
  }
  if (input.tenantId) {
    headers['X-Tenant-ID'] = input.tenantId;
  }
  if (input.sessionKey) {
    headers['X-OpenClaw-Session-Key'] = input.sessionKey;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000), // 5min timeout – backend can take 80-300s
    });
  } catch (fetchErr: any) {
    console.error(`[gateway-proxy] fetch failed for ${url}:`, fetchErr?.message, fetchErr?.cause);
    throw fetchErr;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown');
    console.error(`[gateway-proxy] HTTP ${response.status} from mawa: ${errorText}`);
    throw new Error(`mawa returned HTTP ${response.status}`);
  }

  const data = await response.json();

  // OpenAI-compatible response format
  const assistantMessage =
    data.choices?.[0]?.message?.content ?? data.response ?? data.text ?? '';

  return {
    text: assistantMessage || 'I received your message but have no response at this time.',
    metadata: data.metadata,
  };
}

/**
 * Build a deterministic session key for conversation continuity.
 * In DMs: per-user. In channels: per-thread (or channel if no thread).
 */
export function buildSessionKey(
  teamId: string,
  channelId: string,
  threadTs: string | null,
  userId: string,
): string {
  if (threadTs) {
    return `slack:${teamId}:${channelId}:${threadTs}`;
  }
  return `slack:${teamId}:${channelId}:${userId}`;
}
