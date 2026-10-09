import { MaavadaoLogo } from '@/components/layout';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white dark:bg-background p-4">
      <div className="mb-8">
        <MaavadaoLogo />
      </div>
      {children}
    </div>
  );
}
