import Link from "next/link";
import { env } from "../lib/env";
import { getCurrentUser } from "./api";

const NAV = [
  { href: "/", label: "Pipeline" },
  { href: "/intake-review", label: "Intake review" },
  { href: "/approvals", label: "Approvals" },
  { href: "/audit", label: "Audit log" },
  { href: "/settings", label: "Settings" },
];

export default async function Header() {
  const user = await getCurrentUser();
  let firm = "CPA firm";
  try {
    firm = env.firmDomain;
  } catch {
    // FIRM_DOMAIN unset (e.g. bare build) — degrade gracefully.
  }

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-4 py-3">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-lg font-bold tracking-tight">
            CPA Onboarding
          </span>
          <span className="hidden text-xs text-slate-500 sm:inline">{firm}</span>
        </Link>
        {user && (
          <nav className="flex items-center gap-1 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        )}
        <div className="ml-auto flex items-center gap-3 text-sm">
          {user ? (
            <>
              <span className="hidden text-slate-500 md:inline">
                {user.name ?? user.email ?? user.sub}
                <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                  {user.role}
                </span>
              </span>
              <a
                href="/api/auth/signout"
                className="rounded-md border border-slate-200 px-3 py-1.5 text-slate-600 hover:bg-slate-50"
              >
                Sign out
              </a>
            </>
          ) : (
            <Link
              href="/login"
              className="rounded-md bg-slate-900 px-3 py-1.5 text-white hover:bg-slate-700"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
