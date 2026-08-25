import type { ServerContext } from "./context.ts";

/**
 * Server-sent events: job progress and a "notes changed" ping. The open
 * stream is also the reliable "a tab is watching" signal that lifecycle
 * shutdown relies on - see ctx.scheduleShutdown, attached in index.ts.
 */
export function serveEvents(ctx: ServerContext, req: Request, server: Bun.Server<undefined>): Response {
  // Bun.serve's idleTimeout (see index.ts) applies to this connection too,
  // and 255s is nowhere near "however long the tab stays open" - the whole
  // point of this stream. Disabling it here, per-request, is the documented
  // way to exempt a long-lived stream without raising the global default for
  // every other route.
  server.timeout(req, 0);

  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(encoder.encode("retry: 2000\n\n"));
      ctx.clients.add(c);
      ctx.cancelShutdown();
      if (ctx.job) c.enqueue(encoder.encode(`event: job\ndata: ${JSON.stringify(ctx.job)}\n\n`));
    },
    cancel() {
      ctx.clients.delete(controller);
      // Unlike a heartbeat, an open stream isn't throttled when the tab is
      // backgrounded, and it drops the instant the tab or browser goes away.
      if (ctx.clients.size === 0) ctx.scheduleShutdown("browser closed", 5000);
    },
  });

  // `cancel()` above covers a client-initiated close; `abort` also catches a
  // dropped connection where the stream is never actively cancelled.
  req.signal.addEventListener("abort", () => {
    ctx.clients.delete(controller);
    if (ctx.clients.size === 0) ctx.scheduleShutdown("browser closed", 5000);
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}
