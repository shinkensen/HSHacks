import Link from "next/link";

const FOOTER_LINKS = [
  { label: "Features", href: "/#features" },
  { label: "Flow", href: "/#how-it-works" },
  { label: "Security", href: "/#security" },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border/70 py-10">
      <div className="mx-auto w-full max-w-5xl px-6 sm:px-8">
        <div className="my-6 flex flex-wrap items-center justify-center gap-6 text-sm">
          {FOOTER_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-muted-foreground transition-colors hover:text-primary"
            >
              {link.label}
            </a>
          ))}
        </div>
        <p className="text-center text-xs text-muted-foreground">
          © {new Date().getFullYear()} HS AI Copilot
        </p>
      </div>
    </footer>
  );
}
