import ThemeToggle from "@/components/theme/ThemeToggle";

export default function SiteHeader() {
  return (
    <header
      className="sticky top-0 z-50 shadow-md"
      style={{
        background: "var(--bg-header)",
        color: "var(--header-fg)",
      }}
    >
      <div className="max-w-[1200px] mx-auto px-4 md:px-6 py-2 flex items-center justify-between gap-2 md:gap-4">
        <div className="flex items-baseline gap-1.5 sm:gap-2.5 min-w-0 overflow-hidden">
          <h1 className="m-0 text-base md:text-[18px] font-semibold tracking-wide whitespace-nowrap">
            Packet Schema Visualizer
          </h1>
          <p
            className="m-0 text-xs truncate min-w-0"
            style={{ color: "var(--header-fg-muted)" }}
          >
            Visual viewer for common network packet headers.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
