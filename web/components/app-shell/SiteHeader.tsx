import Link from "next/link";

import ThemeToggle from "@/components/theme/ThemeToggle";

type Props = {
  /**
   * 現在のページに合わせて active link を highlight する用のヒント。
   * 渡さなくても header は動く (link は両方表示される)。
   */
  activeNav?: "viewer" | "editor";
};

export default function SiteHeader({ activeNav }: Props = {}) {
  return (
    <header
      className="sticky top-0 z-50 shadow-md"
      style={{
        background: "var(--bg-header)",
        color: "var(--header-fg)",
      }}
    >
      <div className="max-w-[1200px] mx-auto px-6 py-2 flex items-center justify-between gap-4">
        <div className="flex flex-wrap items-baseline gap-2.5 min-w-0">
          <h1 className="m-0 text-[18px] font-semibold tracking-wide whitespace-nowrap">
            Packet Visualizer
          </h1>
          <p
            className="m-0 text-xs truncate min-w-0"
            style={{ color: "var(--header-fg-muted)" }}
          >
            Visual viewer for common network packet headers.
          </p>
        </div>
        <nav
          aria-label="Primary"
          className="flex items-center gap-1 text-sm font-medium"
        >
          <NavLink href="/" active={activeNav === "viewer"}>
            Viewer
          </NavLink>
          <NavLink href="/edit" active={activeNav === "editor"}>
            Editor
          </NavLink>
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className="px-2 py-1 rounded transition-colors"
      style={{
        background: active ? "rgba(255,255,255,0.16)" : "transparent",
        color: "var(--header-fg)",
      }}
    >
      {children}
    </Link>
  );
}
