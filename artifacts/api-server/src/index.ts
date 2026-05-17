import app from "./app";
import { logger } from "./lib/logger";
import { startUpdateChecker } from "./lib/updateChecker";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Startup env checks -- warn but don't crash so the setup wizard can guide users
const missing: string[] = [];
if (!process.env["PROXY_API_KEY"]) missing.push("PROXY_API_KEY");
if (!process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"]) missing.push("AI_INTEGRATIONS_ANTHROPIC_API_KEY");
if (!process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"]) missing.push("AI_INTEGRATIONS_ANTHROPIC_BASE_URL");
if (!process.env["AI_INTEGRATIONS_OPENAI_API_KEY"]) missing.push("AI_INTEGRATIONS_OPENAI_API_KEY");
if (!process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"]) missing.push("AI_INTEGRATIONS_OPENAI_BASE_URL");
if (!process.env["AI_INTEGRATIONS_GEMINI_API_KEY"]) missing.push("AI_INTEGRATIONS_GEMINI_API_KEY");
if (!process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"]) missing.push("AI_INTEGRATIONS_GEMINI_BASE_URL");
if (!process.env["AI_INTEGRATIONS_OPENROUTER_API_KEY"]) missing.push("AI_INTEGRATIONS_OPENROUTER_API_KEY");
if (!process.env["AI_INTEGRATIONS_OPENROUTER_BASE_URL"]) missing.push("AI_INTEGRATIONS_OPENROUTER_BASE_URL");
if (missing.length > 0) {
  logger.warn(
    { missing },
    "Missing environment variables -- visit the portal setup wizard or ask the Replit AI assistant to configure them"
  );
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Start background version check (logs warning if update is available)
  startUpdateChecker();

  // 向主账号负载均衡器注册本节点
  // 优先级：LB_SELF_URL（手动覆盖）> REPLIT_DOMAINS（部署后正式域名）> REPLIT_DEV_DOMAIN（开发临时域名）
  const productionDomain = process.env["REPLIT_DOMAINS"]?.split(",")[0]?.trim();
  const selfBase =
    process.env["LB_SELF_URL"] ||
    (productionDomain ? `https://${productionDomain}` : undefined) ||
    (process.env["REPLIT_DEV_DOMAIN"] ? `https://${process.env["REPLIT_DEV_DOMAIN"]}` : undefined);

  // 确保以 /api 结尾，轮询项目通过此前缀调用所有接口
  const selfUrl = selfBase
    ? selfBase.replace(/\/api\/?$/, "") + "/api"
    : undefined;

  const isProduction = Boolean(productionDomain) && !process.env["LB_SELF_URL"];

  if (!selfUrl) {
    logger.warn("Node registration skipped: no URL available (set LB_SELF_URL or deploy to get REPLIT_DOMAINS)");
  } else {
    logger.info(
      { url: selfUrl, source: process.env["LB_SELF_URL"] ? "LB_SELF_URL" : isProduction ? "REPLIT_DOMAINS" : "REPLIT_DEV_DOMAIN" },
      "Registering node with load balancer"
    );
    fetch("https://b1f70233-b5f1-44c6-ad1c-2c98467e392b-00-5asb4h1ebeux.sisko.replit.dev/api/nodes/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env["REGISTER_TOKEN"]
          ? { "Authorization": `Bearer ${process.env["REGISTER_TOKEN"]}` }
          : {}),
      },
      body: JSON.stringify({
        url: selfUrl,
        label: process.env["REPL_SLUG"],
        statsApiKey: process.env["PROXY_API_KEY"],
      }),
    })
      .then((r) => logger.info({ status: r.status, url: selfUrl, isProduction }, "Node registered with load balancer"))
      .catch((err) => logger.warn({ err }, "Node registration failed"));
  }
});

// Disable all server-level timeouts so long streaming responses (10k+ tokens,
// 7-10 min) are never cut short by the HTTP layer.
// SSE keepalive frames every 5 s keep the TCP connection alive through proxies.
server.headersTimeout  = 0;   // no timeout waiting for request headers
server.requestTimeout  = 0;   // no timeout for the full request/response cycle
server.timeout         = 0;   // no socket inactivity timeout
server.keepAliveTimeout = 65_000; // keep TCP alive slightly longer than a 60 s proxy
