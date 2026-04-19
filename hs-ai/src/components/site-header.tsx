"use client";

import Image from "next/image";
import Link from "next/link";
import { SignInButton, UserButton, useAuth } from "@clerk/nextjs";

import { Button } from "@/components/ui/button";

const LINKS = [
  { label: "Features", href: "/#features" },
  { label: "How it works", href: "/#how-it-works" },
  { label: "Security", href: "/#security" },
];

export function SiteHeader() {
  const { isSignedIn } = useAuth();

  return (
    <header className="border-b border-border/70 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4 sm:px-8">
        <Link
          href="/"
          className="flex items-center gap-2 text-sm font-medium tracking-tight text-foreground"
        >
          <Image
            src="/logo.svg"
            alt="momentum.ai logo"
            width={18}
            height={18}
            className="size-[18px]"
            priority
          />
          momentum.ai
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href} className="hover:text-foreground">
              {link.label}
            </a>
          ))}
        </nav>
        {isSignedIn ? (
          <UserButton />
        ) : (
          <SignInButton mode="modal">
            <Button variant="outline" size="sm">
              Sign in
            </Button>
          </SignInButton>
        )}
      </div>
    </header>
  );
}
