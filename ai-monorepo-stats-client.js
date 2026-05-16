/**
 * ai-monorepo-stats-client.js
 *
 * 从 AI Monorepo 拉取实时统计数据（请求数 / Token / 费用）。
 * 直接复制此文件到你的轮询项目即可使用，无需安装任何依赖。
 *
 * ─────────────────────────────────────────
 * 配置（必填）
 * ─────────────────────────────────────────
 *   BASE_URL   : AI Monorepo 的访问地址，末尾不加斜杠
 *   API_KEY    : PROXY_API_KEY 的值（与 AI Monorepo 的 .env 保持一致）
 *
 * ─────────────────────────────────────────
 * 返回数据格式
 * ─────────────────────────────────────────
 * {
 *   totalRequests    : number   // 总请求数
 *   totalInputTokens : number   // 总输入 Token
 *   totalOutputTokens: number   // 总输出 Token
 *   estimatedCostUsd : number   // 估算费用（USD）
 *   uptimeSeconds    : number   // 服务运行时长（秒）
 *   perModel: {                 // 按模型细分
 *     [modelName]: {
 *       calls        : number
 *       inputTokens  : number
 *       outputTokens : number
 *       costUsd      : number | null
 *     }
 *   }
 * }
 */

// ─── 修改这两行 ────────────────────────────────────────────────
const BASE_URL = "https://你的域名";   // 例如 https://xxx.replit.app
const API_KEY  = "12345678";           // 与 PROXY_API_KEY 保持一致
// ──────────────────────────────────────────────────────────────

const ENDPOINT = `${BASE_URL}/api/v1/stats/summary`;

/**
 * 拉取一次统计数据，返回解析后的对象。
 * @returns {Promise<StatsSummary>}
 */
async function fetchStats() {
  const res = await fetch(ENDPOINT, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Stats API 返回错误 ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * 启动轮询，每隔 intervalMs 毫秒自动拉取一次。
 *
 * @param {function} onData   - 每次拉取成功时的回调，接收统计对象
 * @param {function} onError  - 出错时的回调（可选），接收 Error 对象
 * @param {number}   intervalMs - 轮询间隔，默认 10000（10 秒）
 * @returns {{ stop: function }} - 调用 stop() 停止轮询
 *
 * 用法示例：
 *   const poller = startPolling(
 *     (stats) => console.log("费用:", stats.estimatedCostUsd),
 *     (err)   => console.error("拉取失败:", err.message),
 *     5000
 *   );
 *   // 停止: poller.stop();
 */
function startPolling(onData, onError, intervalMs = 10_000) {
  let timer = null;
  let stopped = false;

  async function tick() {
    try {
      const data = await fetchStats();
      if (!stopped) onData(data);
    } catch (err) {
      if (!stopped && typeof onError === "function") onError(err);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }

  tick(); // 立即执行第一次

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// ─── 导出（兼容 CommonJS 和 ESM） ─────────────────────────────
if (typeof module !== "undefined" && module.exports) {
  module.exports = { fetchStats, startPolling };
} else if (typeof window !== "undefined") {
  window.AiMonorepoStats = { fetchStats, startPolling };
}

// ─── 独立运行示例（node ai-monorepo-stats-client.js） ─────────
if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].endsWith("ai-monorepo-stats-client.js")
) {
  console.log(`正在拉取统计数据: ${ENDPOINT}\n`);
  fetchStats()
    .then((s) => {
      console.log("总请求数       :", s.totalRequests);
      console.log("总输入 Token   :", s.totalInputTokens.toLocaleString());
      console.log("总输出 Token   :", s.totalOutputTokens.toLocaleString());
      console.log("估算费用 (USD) : $" + s.estimatedCostUsd.toFixed(4));
      console.log("运行时长       :", s.uptimeSeconds, "秒");
      if (Object.keys(s.perModel).length > 0) {
        console.log("\n── 按模型细分 ──");
        for (const [model, m] of Object.entries(s.perModel)) {
          const cost = m.costUsd !== null ? "$" + m.costUsd.toFixed(4) : "无定价";
          console.log(`  ${model}: ${m.calls} 次, in=${m.inputTokens}, out=${m.outputTokens}, cost=${cost}`);
        }
      }
    })
    .catch((err) => {
      console.error("错误:", err.message);
      process.exit(1);
    });
}
