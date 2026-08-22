import { Link } from "@tanstack/react-router";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { signOut } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex items-baseline gap-2 text-fg">
      <span className="font-display text-2xl font-medium tracking-tight">VELA</span>
      {!compact && (
        <span className="text-[11px] uppercase tracking-[0.18em] text-subtle">
          Live WEEX
        </span>
      )}
    </Link>
  );
}

export function AccountChip() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) {
    return <div className="h-11 w-28 animate-pulse rounded-md bg-raised" />;
  }
  if (!user) {
    return (
      <Button asChild size="sm">
        <a href="/login">Open Auto</a>
      </Button>
    );
  }
  const label = user.displayName ?? user.primaryEmail ?? "Account";
  return (
    <div className="flex items-center gap-2">
      {user.profileImageUrl ? (
        <img
          src={user.profileImageUrl}
          alt=""
          className="size-8 rounded-full object-cover outline outline-1 -outline-offset-1 outline-fg/10"
        />
      ) : (
        <span className="grid size-8 place-items-center rounded-full bg-raised text-xs font-medium">
          {label.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="hidden max-w-32 truncate text-sm sm:inline">{label}</span>
      <button
        type="button"
        onClick={() => void signOut("/")}
        className="text-xs text-muted underline-offset-4 hover:text-fg hover:underline"
      >
        Sign out
      </button>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line px-5 py-6 text-xs leading-relaxed text-subtle sm:px-8">
      VELA is software, not a broker. Auto places live WEEX futures on your account. High leverage
      can wipe the book. $1M is a target, not a guarantee.{" "}
      <a href="#legal" className="underline-offset-4 hover:text-fg hover:underline">
        Full disclaimer
      </a>
    </footer>
  );
}
