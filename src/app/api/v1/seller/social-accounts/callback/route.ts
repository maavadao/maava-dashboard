import { type NextRequest, NextResponse } from 'next/server';

const CONFIGURATION_API = (
  process.env.MAAVADAO_API_URL || 'https://maavadao.com/api/v1'
).replace(/\/+$/, '');

/**
 * GET /api/v1/seller/social-accounts/callback
 *
 * Zernio redirects the user's browser here after OAuth.
 * We proxy the request to maava-api which saves the connection and
 * returns an HTML page that postMessages the result back to the opener popup.
 *
 * No auth required — the user identity is resolved server-side via profileId.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Validate required params early so we can show a friendly error page
  const platform = searchParams.get('connected');
  const profileId = searchParams.get('profileId');
  const accountId = searchParams.get('accountId');

  if (!platform || !profileId || !accountId) {
    return buildHtmlResponse(false, 'Missing required callback parameters', platform ?? '');
  }

  try {
    const backendUrl = `${CONFIGURATION_API}/seller/social-accounts/callback?${searchParams.toString()}`;
    const res = await fetch(backendUrl, { cache: 'no-store' });
    const html = await res.text();
    return new NextResponse(html, {
      status: res.status,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (err) {
    console.error('[OAuth callback] Backend fetch error:', err);
    return buildHtmlResponse(false, 'Connection service unavailable. Please try again.', platform);
  }
}

function buildHtmlResponse(ok: boolean, message: string, platform: string) {
  const payload = ok
    ? JSON.stringify({ type: 'zernio-oauth-success', platform })
    : JSON.stringify({ type: 'zernio-oauth-error', error: message });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${ok ? 'Connected!' : 'Connection failed'}</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; }
    .card { background: white; border-radius: 12px; padding: 32px 40px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,.08); max-width: 340px; }
    .icon { font-size: 40px; margin-bottom: 16px; }
    h2 { margin: 0 0 8px; font-size: 18px; color: #111; }
    p { margin: 0; font-size: 14px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${ok ? '✅' : '❌'}</div>
    <h2>${ok ? 'Connected successfully!' : 'Connection failed'}</h2>
    <p>${ok ? 'This window will close automatically.' : message}</p>
  </div>
  <script>
    (function () {
      try {
        if (window.opener) {
          window.opener.postMessage(${payload}, '*');
        }
      } catch (_) {}
      setTimeout(function () { window.close(); }, 1500);
    })();
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
