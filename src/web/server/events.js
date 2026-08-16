/**
 * Server-sent events: job progress and a "notes changed" ping. The open
 * stream is also the reliable "a tab is watching" signal that lifecycle
 * shutdown relies on - see ctx.scheduleShutdown, attached in index.js.
 */
export function serveEvents(ctx, req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write("retry: 2000\n\n");
  ctx.clients.add(res);
  ctx.cancelShutdown();
  if (ctx.job) res.write(`event: job\ndata: ${JSON.stringify(ctx.job)}\n\n`);
  req.on("close", () => {
    ctx.clients.delete(res);
    // Unlike a heartbeat, an open stream isn't throttled when the tab is
    // backgrounded, and it drops the instant the tab or browser goes away.
    if (ctx.clients.size === 0) ctx.scheduleShutdown("browser closed", 5000);
  });
}
