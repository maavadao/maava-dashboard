'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * OAuth callback landing page for Zernio social account connections.
 *
 * Zernio redirects the user's browser here after social platform OAuth.
 * URL: /seller/social-accounts/oauth-callback?connected=<platform>&profileId=...&accountId=...&username=...&connect_token=...
 *
 * This page:
 *  1. Sends the params to the configuration-api backend to save the connection
 *  2. PostMessages the result to the opener window (the dashboard)
 *  3. Closes itself automatically
 */
export default function OAuthCallbackPage() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const platform = searchParams.get('connected');
    const profileId = searchParams.get('profileId');
    const accountId = searchParams.get('accountId');
    const username = searchParams.get('username') ?? undefined;
    const connectToken = searchParams.get('connect_token') ?? undefined;

    if (!platform || !profileId || !accountId) {
      setStatus('error');
      setMessage('Missing required parameters.');
      notifyOpener({ type: 'zernio-oauth-error', error: 'Missing required parameters.' });
      return;
    }

    const params = new URLSearchParams({ connected: platform, profileId, accountId });
    if (username) params.set('username', username);
    if (connectToken) params.set('connect_token', connectToken);

    // Call the backend to save the connection.
    // Uses same-origin relative URL so auth cookies are sent automatically.
    fetch(`/api/seller/social-accounts/callback?${params.toString()}`, {
      credentials: 'same-origin',
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(data?.error || `Request failed (${res.status})`);
        }
        setStatus('success');
        notifyOpener({ type: 'zernio-oauth-success', platform });
        setTimeout(() => window.close(), 1500);
      })
      .catch((err: Error) => {
        setStatus('error');
        setMessage(err.message || 'Connection failed.');
        notifyOpener({ type: 'zernio-oauth-error', error: err.message || 'Connection failed.' });
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{
      fontFamily: 'system-ui, sans-serif',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      margin: 0,
      background: '#f9fafb',
    }}>
      <div style={{
        background: 'white',
        borderRadius: 12,
        padding: '32px 40px',
        textAlign: 'center',
        boxShadow: '0 4px 24px rgba(0,0,0,.08)',
        maxWidth: 340,
      }}>
        {status === 'loading' && (
          <>
            <div style={{ fontSize: 36, marginBottom: 16 }}>⏳</div>
            <h2 style={{ margin: '0 0 8px', fontSize: 18, color: '#111' }}>Connecting…</h2>
            <p style={{ margin: 0, fontSize: 14, color: '#6b7280' }}>Please wait while we finish connecting your account.</p>
          </>
        )}
        {status === 'success' && (
          <>
            <div style={{ fontSize: 36, marginBottom: 16 }}>✅</div>
            <h2 style={{ margin: '0 0 8px', fontSize: 18, color: '#111' }}>Connected!</h2>
            <p style={{ margin: 0, fontSize: 14, color: '#6b7280' }}>This window will close automatically.</p>
          </>
        )}
        {status === 'error' && (
          <>
            <div style={{ fontSize: 36, marginBottom: 16 }}>❌</div>
            <h2 style={{ margin: '0 0 8px', fontSize: 18, color: '#111' }}>Connection failed</h2>
            <p style={{ margin: 0, fontSize: 14, color: '#6b7280' }}>{message}</p>
            <button
              onClick={() => window.close()}
              style={{ marginTop: 16, padding: '8px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', fontSize: 14 }}
            >
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function notifyOpener(data: Record<string, string>) {
  try {
    if (window.opener) {
      window.opener.postMessage(data, '*');
    }
  } catch (_) {
    // opener may be from a different origin in some browsers
  }
}
