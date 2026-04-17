import { useState, useEffect, useRef, useCallback } from "react";

interface LogEntry {
  id: number;
  time: string;
  method: string;
  path: string;
  model?: string;
  backend?: string;
  status: number;
  duration: number;
  stream: boolean;
  promptTokens?: number;
  completionTokens?: number;
  level: "info" | "warn" | "error";
  error?: string;
}

const LEVEL_COLORS: Record<string, string> = {
  info: "#22c55e",
  warn: "#f59e0b",
  error: "#ef4444",
};

const STATUS_COLOR = (s: number) => s >= 500 ? "#ef4444" : s >= 400 ? "#f59e0b" : "#22c55e";

export default function PageLogs({ baseUrl, apiKey }: { baseUrl: string; apiKey: string }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "info" | "warn" | "error">("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const unmounted = useRef(false);

  const cleanup = useCallback(() => {
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (unmounted.current) return;
    const delay = Math.min(2000 * Math.pow(2, retryCount.current), 30000);
    retryCount.current++;
    reconnectTimer.current = setTimeout(() => {
      if (!unmounted.current) connectStream();
    }, delay);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const connectStream = useCallback(async () => {
    if (!apiKey || unmounted.current) return;
    cleanup();

    try {
      const histRes = await fetch(`${baseUrl}/api/v1/admin/logs`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!histRes.ok) {
        const body = await histRes.json().catch(() => ({})) as { error?: { message?: string } };
        const msg = body?.error?.message || `HTTP ${histRes.status}`;
        setConnError(msg);
        setConnected(false);
        scheduleReconnect();
        return;
      }
      const histData = await histRes.json() as { logs?: LogEntry[] };
      if (histData.logs && !unmounted.current) setLogs(histData.logs);
    } catch {
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch(`${baseUrl}/api/v1/admin/logs/stream?key=${encodeURIComponent(apiKey)}`, {
        headers: { Accept: "text/event-stream" },
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
        const msg = body?.error?.message || `HTTP ${res.status}`;
        setConnError(msg);
        setConnected(false);
        scheduleReconnect();
        return;
      }

      setConnected(true);
      setConnError(null);
      retryCount.current = 0;

      const reader = res.body?.getReader();
      if (!reader) { scheduleReconnect(); return; }
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done || unmounted.current) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const entry = JSON.parse(line.slice(6)) as LogEntry;
              setLogs((prev) => {
                const next = [...prev, entry];
                return next.length > 200 ? next.slice(-200) : next;
              });
            } catch {}
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }

    if (!unmounted.current) {
      setConnected(false);
      scheduleReconnect();
    }
  }, [baseUrl, apiKey, cleanup, scheduleReconnect]);

  useEffect(() => {
    unmounted.current = false;
    connectStream();
    return () => {
      unmounted.current = true;
      cleanup();
      setConnected(false);
    };
  }, [connectStream, cleanup]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filtered = filter === "all" ? logs : logs.filter((l) => l.level === filter);

  const downloadLogs = () => {
    const text = filtered.map((l) =>
      `[${l.time}] ${l.level.toUpperCase()} ${l.method} ${l.path} → ${l.status} ${l.duration}ms ${l.model ?? ""} (${l.backend ?? ""})`
    ).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `proxy-logs-${new Date().toISOString().slice(0, 10)}.log`;
    a.click(); URL.revokeObjectURL(url);
  };

  if (!apiKey) {
    return (
      <div style={{ textAlign: "center", padding: "60px 20px", color: "#64748b" }}>
        <div style={{ fontSize: "40px", marginBottom: "12px" }}>&#128274;</div>
        <div style={{ fontSize: "15px" }}>请先在首页输入 Proxy Key</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexWrap: "wrap", gap: "10px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{
            width: "8px", height: "8px", borderRadius: "50%",
            background: connected ? "#22c55e" : "#ef4444",
            boxShadow: connected ? "0 0 8px #22c55e" : "none",
          }} />
          <span style={{ fontSize: "13px", color: connected ? "#22c55e" : "#ef4444" }}>
            {connected ? "已连接" : connError ? `连接失败: ${connError}` : "重连中..."}
          </span>
          {!connected && (
            <button onClick={() => { retryCount.current = 0; setConnError(null); connectStream(); }} style={{
              fontSize: "12px", padding: "4px 10px", borderRadius: "6px",
              background: "rgba(99,102,241,0.2)", color: "#a5b4fc",
              border: "1px solid rgba(99,102,241,0.3)", cursor: "pointer",
            }}>立即重连</button>
          )}
        </div>

        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          {(["all", "info", "warn", "error"] as const).map((lv) => (
            <button
              key={lv}
              onClick={() => setFilter(lv)}
              style={{
                fontSize: "11px", padding: "3px 10px", borderRadius: "12px",
                border: "1px solid",
                borderColor: filter === lv ? (LEVEL_COLORS[lv] ?? "#6366f1") : "rgba(255,255,255,0.1)",
                background: filter === lv ? `${LEVEL_COLORS[lv] ?? "#6366f1"}22` : "transparent",
                color: filter === lv ? (LEVEL_COLORS[lv] ?? "#a5b4fc") : "#64748b",
                cursor: "pointer",
              }}
            >
              {lv === "all" ? "全部" : lv.toUpperCase()}
            </button>
          ))}
          <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "11px", color: "#64748b", marginLeft: "8px", cursor: "pointer" }}>
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            自动滚动
          </label>
          <button onClick={downloadLogs} style={{
            fontSize: "11px", padding: "3px 10px", borderRadius: "6px",
            background: "rgba(255,255,255,0.05)", color: "#94a3b8",
            border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer",
          }}>下载</button>
          <button onClick={() => setLogs([])} style={{
            fontSize: "11px", padding: "3px 10px", borderRadius: "6px",
            background: "rgba(239,68,68,0.1)", color: "#f87171",
            border: "1px solid rgba(239,68,68,0.2)", cursor: "pointer",
          }}>清空</button>
        </div>
      </div>

      <div
        ref={scrollRef}
        style={{
          background: "rgba(0,0,0,0.4)", borderRadius: "12px",
          border: "1px solid rgba(255,255,255,0.06)",
          maxHeight: "500px", overflowY: "auto",
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
          fontSize: "12px", lineHeight: "1.8",
          padding: "12px 16px",
        }}
      >
        {filtered.length === 0 && (
          <div style={{ textAlign: "center", color: "#475569", padding: "40px 0" }}>
            {connected ? "等待日志输入..." : connError ? "请检查 API Key 是否正确" : "正在尝试连接服务器..."}
          </div>
        )}
        {filtered.map((l) => (
          <div key={l.id} style={{
            display: "flex", gap: "8px", padding: "2px 0",
            borderBottom: "1px solid rgba(255,255,255,0.03)",
          }}>
            <span style={{ color: "#475569", flexShrink: 0 }}>{l.time.slice(11, 19)}</span>
            <span style={{ color: LEVEL_COLORS[l.level], fontWeight: 600, width: "40px", flexShrink: 0 }}>
              {l.level.toUpperCase()}
            </span>
            <span style={{ color: "#94a3b8", flexShrink: 0 }}>{l.method}</span>
            <span style={{ color: "#cbd5e1", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {l.path}
            </span>
            {l.model && <span style={{ color: "#818cf8", flexShrink: 0 }}>{l.model}</span>}
            <span style={{ color: STATUS_COLOR(l.status), flexShrink: 0 }}>{l.status}</span>
            <span style={{ color: "#64748b", flexShrink: 0 }}>{l.duration}ms</span>
            {l.stream && <span style={{ color: "#6366f1", fontSize: "10px", flexShrink: 0 }}>SSE</span>}
          </div>
        ))}
      </div>

      <div style={{ fontSize: "11px", color: "#475569", textAlign: "right" }}>
        显示 {filtered.length} 条 / 共 {logs.length} 条
      </div>
    </div>
  );
}
