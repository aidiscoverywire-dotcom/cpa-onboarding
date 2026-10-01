/**
 * Staff sign-in. Starts the Google Workspace OIDC flow via /api/auth/google
 * (assumed workstream-(b) route). The `hd` request parameter some flows use is
 * a hint only — the firm domain is enforced server-side against the verified
 * ID token claim (see lib/auth.ts).
 */
export const dynamic = "force-dynamic";

export default function LoginPage({
  searchParams,
}: {
  searchParams?: { next?: string };
}) {
  const rawNext = searchParams?.next;
  const next =
    rawNext && rawNext.startsWith("/") && !rawNext.startsWith("//")
      ? rawNext
      : "/";
  const href = `/api/auth/google?next=${encodeURIComponent(next)}`;

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-bold tracking-tight">CPA Onboarding</h1>
        <p className="mt-2 text-sm text-slate-600">
          Internal staff tool. Sign in with your firm Google Workspace account.
          Access is limited to the firm domain — enforced server-side on the
          verified token, never on a request parameter.
        </p>
        <a
          href={href}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-700"
        >
          Sign in with Google
        </a>
        <p className="mt-4 text-xs text-slate-500">
          Multi-factor authentication is inherited from your Workspace
          administrator&apos;s sign-in policy.
        </p>
      </div>
    </div>
  );
}
