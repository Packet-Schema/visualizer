import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 text-fg">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-xl font-semibold">Page not found.</h1>
        <p className="text-sm text-fg-muted">
          The page you requested does not exist. Return to the packet viewer to
          continue.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-bg-elevated"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
