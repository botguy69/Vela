import { createFileRoute, Navigate } from "@tanstack/react-router";
import { Landing } from "@/components/landing";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { fetchCandles, fetchTickers } from "@/lib/fns/market";

export const Route = createFileRoute("/")({
  loader: async () => {
    const [tickers, candles] = await Promise.all([
      fetchTickers(),
      fetchCandles({ data: { symbol: "BTC-USD", gran: "1h", limit: 120 } }),
    ]);
    return { tickers, candles };
  },
  component: Home,
});

function Home() {
  const { user, isPending } = useCurrentUserState();
  const { tickers, candles } = Route.useLoaderData();

  if (isPending) {
    return (
      <div className="min-h-dvh bg-bg px-5 py-8">
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="h-8 w-32 animate-pulse rounded-md bg-raised" />
          <div className="h-64 animate-pulse rounded-xl bg-surface" />
          <div className="h-24 animate-pulse rounded-xl bg-surface" />
        </div>
      </div>
    );
  }

  if (user) return <Navigate to="/live" replace />;
  return <Landing tickers={tickers} candles={candles} />;
}
