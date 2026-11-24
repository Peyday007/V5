import Providers from '@/components/layout/providers';
import AppShell from '@/components/layout/app-shell';
import { Toaster } from '@/components/ui/sonner';
import ThemeProvider from '@/components/themes/theme-provider';
import type { Metadata, Viewport } from 'next';
import NextTopLoader from 'nextjs-toploader';
import '../styles/globals.css';

export const metadata: Metadata = {
  title: { default: 'Brain Command Center', template: '%s · Brain' },
  description: "Brain's command center: objectives, plans, live operations and approvals.",
  robots: { index: false, follow: false }
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#09090b' }
  ],
  width: 'device-width',
  initialScale: 1
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang='en' suppressHydrationWarning data-theme='vercel'>
      <body className='bg-background overflow-x-hidden overscroll-none font-sans antialiased'>
        <NextTopLoader color='var(--primary)' showSpinner={false} />
        <ThemeProvider
          attribute='class'
          defaultTheme='system'
          enableSystem
          disableTransitionOnChange
          enableColorScheme
        >
          <Providers>
            <Toaster />
            <AppShell>{children}</AppShell>
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
