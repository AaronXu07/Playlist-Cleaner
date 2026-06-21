import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { getMe } from '@/lib/api';
import { DashboardShell } from '@/components/dashboard/DashboardShell';

// Loading spinner used as Suspense fallback while auth resolves
function LoadingSpinner() {
  return (
    <div
      role="status"
      aria-label="Loading"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
      }}
    >
      <svg
        aria-hidden="true"
        width="40"
        height="40"
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="animate-spin"
        style={{ animation: 'spin 1s linear infinite' }}
      >
        <circle
          cx="20"
          cy="20"
          r="16"
          stroke="var(--color-bg-surface-hover)"
          strokeWidth="4"
        />
        <path
          d="M20 4 A16 16 0 0 1 36 20"
          stroke="var(--color-brand)"
          strokeWidth="4"
          strokeLinecap="round"
        />
      </svg>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

// The page component is async — it runs server-side before any HTML is sent.
// Requirements 6.1–6.3:
//   - 401 from /auth/me → redirect to /
//   - Any other error (including timeout) → render error state with retry control
//   - Success → render DashboardShell wrapped in Suspense
export default async function DashboardPage() {
  // Forward the browser's session cookie to the backend so the server-side
  // fetch is authenticated. Next.js server components don't automatically
  // propagate the incoming Cookie header.
  const cookieStore = cookies();
  const sessionCookie = cookieStore.get('session');
  const cookieHeader = sessionCookie
    ? `session=${sessionCookie.value}`
    : '';

  let meResponse;

  try {
    meResponse = await getMe(cookieHeader);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // 401 → unauthenticated; redirect to landing page
    if (message.includes('401')) {
      redirect('/');
    }

    // Any other error (network error, non-401 HTTP error, AbortError from timeout):
    // render an error state with a visible retry control — do NOT redirect.
    return (
      <main
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: '1rem',
          fontFamily: 'Inter, system-ui, sans-serif',
          color: 'var(--color-text-primary)',
          backgroundColor: 'var(--color-bg-base)',
        }}
      >
        <p>Unable to load dashboard. Please try again.</p>
        <a
          href="/dashboard"
          aria-label="Retry loading the dashboard"
          style={{
            color: 'var(--color-brand)',
            border: '1px solid var(--color-brand)',
            borderRadius: '9999px',
            padding: '0.5rem 1.5rem',
            textDecoration: 'none',
          }}
        >
          Retry
        </a>
      </main>
    );
  }

  // Success — wrap the client shell in Suspense to prevent flashing
  // unrendered dashboard content while auth resolves.
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <DashboardShell user={meResponse} />
    </Suspense>
  );
}
