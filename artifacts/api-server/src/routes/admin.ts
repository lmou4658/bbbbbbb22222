import { Router, type IRouter, type Request, type Response } from "express";
import { authMiddleware } from "../middlewares/auth";
import { requestLogs, logSSEClients, getModelStats, resetStats } from "../lib/requestLog";
import { calcCost } from "../lib/modelPricing";
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

/**
 * GET /api/v1/stats/summary
 *
 * Returns aggregated totals ready for display or polling:
 *   totalRequests     – total number of AI calls recorded
 *   totalInputTokens  – sum of all prompt tokens
 *   totalOutputTokens – sum of all completion tokens
 *   estimatedCostUsd  – server-side cost calculation (same formula as the portal)
 *   uptimeSeconds     – seconds since process start
 *   perModel          – per-model breakdown with individual cost
 *
 * Authentication: same PROXY_API_KEY bearer token as all other endpoints.
 */
router.get("/stats/summary", authMiddleware, (_req: Request, res: Response) => {
  const modelStats = getModelStats();

  let totalRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let estimatedCostUsd = 0;

  const perModel: Record<string, {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  }> = {};

  for (const [model, stat] of Object.entries(modelStats)) {
    totalRequests += stat.calls;
    totalInputTokens += stat.promptTokens;
    totalOutputTokens += stat.completionTokens;

    const cost = calcCost(model, stat.promptTokens, stat.completionTokens);
    if (cost !== null) estimatedCostUsd += cost;

    perModel[model] = {
      calls: stat.calls,
      inputTokens: stat.promptTokens,
      outputTokens: stat.completionTokens,
      costUsd: cost,
    };
  }

  res.json({
    totalRequests,
    totalInputTokens,
    totalOutputTokens,
    estimatedCostUsd,
    uptimeSeconds: Math.round(process.uptime()),
    perModel,
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
