'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuthStore, useSetupStore } from '@/store';
import { api } from '@/lib/api';
import { Loader2 } from 'lucide-react';

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center space-y-4">
          <Loader2 className="w-16 h-16 mx-auto animate-spin text-primary" />
          <h2 className="text-xl font-semibold text-gray-900">Loading...</h2>
        </div>
      </div>
    }>
      <AuthCallbackInner />
    </Suspense>
  );
}

function AuthCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState('');

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        registrations.forEach((r) => r.unregister());
      });
    }
  }, []);

  useEffect(() => {
    const processCallback = async () => {
      const token = searchParams.get('token');
      const errorParam = searchParams.get('error');

      if (errorParam) {
        setError(`Authentication failed: ${errorParam}`);
        setTimeout(() => router.push('/chat'), 3000);
        return;
      }

      if (!token) {
        setError('No authentication token received');
        setTimeout(() => router.push('/chat'), 3000);
        return;
      }

      try {
        useAuthStore.setState({ token });

        const response = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          throw new Error('Failed to fetch user info');
        }

        const data = await response.json();

        if (data.success && data.data) {
          const rawUsername = data.data.username || data.data.email?.split('@')[0] || '';
          const isAutoUsername = !data.data.username || /^.+_[a-f0-9]{6}$/.test(data.data.username);

          const userData = {
            id: data.data.id,
            email: data.data.email,
            displayName: data.data.displayName,
            avatarUrl: data.data.avatarUrl,
            username: rawUsername,
            isActive: true,
            isVerified: true,
            createdAt: new Date().toISOString(),
          };

          useAuthStore.setState({ user: userData, apiKey: token });
          api.setApiKey(token);

          const { setupComplete } = useSetupStore.getState();
          if (setupComplete && !isAutoUsername) {
            router.push('/chat');
          } else {
            router.push('/chat?step=username');
          }
        } else {
          throw new Error('Invalid response from server');
        }
      } catch (err) {
        console.error('Auth callback error:', err);
        setError('Failed to complete authentication');
        setTimeout(() => router.push('/chat'), 3000);
      }
    };

    processCallback();
  }, [searchParams, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center space-y-4">
        {error ? (
          <>
            <div className="w-16 h-16 mx-auto rounded-full bg-red-100 flex items-center justify-center">
              <span className="text-2xl">&#x274C;</span>
            </div>
            <h2 className="text-xl font-semibold text-gray-900">Authentication Failed</h2>
            <p className="text-gray-600">{error}</p>
            <p className="text-sm text-gray-400">Redirecting...</p>
          </>
        ) : (
          <>
            <Loader2 className="w-16 h-16 mx-auto animate-spin text-primary" />
            <h2 className="text-xl font-semibold text-gray-900">Completing sign in...</h2>
            <p className="text-gray-600">Please wait while we set up your account</p>
          </>
        )}
      </div>
    </div>
  );
}
