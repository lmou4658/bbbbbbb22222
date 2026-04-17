import { Router, type IRouter, type Request, type Response } from "express";
import { authMiddleware } from "../middlewares/auth";
import { requestLogs, logSSEClients, getModelStats, resetStats } from "../lib/requestLog";
import {
  getCacheStats,
  cacheClear,
  setCacheEnabled,
  setCacheTtl,
  setCacheMaxEntries,
} from "../lib/responseCache";

const router: IRouter = Router();

router.get("/admin/logs", authMiddleware, (_req: Request, res: Response) => {
  res.json({ logs: requestLogs });
});

router.get("/admin/logs/stream", authMiddleware, (req: Request, res: Response) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  logSSEClients.add(res);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": heartbeat\n\n");
  }, 20000);
  req.on("close", () => { clearInterval(heartbeat); logSSEClients.delete(res); });
});

router.get("/stats", authMiddleware, (_req: Request, res: Response) => {
  res.json({
    modelStats: getModelStats(),
    cacheStats: getCacheStats(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

router.post("/admin/stats/reset", authMiddleware, (_req: Request, res: Response) => {
  resetStats();
  res.json({ ok: true });
});

router.get("/admin/cache", authMiddleware, (_req: Request, res: Response) => {
  res.json(getCacheStats());
});

router.post("/admin/cache/clear", authMiddleware, (_req: Request, res: Response) => {
  cacheClear();
  res.json({ ok: true });
});

router.patch("/admin/cache", authMiddleware, (req: Request, res: Response) => {
  const { enabled, ttlMinutes, maxEntries } = req.body as {
    enabled?: boolean;
    ttlMinutes?: number;
    maxEntries?: number;
  };
  if (typeof enabled === "boolean") setCacheEnabled(enabled);
  if (typeof ttlMinutes === "number" && ttlMinutes > 0) setCacheTtl(ttlMinutes);
  if (typeof maxEntries === "number" && maxEntries > 0) setCacheMaxEntries(maxEntries);
  res.json({ ok: true, stats: getCacheStats() });
});

export default router;
