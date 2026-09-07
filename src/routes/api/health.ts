import { createFileRoute } from "@tanstack/react-router";

function cors(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    },
  });
}

function handle() {
  try {
    return cors({ ok: true, awake: true, service: "vela" }, 200);
  } catch {
    return cors({ ok: true, awake: true, service: "vela" }, 200);
  }
}

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () => handle(),
      OPTIONS: () => cors({ ok: true }, 200),
    },
  },
});
