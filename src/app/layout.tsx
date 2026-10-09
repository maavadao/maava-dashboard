import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import { Providers } from './providers';
import '@/styles/globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: { default: 'maava Chat', template: '%s | maava Chat' },
  description: 'Your AI chat dashboard — manage conversations, channels, and integrations.',
  keywords: ['AI', 'chat', 'maavaDao', 'agents', 'education', 'channels'],
  authors: [{ name: 'maavaDao' }],
  creator: 'maavaDao',
  metadataBase: new URL('https://www.maavadao.com'),
  openGraph: {
    type: 'website',
    locale: 'en_US',
    siteName: 'maava Chat',
    title: 'maava Chat',
    description: 'Your AI chat dashboard — manage conversations, channels, and integrations.',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'maava Chat' }],
  },
  twitter: { card: 'summary_large_image', title: 'maava Chat', description: 'AI Chat Dashboard' },
  icons: {
    icon: '/favicon.svg',
  },
  manifest: '/site.webmanifest',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}>
        <Providers>
          {children}
        </Providers>
        <Toaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  );
}
