'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

/**
 * OAuth callback page for Zernio social account connection.
 *
 * Zernio redirects here after the user authorizes on the platform.
 * We extract `code` and `state` from the URL, then post them back
 * to the opener window via `postMessage`, which completes the flow.
 */
export default function OAuthCallbackPage() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const errorParam = searchParams.get('error');

    // Extract platform from the state or from a custom query param
    // Zernio encodes platform in the state, but we pass it explicitly too
    const platform = searchParams.get('platform') || '';

    if (errorParam) {
      setStatus('error');
      setErrorMsg(searchParams.get('error_description') || errorParam);
      return;
    }

    if (!code || !state) {
      setStatus('error');
      setErrorMsg('Missing authorization code or state parameter.');
      return;
    }

    // Send the code back to the parent window
    if (window.opener) {
      window.opener.postMessage(
        { type: 'zernio-oauth-callback', code, state, platform },
        window.location.origin
      );
      setStatus('success');
      // Auto-close after a short delay
      setTimeout(() => window.close(), 1500);
    } else {
      setStatus('error');
      setErrorMsg('This page must be opened as a popup from the maavaDao dashboard.');
    }
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="text-center max-w-sm">
        {status === 'processing' && (
          <>
            <Loader2 className="h-10 w-10 animate-spin text-primary mx-auto mb-4" />
            <h1 className="text-lg font-semibold text-foreground">Connecting account...</h1>
            <p className="text-sm text-muted-foreground mt-2">
              Please wait while we complete the connection.
            </p>
          </>
        )}
        {status === 'success' && (
          <>
            <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto mb-4" />
            <h1 className="text-lg font-semibold text-foreground">Account Connected!</h1>
            <p className="text-sm text-muted-foreground mt-2">
              This window will close automatically.
            </p>
          </>
        )}
        {status === 'error' && (
          <>
            <AlertCircle className="h-10 w-10 text-red-500 mx-auto mb-4" />
            <h1 className="text-lg font-semibold text-foreground">Connection Failed</h1>
            <p className="text-sm text-muted-foreground mt-2">
              {errorMsg || 'Something went wrong. Please close this window and try again.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
