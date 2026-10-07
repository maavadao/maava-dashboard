'use client';

import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { SellerSidebar, SidebarLayout } from '@/components/layout/sidebar';

export default function SellerLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarLayout sidebar={<SellerSidebar />}>
      <Suspense
        fallback={
          <div className="flex items-center justify-center min-h-screen">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        }
      >
        {children}
      </Suspense>
    </SidebarLayout>
  );
}
