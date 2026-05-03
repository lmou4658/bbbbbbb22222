import { useState, useEffect, useCallback, useMemo } from "react";
import PageLogs from "./components/PageLogs";
import PageStats from "./components/PageStats";
import { API_BASE, DISPLAY_BASE_URL, isDev as envIsDev } from "./lib/apiBase";

const BG = "#0a0f1e";
const CARD = "rgba(255,255,255,0.04)";
const CARD2 = "rgba(255,255,255,0.025)";
const BORDER = "rgba(255,255,255,0.08)";
const BORDER_ACCENT = "rgba(99,102,241,0.3)";
const TEXT = "#e8edf5";
const MUTED = "#64748b";
const GREEN = "#22d3a5";
const RED = "#f87171";
const ACCENT = "#6366f1";
const ACCENT2 = "#818cf8";
const YELLOW = "#fbbf24";
const PURPLE = "#a78bfa";


// ── Types ──────────────────────────────────────────────────────────────

interface SetupStatus {
  configured: boolean;
  integrations: {
    anthropic: boolean;
    openai: boolean;
    gemini: boolean;
    openrouter: boolean;
    allReady: boolean;
  };
}

interface VersionInfo {
  version: string;
  releaseDate?: string;
  changelog?: string[];
  history?: Array<{ version: string; releaseDate?: string; changelog?: string[] }>;
}

interface VersionResponse {
  current: VersionInfo;
  remote: VersionInfo | null;
  updateAvailable: boolean;
  updateSourceUrl: string | null;
}

type AppState = "checking" | "needs-setup" | "ready";
type UpdateState = "idle" | "checking" | "up-to-date" | "available" | "error";

// ── Config Incomplete Banner (sticky) ────────────────────────────────────────
function ConfigBanner({ status, onGoToSetup }: { status: SetupStatus; onGoToSetup: () => void }) {
  const missing: string[] = [];
  if (!status.configured) missing.push("PROXY_API_KEY");
  if (!status.integrations.anthropic) missing.push("Anthropic");
  if (!status.integrations.openai) missing.push("OpenAI");
  if (!status.integrations.gemini) missing.push("Gemini");
  if (!status.integrations.openrouter) missing.push("OpenRouter");
  if (missing.length === 0) return null;

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999,
      background: `linear-gradient(90deg, rgba(239,68,68,0.95), rgba(185,28,28,0.95))`,
      backdropFilter: "blur(12px)",
      borderBottom: `1px solid rgba(239,68,68,0.4)`,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 20px", gap: 12, minHeight: 48,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 16, flexShrink: 0 }}>⚠</span>
        <div style={{ fontSize: 12.5, color: "#fff", fontWeight: 600 }}>
          配置未完成
          <span style={{ fontWeight: 400, marginLeft: 8, opacity: 0.8 }}>
            缺少：{missing.join(" · ")}
          </span>
        </div>
      </div>
      <button
        onClick={onGoToSetup}
        style={{
          padding: "5px 16px", borderRadius: 6, border: "1.5px solid rgba(255,255,255,0.7)",
          background: "rgba(255,255,255,0.12)", color: "#fff",
          fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0,
          backdropFilter: "blur(4px)", letterSpacing: "0.03em",
        }}
      >
        立即配置 →
      </button>
    </div>
  );
}

// ── Model Groups Panel ─────────────────────────────────────────────────────

interface ModelEntry { id: string; enabled: boolean; }
interface ModelGroupConfig { id: string; name: string; enabled: boolean; models: ModelEntry[]; }

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div
      onClick={() => !disabled && onChange(!on)}
      style={{
        width: 38, height: 22, borderRadius: 11,
        background: on && !disabled
          ? `linear-gradient(135deg, ${GREEN}, #10b981)`
          : "rgba(255,255,255,0.1)",
        position: "relative", cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.25s", flexShrink: 0, opacity: disabled ? 0.4 : 1,
        boxShadow: on && !disabled ? `0 0 12px ${GREEN}40` : "none",
      }}
    >
      <div style={{
        position: "absolute", top: 3, left: on ? 19 : 3,
        width: 16, height: 16, borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
        transition: "left 0.22s cubic-bezier(.4,0,.2,1)",
      }} />
    </div>
  );
}

const PROVIDER_ICONS: Record<string, string> = {
  "Anthropic": "🟠",
  "OpenAI": "🔵",
  "Google Gemini": "🟢",
  "OpenRouter": "🟣",
};

function ModelGroupsPanel() {
  const [groups, setGroups] = useState<ModelGroupConfig[] | null>(null);
  const [original, setOriginal] = useState<string>("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("proxy_admin_key") ?? "");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<"ok" | "err" | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/model-groups`);
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json() as ModelGroupConfig[];
      setGroups(data);
      setOriginal(JSON.stringify(data));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const dirty = groups ? JSON.stringify(groups) !== original : false;

  const toggleGroup = (gid: string, enabled: boolean) => {
    setGroups(g => g ? g.map(gr => gr.id === gid ? { ...gr, enabled } : gr) : g);
  };

  const toggleModel = (gid: string, mid: string, enabled: boolean) => {
    setGroups(g => g ? g.map(gr =>
      gr.id === gid
        ? { ...gr, models: gr.models.map(m => m.id === mid ? { ...m, enabled } : m) }
        : gr
    ) : g);
  };

  const toggleAllInGroup = (gid: string, enabled: boolean) => {
    setGroups(g => g ? g.map(gr =>
      gr.id === gid ? { ...gr, models: gr.models.map(m => ({ ...m, enabled })) } : gr
    ) : g);
  };

  const save = async () => {
    if (!apiKey.trim()) { setShowKey(true); return; }
    localStorage.setItem("proxy_admin_key", apiKey.trim());
    setSaving(true); setSaveResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/admin/model-groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey.trim()}` },
        body: JSON.stringify(groups),
      });
      if (res.ok) { setOriginal(JSON.stringify(groups)); setSaveResult("ok"); }
      else setSaveResult("err");
    } catch { setSaveResult("err"); }
    finally { setSaving(false); setTimeout(() => setSaveResult(null), 3000); }
  };

  if (!groups) {
    return (
      <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "20px 18px", color: MUTED, fontSize: 12 }}>
        正在加载模型组配置…
      </div>
    );
  }

  const saveColor = saveResult === "ok" ? GREEN : saveResult === "err" ? RED : ACCENT;

  return (
    <div style={{
      background: CARD, border: `1px solid ${BORDER}`,
      borderRadius: 14, overflow: "hidden",
      backdropFilter: "blur(8px)",
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexWrap: "wrap", gap: 8, padding: "14px 18px",
        borderBottom: `1px solid ${BORDER}`,
        background: "rgba(255,255,255,0.02)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14 }}>⚡</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: TEXT, letterSpacing: "-0.01em" }}>模型组管理</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {!dirty && <span style={{ fontSize: 11, color: MUTED }}>拨动开关修改，再保存生效</span>}
          {dirty && showKey && (
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="PROXY_API_KEY"
              style={{
                padding: "5px 10px", borderRadius: 7, border: `1px solid ${BORDER_ACCENT}`,
                background: "rgba(0,0,0,0.3)", color: TEXT, fontSize: 12,
                fontFamily: "monospace", outline: "none", width: 160,
              }}
              onKeyDown={e => e.key === "Enter" && save()}
            />
          )}
          {dirty && (
            <button
              onClick={save}
              disabled={saving}
              style={{
                padding: "5px 16px", borderRadius: 7,
                background: saveResult === "ok"
                  ? `linear-gradient(135deg, ${GREEN}, #10b981)`
                  : saveResult === "err"
                  ? `linear-gradient(135deg, ${RED}, #dc2626)`
                  : `linear-gradient(135deg, ${ACCENT}, ${PURPLE})`,
                border: "none", color: "#fff", fontSize: 12, fontWeight: 600,
                cursor: saving ? "not-allowed" : "pointer",
                boxShadow: saveResult === "ok" ? `0 0 12px ${GREEN}40` : `0 0 12px ${ACCENT}40`,
              }}
            >
              {saving ? "保存中…" : saveResult === "ok" ? "✓ 已保存" : saveResult === "err" ? "✗ 失败" : "保存更改"}
            </button>
          )}
        </div>
      </div>

      {groups.map(group => {
        const isOpen = !!expanded[group.id];
        const enabledCount = group.models.filter(m => m.enabled).length;
        const icon = PROVIDER_ICONS[group.name] ?? "◆";
        return (
          <div key={group.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "11px 18px",
              background: group.enabled ? "transparent" : "rgba(239,68,68,0.04)",
              transition: "background 0.2s",
            }}>
              <Toggle on={group.enabled} onChange={v => toggleGroup(group.id, v)} />
              <button
                onClick={() => setExpanded(e => ({ ...e, [group.id]: !e[group.id] }))}
                style={{ flex: 1, background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: 0 }}
              >
                <span style={{ fontSize: 14 }}>{icon}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: group.enabled ? TEXT : MUTED }}>{group.name}</span>
                <span style={{
                  fontSize: 10.5, padding: "2px 8px", borderRadius: 20,
                  background: group.enabled ? "rgba(34,211,165,0.1)" : "rgba(255,255,255,0.05)",
                  color: group.enabled ? GREEN : MUTED,
                  border: `1px solid ${group.enabled ? "rgba(34,211,165,0.25)" : BORDER}`,
                }}>
                  {group.enabled ? `${enabledCount} / ${group.models.length}` : "已停用"}
                </span>
                <span style={{
                  marginLeft: "auto", color: MUTED, fontSize: 10,
                  transform: isOpen ? "rotate(180deg)" : "none",
                  transition: "transform 0.2s",
                }}>▼</span>
              </button>
              {isOpen && (
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => toggleAllInGroup(group.id, true)} style={{
                    padding: "3px 10px", borderRadius: 6,
                    border: `1px solid rgba(34,211,165,0.3)`,
                    background: "rgba(34,211,165,0.08)", color: GREEN,
                    fontSize: 11, cursor: "pointer", fontWeight: 600,
                  }}>全开</button>
                  <button onClick={() => toggleAllInGroup(group.id, false)} style={{
                    padding: "3px 10px", borderRadius: 6,
                    border: `1px solid rgba(248,113,113,0.3)`,
                    background: "rgba(248,113,113,0.08)", color: RED,
                    fontSize: 11, cursor: "pointer", fontWeight: 600,
                  }}>全关</button>
                </div>
              )}
            </div>

            {isOpen && (
              <div style={{ background: "rgba(0,0,0,0.2)", padding: "6px 18px 12px" }}>
                {group.models.map(model => (
                  <div key={model.id} style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "5px 0", borderBottom: `1px solid rgba(255,255,255,0.03)`,
                    opacity: group.enabled ? 1 : 0.35,
                  }}>
                    <Toggle
                      on={model.enabled}
                      onChange={v => { if (group.enabled) toggleModel(group.id, model.id, v); }}
                      disabled={!group.enabled}
                    />
                    <span style={{
                      fontFamily: "monospace", fontSize: 11.5,
                      color: model.enabled && group.enabled ? ACCENT2 : MUTED,
                    }}>
                      {model.id}
                    </span>
                    {model.enabled && group.enabled && (
                      <span style={{
                        marginLeft: "auto", width: 6, height: 6, borderRadius: "50%",
                        background: GREEN, boxShadow: `0 0 6px ${GREEN}`,
                      }} />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CopyBox({ value, label, inline }: { value: string; label?: string; inline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const doCopy = () => { navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); };

  if (inline) {
    return (
      <button onClick={doCopy} style={{
        padding: "3px 10px", borderRadius: 5, border: `1px solid ${BORDER}`,
        background: copied ? `rgba(34,211,165,0.1)` : "transparent",
        color: copied ? GREEN : MUTED,
        fontSize: 11, cursor: "pointer", transition: "all 0.15s", whiteSpace: "nowrap",
      }}>{copied ? "已复制" : "复制代码"}</button>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      {label && <div style={{ fontSize: 11, color: MUTED, marginBottom: 5, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</div>}
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 8,
        background: "rgba(0,0,0,0.3)", border: `1px solid ${BORDER}`,
        borderRadius: 9, padding: "10px 14px",
      }}>
        <code style={{ flex: 1, fontFamily: "monospace", fontSize: 12, color: ACCENT2, lineHeight: 1.7, wordBreak: "break-all" }}>{value}</code>
        <button onClick={doCopy} style={{
          padding: "4px 12px", borderRadius: 6, border: `1px solid ${BORDER}`,
          background: copied ? "rgba(34,211,165,0.12)" : "rgba(255,255,255,0.05)",
          color: copied ? GREEN : MUTED,
          fontSize: 12, cursor: "pointer", flexShrink: 0, transition: "all 0.15s", whiteSpace: "nowrap",
        }}>{copied ? "✓ 已复制" : "复制"}</button>
      </div>
    </div>
  );
}

function StatusRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 0",
      borderBottom: `1px solid ${BORDER}`,
    }}>
      <span style={{
        width: 20, height: 20, borderRadius: "50%", fontSize: 10, fontWeight: 700,
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        background: ok ? "rgba(34,211,165,0.12)" : "rgba(248,113,113,0.1)",
        color: ok ? GREEN : RED,
        border: `1px solid ${ok ? "rgba(34,211,165,0.3)" : "rgba(248,113,113,0.3)"}`,
        boxShadow: ok ? `0 0 8px rgba(34,211,165,0.2)` : "none",
      }}>{ok ? "✓" : "✗"}</span>
      <span style={{ fontSize: 13, color: ok ? TEXT : MUTED }}>{label}</span>
      {ok && <span style={{ marginLeft: "auto", fontSize: 10, color: GREEN, fontWeight: 600 }}>已就绪</span>}
    </div>
  );
}

// ── Update Panel ───────────────────────────────────────────────────────

const GITHUB_URL = "https://github.com/Akatsuki03/AI-Monorepo";

function buildAgentPrompt(remoteVersion: string): string {
  return `请帮我把 AI Monorepo 更新到最新版本（v${remoteVersion}）。

源代码仓库：${GITHUB_URL}

操作步骤：
1. 在项目根目录执行 git 拉取（从上面的仓库拉取 main 分支）：
   git fetch https://github.com/Akatsuki03/AI-Monorepo main
   git -c core.hooksPath=/dev/null reset --hard FETCH_HEAD

2. 若 .replit 或 replit.nix 被上述命令覆盖，请恢复它们。

3. 执行：
   pnpm install

4. 重启名为 "artifacts/api-server: API Server" 的 workflow。
   重启后服务会自动编译新代码并上线，无需任何额外操作。`;
}

function UpdatePanel() {
  const [state, setState] = useState<UpdateState>("idle");
  const [versionData, setVersionData] = useState<VersionResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const checkUpdate = useCallback(async () => {
    setState("checking");
    try {
      const res = await fetch(`${API_BASE}/api/version`);
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json() as VersionResponse;
      setVersionData(data);
      setState(data.updateAvailable ? "available" : "up-to-date");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => { void checkUpdate(); }, [checkUpdate]);

  const current = versionData?.current;
  const remote = versionData?.remote;
  const agentPrompt = remote?.version ? buildAgentPrompt(remote.version) : "";

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(agentPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* ignore */ }
  };

  return (
    <div style={{
      background: CARD, border: `1px solid ${BORDER}`,
      borderRadius: 14, overflow: "hidden", backdropFilter: "blur(8px)",
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 18px", borderBottom: `1px solid ${BORDER}`,
        background: "rgba(255,255,255,0.02)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 14 }}>🔄</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: TEXT, letterSpacing: "-0.01em" }}>版本 & 更新</span>
          {current && (
            <span style={{
              fontFamily: "monospace", fontSize: 11, color: PURPLE,
              background: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.25)",
              borderRadius: 20, padding: "2px 9px", fontWeight: 600,
            }}>
              v{current.version}
            </span>
          )}
          {state === "available" && remote && (
            <span style={{
              fontFamily: "monospace", fontSize: 11, color: GREEN,
              background: "rgba(34,211,165,0.12)", border: "1px solid rgba(34,211,165,0.3)",
              borderRadius: 20, padding: "2px 9px", fontWeight: 600,
            }}>
              → v{remote.version} 可用
            </span>
          )}
          {state === "up-to-date" && <span style={{ fontSize: 11, color: GREEN, fontWeight: 600 }}>✓ 已是最新</span>}
          {state === "error" && <span style={{ fontSize: 11, color: RED }}>✗ 检测失败</span>}
        </div>
        <button
          onClick={checkUpdate}
          disabled={state === "checking"}
          style={{
            padding: "5px 14px", borderRadius: 7,
            border: `1px solid ${BORDER_ACCENT}`,
            background: "rgba(99,102,241,0.1)",
            color: state === "checking" ? MUTED : ACCENT2,
            fontSize: 12, fontWeight: 500,
            cursor: state === "checking" ? "not-allowed" : "pointer",
          }}
        >
          {state === "checking" ? "检测中…" : "检测更新"}
        </button>
      </div>

      {state === "available" && remote?.changelog && (
        <div style={{ padding: "12px 18px", borderBottom: `1px solid ${BORDER}`, background: "rgba(34,211,165,0.03)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: GREEN, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
            v{remote.version} 更新内容
          </div>
          {remote.changelog.map((item, i) => (
            <div key={i} style={{
              fontSize: 12, color: MUTED, lineHeight: 1.6,
              paddingLeft: 10, borderLeft: `2px solid rgba(34,211,165,0.4)`, marginBottom: 4,
            }}>
              {item}
            </div>
          ))}
        </div>
      )}

      {(state === "idle" || state === "up-to-date") && current?.changelog && (
        <div style={{ padding: "12px 18px", borderBottom: `1px solid ${BORDER}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>当前版本内容</div>
          {current.changelog.map((item, i) => (
            <div key={i} style={{
              fontSize: 12, color: MUTED, lineHeight: 1.6,
              paddingLeft: 10, borderLeft: `2px solid ${BORDER}`, marginBottom: 4,
            }}>
              {item}
            </div>
          ))}
        </div>
      )}

      {state === "available" && remote && (
        <div style={{ padding: "16px 18px" }}>
          <div style={{
            fontSize: 12, color: MUTED, lineHeight: 1.65, marginBottom: 14,
            background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.2)",
            borderRadius: 9, padding: "10px 14px",
          }}>
            <span style={{ color: YELLOW, fontWeight: 700 }}>为什么需要这一步？</span>
            {"  "}服务器是编译型 Node.js 程序，新代码必须重新编译并重启才能生效。
            将下方提示词复制给 <strong style={{ color: TEXT }}>Replit Agent</strong> 即可完成更新。
          </div>
          <div style={{
            background: "rgba(0,0,0,0.3)", border: `1px solid ${BORDER}`,
            borderRadius: 9, padding: "12px 14px",
            fontFamily: "monospace", fontSize: 11, color: MUTED,
            lineHeight: 1.8, whiteSpace: "pre-wrap", wordBreak: "break-all",
            maxHeight: 200, overflowY: "auto", marginBottom: 12,
          }}>
            {agentPrompt}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" style={{
              flex: 1, padding: "9px 0", borderRadius: 8,
              border: `1px solid ${BORDER_ACCENT}`,
              background: "rgba(99,102,241,0.08)",
              color: ACCENT2, fontSize: 12, fontWeight: 600,
              textAlign: "center", textDecoration: "none", display: "block",
            }}>
              ↗ GitHub 源码
            </a>
            <button onClick={copyPrompt} style={{
              flex: 2, padding: "9px 0", borderRadius: 8,
              background: copied
                ? `linear-gradient(135deg, ${GREEN}, #10b981)`
                : `linear-gradient(135deg, ${ACCENT}, ${PURPLE})`,
              border: "none", color: "#fff",
              fontSize: 13, fontWeight: 700, cursor: "pointer",
              boxShadow: `0 0 20px ${copied ? GREEN : ACCENT}40`,
              transition: "all 0.2s",
            }}>
              {copied ? "✓ 已复制！粘贴给 Agent 即可" : "复制更新提示词"}
            </button>
          </div>
        </div>
      )}

      {current?.history && current.history.length > 0 && (
        <div style={{ padding: "14px 18px", borderTop: `1px solid ${BORDER}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>版本历史</div>
          {current.history.map((ver) => (
            <details key={ver.version} style={{ marginBottom: 6 }}>
              <summary style={{
                cursor: "pointer", fontSize: 12, color: MUTED,
                fontFamily: "monospace", listStyle: "none",
                display: "flex", alignItems: "center", gap: 8,
                padding: "4px 0", userSelect: "none",
              }}>
                <span style={{ color: TEXT, fontWeight: 600 }}>v{ver.version}</span>
                {ver.releaseDate && <span style={{ color: MUTED, fontSize: 11 }}>{ver.releaseDate}</span>}
                <span style={{ marginLeft: "auto", fontSize: 10, color: MUTED }}>▶</span>
              </summary>
              <div style={{ paddingLeft: 12, paddingTop: 6 }}>
                {(ver.changelog ?? []).map((item, i) => (
                  <div key={i} style={{
                    fontSize: 11, color: MUTED, lineHeight: 1.65,
                    paddingLeft: 8, borderLeft: `2px solid ${BORDER}`, marginBottom: 4,
                  }}>{item}</div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Setup Wizard ────────────────────────────────────────────────────────

const LS_DISMISSED = "aim_setup_dismissed";
const LS_PROXY_KEY = "aim_proxy_key";

type MainTab = "home" | "logs" | "stats";

const INTEGRATION_CODE = `const integrations = [
  { label: "Anthropic",  providerSlug: "anthropic",  providerApiKeyEnvVarName: "AI_INTEGRATIONS_ANTHROPIC_API_KEY",  providerUrlEnvVarName: "AI_INTEGRATIONS_ANTHROPIC_BASE_URL" },
  { label: "OpenAI",     providerSlug: "openai",     providerApiKeyEnvVarName: "AI_INTEGRATIONS_OPENAI_API_KEY",     providerUrlEnvVarName: "AI_INTEGRATIONS_OPENAI_BASE_URL" },
  { label: "Gemini",     providerSlug: "gemini",     providerApiKeyEnvVarName: "AI_INTEGRATIONS_GEMINI_API_KEY",     providerUrlEnvVarName: "AI_INTEGRATIONS_GEMINI_BASE_URL" },
  { label: "OpenRouter", providerSlug: "openrouter", providerApiKeyEnvVarName: "AI_INTEGRATIONS_OPENROUTER_API_KEY", providerUrlEnvVarName: "AI_INTEGRATIONS_OPENROUTER_BASE_URL" },
];
for (const i of integrations) {
  console.log("Setting up " + i.label + "...");
  const r = await setupReplitAIIntegrations({ providerSlug: i.providerSlug, providerApiKeyEnvVarName: i.providerApiKeyEnvVarName, providerUrlEnvVarName: i.providerUrlEnvVarName });
  console.log(i.label + ":", JSON.stringify(r));
}
console.log("All integrations configured.");`;

function buildUnifiedPrompt(needsKey: boolean, keyValue: string, needsIntegrations: boolean): string {
  const lines: string[] = [
    "请帮我完成 AI Monorepo 的初始配置，按以下步骤执行（全程无需我介入）：",
    "",
    "【绝对禁止】不得向我索取任何第三方 API Key（OpenAI、Anthropic、Google、OpenRouter 等），Replit 平台会自动注入。",
    "",
  ];
  let step = 1;

  if (needsKey && keyValue.trim()) {
    lines.push(`第${step++}步：添加 Secret`);
    lines.push(`通过 Replit Secrets 面板（或 viewEnvVars / setEnvVars 工具）添加以下 Secret：`);
    lines.push(`PROXY_API_KEY = "${keyValue.trim()}"`);
    lines.push(`这是我自己设定的代理访问密钥，不是任何第三方服务的 API Key。`);
    lines.push("");
  }

  if (needsIntegrations) {
    lines.push(`第${step++}步：通过 code_execution 工具执行以下代码，依次配置全部 4 个 AI Integration：`);
    lines.push("");
    lines.push(INTEGRATION_CODE);
    lines.push("");
  }

  lines.push(`第${step}步：重启 API Server workflow，让以上配置全部生效。`);
  lines.push("");
  lines.push(`完成后告知我，我将点击门户中的\u201c重新检测\u201d按钮验证。`);

  return lines.join("\n");
}

type WizardPhase = "overview" | "set-key" | "copy-prompt" | "verify";

function SetupWizard({ status, onRecheck, onDismiss }: {
  status: SetupStatus;
  onRecheck: () => void;
  onDismiss?: () => void;
}) {
  const needsKey = !status.configured;
  const needsIntegrations = !status.integrations.allReady;

  const phases = useMemo<WizardPhase[]>(() => {
    const list: WizardPhase[] = ["overview"];
    if (needsKey) list.push("set-key");
    list.push("copy-prompt");
    list.push("verify");
    return list;
  }, [needsKey]);

  const [phaseIdx, setPhaseIdx] = useState(0);
  const [keyInput, setKeyInput] = useState("");
  const [checking, setChecking] = useState(false);

  const phase = phases[phaseIdx];
  const totalSteps = phases.length - 1;
  const currentStep = phaseIdx;

  const unifiedPrompt = buildUnifiedPrompt(needsKey, keyInput, needsIntegrations);
  const goNext = () => setPhaseIdx(i => Math.min(i + 1, phases.length - 1));

  const handleRecheck = async () => {
    setChecking(true);
    await new Promise((r) => setTimeout(r, 600));
    onRecheck();
    setChecking(false);
  };

  const PrimaryBtn = ({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) => (
    <button onClick={onClick} disabled={disabled} style={{
      width: "100%", padding: "12px 0", borderRadius: 10,
      background: disabled
        ? "rgba(99,102,241,0.2)"
        : `linear-gradient(135deg, ${ACCENT}, ${PURPLE})`,
      border: "none", color: "#fff",
      fontSize: 14, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
      boxShadow: disabled ? "none" : `0 0 20px rgba(99,102,241,0.4)`,
      transition: "all 0.2s", marginTop: 4,
    }}>{children}</button>
  );

  return (
    <div style={{
      minHeight: "100vh", background: BG, color: TEXT,
      fontFamily: "'Inter', system-ui, sans-serif",
      display: "flex", justifyContent: "center", padding: "48px 16px",
      backgroundImage: `radial-gradient(ellipse 80% 80% at 50% -20%, rgba(99,102,241,0.15), transparent)`,
    }}>
      <div style={{ width: "100%", maxWidth: 500 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 36 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 9,
              background: `linear-gradient(135deg, ${ACCENT}, ${PURPLE})`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 16, boxShadow: `0 0 16px rgba(99,102,241,0.5)`,
            }}>⚡</div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em", color: TEXT }}>AI Monorepo</h1>
          </div>
          {phaseIdx === 0 ? (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600,
              background: "rgba(251,191,36,0.1)", color: YELLOW,
              border: `1px solid rgba(251,191,36,0.3)`,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: YELLOW }} /> 需要配置
            </span>
          ) : (
            <span style={{ fontSize: 12, color: MUTED }}>第 {currentStep} / {totalSteps} 步</span>
          )}
        </div>

        {phaseIdx > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 28, justifyContent: "center" }}>
            {phases.slice(1).map((_, i) => (
              <div key={i} style={{
                height: 4, borderRadius: 2,
                width: i + 1 === currentStep ? 28 : 16,
                background: i + 1 <= currentStep
                  ? `linear-gradient(90deg, ${ACCENT}, ${PURPLE})`
                  : BORDER,
                transition: "all 0.3s",
              }} />
            ))}
          </div>
        )}

        <div style={{
          background: "rgba(255,255,255,0.04)", border: `1px solid ${BORDER}`,
          borderRadius: 16, padding: "24px", marginBottom: 16,
          backdropFilter: "blur(12px)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        }}>
          {phase === "overview" && (<>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6, color: TEXT }}>初次使用，需要简单配置</div>
            <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.6, marginBottom: 20 }}>
              以下是当前配置状态。向导会逐步引导你完成，<strong style={{ color: TEXT }}>全程只需复制一段提示词发给 AI 助手即可</strong>。
            </div>
            <StatusRow ok={status.configured} label="PROXY_API_KEY — 访问密钥" />
            <StatusRow ok={status.integrations.anthropic} label="Anthropic Integration — Claude 系列" />
            <StatusRow ok={status.integrations.openai} label="OpenAI Integration — GPT / o 系列" />
            <StatusRow ok={status.integrations.gemini} label="Gemini Integration — Gemini 系列" />
            <StatusRow ok={status.integrations.openrouter} label="OpenRouter Integration — Llama / Grok / DeepSeek 等" />
          </>)}

          {phase === "set-key" && (<>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6, color: TEXT }}>设置你的访问密钥</div>
            <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.6, marginBottom: 18 }}>
              <code style={{ background: "rgba(99,102,241,0.15)", padding: "1px 6px", borderRadius: 4, fontSize: 12, color: ACCENT2 }}>PROXY_API_KEY</code>
              {" "}是你自己设定的代理密钥，客户端用它鉴权。值可以是任意字符串，<strong style={{ color: TEXT }}>与任何第三方服务无关</strong>。
            </div>
            <input
              type="text"
              autoFocus
              placeholder="例如：my-secret-key-123"
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && keyInput.trim()) goNext(); }}
              style={{
                width: "100%", boxSizing: "border-box",
                padding: "11px 14px", borderRadius: 9,
                border: `1.5px solid ${keyInput.trim() ? BORDER_ACCENT : BORDER}`,
                background: "rgba(0,0,0,0.3)", color: TEXT,
                fontSize: 14, fontFamily: "monospace",
                outline: "none", transition: "border-color 0.15s",
              }}
            />
            {!keyInput.trim() && (
              <p style={{ margin: "8px 0 0", fontSize: 12, color: MUTED }}>填写密钥后方可继续</p>
            )}
          </>)}

          {phase === "copy-prompt" && (<>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6, color: TEXT }}>将提示词发给 Replit Assistant</div>
            <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.6, marginBottom: 18 }}>
              点击复制，然后打开 <strong style={{ color: TEXT }}>Replit Assistant（右下角 AI 图标）</strong>，把内容粘贴发送。
              助手会自动完成{needsKey ? "密钥设置、Integration 配置" : "Integration 配置"}和服务器重启。
            </div>
            <CopyBox value={unifiedPrompt} label="点击复制提示词" />
          </>)}

          {phase === "verify" && (<>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6, color: TEXT }}>等待助手完成后验证</div>
            <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.7, marginBottom: 4 }}>
              助手通常需要 1–2 分钟完成配置和重启。完成后，点击下方按钮检测是否生效。
            </div>
            <div style={{ fontSize: 12, color: MUTED }}>检测通过后将自动跳转到主页面。</div>
          </>)}
        </div>

        {phase === "overview" && <PrimaryBtn onClick={goNext}>开始配置 →</PrimaryBtn>}
        {phase === "set-key" && <PrimaryBtn onClick={goNext} disabled={!keyInput.trim()}>下一步 →</PrimaryBtn>}
        {phase === "copy-prompt" && <PrimaryBtn onClick={goNext}>已发送给助手，下一步 →</PrimaryBtn>}
        {phase === "verify" && (
          <PrimaryBtn onClick={handleRecheck} disabled={checking}>
            {checking ? "检测中…" : "✓  重新检测配置"}
          </PrimaryBtn>
        )}

        {phaseIdx > 0 && (
          <div style={{ textAlign: "center", marginTop: 14 }}>
            <button onClick={() => setPhaseIdx(i => Math.max(i - 1, 0))} style={{
              background: "none", border: "none", color: MUTED, fontSize: 12,
              cursor: "pointer", padding: "4px 8px", borderRadius: 4,
            }}>← 上一步</button>
          </div>
        )}

        {phase === "overview" && onDismiss && (
          <div style={{ marginTop: 20, textAlign: "center" }}>
            <button onClick={onDismiss} style={{
              background: "none", border: "none", color: MUTED,
              fontSize: 12, cursor: "pointer", padding: "4px 8px",
              textDecoration: "underline", textUnderlineOffset: 3,
            }}>
              稍后再说，先进主界面
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────

function MainPage({ status, onGoToSetup }: { status: SetupStatus; onGoToSetup?: () => void }) {
  const [health, setHealth] = useState<"online" | "offline" | "checking">("checking");
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<MainTab>("home");
  const [proxyKey, setProxyKey] = useState(() => localStorage.getItem(LS_PROXY_KEY) ?? "");
  const baseUrl = DISPLAY_BASE_URL;

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/healthz`);
      setHealth(res.ok ? "online" : "offline");
    } catch { setHealth("offline"); }
  }, []);

  useEffect(() => {
    checkHealth();
    const id = setInterval(checkHealth, 30000);
    return () => clearInterval(id);
  }, [checkHealth]);

  const statusColor = health === "online" ? GREEN : health === "offline" ? RED : MUTED;
  const statusLabel = health === "online" ? "Online" : health === "offline" ? "Offline" : "Checking…";

  const incomplete = onGoToSetup && (!status.configured || !status.integrations.allReady);

  const TABS: { id: MainTab; label: string; icon: string }[] = [
    { id: "home", label: "首页", icon: "⌂" },
    { id: "stats", label: "用量", icon: "◎" },
    { id: "logs", label: "日志", icon: "≡" },
  ];

  return (
    <>
      {incomplete && onGoToSetup && <ConfigBanner status={status} onGoToSetup={onGoToSetup} />}
      <div style={{
        minHeight: "100vh", background: BG, color: TEXT,
        fontFamily: "'Inter', system-ui, sans-serif",
        display: "flex", justifyContent: "center",
        padding: `${incomplete ? 88 : 40}px 16px 60px`,
        backgroundImage: `radial-gradient(ellipse 100% 60% at 50% -10%, rgba(99,102,241,0.12), transparent)`,
      }}>
        <div style={{ width: "100%", maxWidth: 700 }}>

          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10,
                background: `linear-gradient(135deg, ${ACCENT}, ${PURPLE})`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18, boxShadow: `0 0 20px rgba(99,102,241,0.45)`,
                flexShrink: 0,
              }}>⚡</div>
              <div>
                <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.1 }}>AI Monorepo</h1>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 1 }}>AI Proxy Gateway</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {health === "online" && (
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "5px 13px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                  background: "rgba(34,211,165,0.08)", color: GREEN,
                  border: "1px solid rgba(34,211,165,0.25)",
                  boxShadow: "0 0 16px rgba(34,211,165,0.1)",
                }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: "50%", background: GREEN,
                    boxShadow: `0 0 8px ${GREEN}`,
                    animation: "pulse 2s infinite",
                  }} /> {statusLabel}
                </span>
              )}
              {health !== "online" && (
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "5px 13px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                  background: `rgba(${health === "offline" ? "248,113,113" : "100,116,139"},0.08)`,
                  color: statusColor,
                  border: `1px solid rgba(${health === "offline" ? "248,113,113" : "100,116,139"},0.2)`,
                }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor }} /> {statusLabel}
                </span>
              )}
            </div>
          </div>

          {/* Tab Bar */}
          <div style={{
            display: "flex", gap: 2, marginBottom: 24,
            background: "rgba(255,255,255,0.03)",
            borderRadius: 12, padding: 4,
            border: `1px solid ${BORDER}`,
          }}>
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  flex: 1, padding: "8px 12px", borderRadius: 9, border: "none",
                  background: tab === t.id
                    ? "rgba(255,255,255,0.07)"
                    : "transparent",
                  color: tab === t.id ? TEXT : MUTED,
                  fontSize: 13, fontWeight: tab === t.id ? 600 : 400,
                  cursor: "pointer", transition: "all 0.15s",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  boxShadow: tab === t.id ? "0 1px 6px rgba(0,0,0,0.3)" : "none",
                  borderBottom: tab === t.id ? `2px solid ${ACCENT}` : "2px solid transparent",
                }}
              >
                <span style={{ fontSize: 14 }}>{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>

          {tab === "home" && <>
            {/* Base URL Card */}
            {(() => {
              const isDev = envIsDev;
              return (
                <div style={{
                  borderRadius: 14, padding: "18px 20px", marginBottom: 14,
                  background: isDev
                    ? "rgba(251,191,36,0.04)"
                    : "rgba(99,102,241,0.04)",
                  border: `1px solid ${isDev ? "rgba(251,191,36,0.2)" : BORDER_ACCENT}`,
                  backdropFilter: "blur(8px)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", color: MUTED, textTransform: "uppercase" }}>Base URL</div>
                    {isDev && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                        background: "rgba(251,191,36,0.12)", color: YELLOW,
                        border: "1px solid rgba(251,191,36,0.3)",
                      }}>
                        临时链接
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{
                      fontFamily: "monospace", fontSize: 13.5,
                      color: isDev ? YELLOW : ACCENT2,
                      flex: 1, wordBreak: "break-all", fontWeight: 500,
                    }}>{baseUrl}</span>
                    <button onClick={() => {
                      navigator.clipboard.writeText(baseUrl).then(() => {
                        setCopied(true); setTimeout(() => setCopied(false), 2000);
                      });
                    }} style={{
                      padding: "6px 14px", borderRadius: 7,
                      border: `1px solid ${BORDER}`,
                      background: copied ? "rgba(34,211,165,0.1)" : "rgba(255,255,255,0.05)",
                      color: copied ? GREEN : MUTED,
                      fontSize: 12, fontWeight: 500, cursor: "pointer", flexShrink: 0, transition: "all 0.15s",
                    }}>{copied ? "✓ 已复制" : "复制"}</button>
                  </div>
                  {isDev && (
                    <div style={{
                      marginTop: 12, paddingTop: 12,
                      borderTop: "1px solid rgba(251,191,36,0.15)",
                      fontSize: 12, color: MUTED, lineHeight: 1.65,
                    }}>
                      ⚠ 此链接为 <strong style={{ color: YELLOW }}>Replit 开发环境临时地址</strong>，每次重启后可能变化。
                      如需稳定端点，请通过 Replit <strong style={{ color: TEXT }}>Publish</strong> 功能部署后使用
                      <code style={{ marginLeft: 4, fontFamily: "monospace", color: ACCENT2, fontSize: 11 }}>*.replit.app</code> 域名。
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Hint */}
            <div style={{
              background: CARD2, borderRadius: 10,
              border: `1px solid ${BORDER}`,
              padding: "11px 16px", marginBottom: 24,
            }}>
              <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.7 }}>
                使用此 Base URL，配合你的{" "}
                <code style={{
                  fontFamily: "monospace", color: TEXT,
                  background: "rgba(255,255,255,0.07)",
                  padding: "1px 6px", borderRadius: 4, fontSize: 11,
                }}>PROXY_API_KEY</code>
                {" "}即可接入任意兼容 OpenAI 格式的客户端。
              </div>
            </div>

            <div style={{ marginBottom: 20 }}><UpdatePanel /></div>
            <div style={{ marginBottom: 20 }}><ModelGroupsPanel /></div>
          </>}

          {/* Proxy Key input for stats/logs */}
          {(tab === "logs" || tab === "stats") && (
            <div style={{
              background: CARD2, borderRadius: 10,
              border: `1px solid ${BORDER}`, padding: "14px 16px", marginBottom: 16,
            }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", color: MUTED, textTransform: "uppercase", marginBottom: 8 }}>
                Proxy Key（访问管理接口）
              </div>
              <input
                type="password"
                value={proxyKey}
                onChange={(e) => {
                  setProxyKey(e.target.value);
                  localStorage.setItem(LS_PROXY_KEY, e.target.value);
                }}
                placeholder="输入你的 PROXY_API_KEY"
                style={{
                  width: "100%", boxSizing: "border-box",
                  background: "rgba(0,0,0,0.3)", border: `1px solid ${BORDER}`,
                  borderRadius: 7, color: TEXT, fontSize: 13, padding: "8px 12px",
                  fontFamily: "monospace", outline: "none",
                  transition: "border-color 0.15s",
                }}
                onFocus={e => (e.target.style.borderColor = BORDER_ACCENT)}
                onBlur={e => (e.target.style.borderColor = BORDER)}
              />
            </div>
          )}

          {tab === "stats" && <PageStats baseUrl={API_BASE} apiKey={proxyKey} />}
          {tab === "logs" && <PageLogs baseUrl={API_BASE} apiKey={proxyKey} />}
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 8px ${GREEN}; }
          50% { opacity: 0.6; box-shadow: 0 0 4px ${GREEN}; }
        }
      `}</style>
    </>
  );
}

// ── Root ───────────────────────────────────────────────────────────────

export default function App() {
  const [appState, setAppState] = useState<AppState>("checking");
  const [setupStatus, setSetupStatus] = useState<SetupStatus>({
    configured: false,
    integrations: { anthropic: false, openai: false, gemini: false, openrouter: false, allReady: false },
  });
  const [dismissed, setDismissed] = useState(false);

  const handleDismiss = () => {
    localStorage.setItem(LS_DISMISSED, "1");
    setDismissed(true);
  };

  const handleGoToSetup = () => {
    localStorage.removeItem(LS_DISMISSED);
    setDismissed(false);
  };

  const checkSetup = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/setup-status`);
      if (res.ok) {
        const data = await res.json() as SetupStatus;
        setSetupStatus(data);
        const allReady = data.configured && data.integrations.allReady;
        if (allReady) {
          localStorage.removeItem(LS_DISMISSED);
          setDismissed(false);
          setAppState("ready");
        } else {
          const wasDismissed = localStorage.getItem(LS_DISMISSED) === "1";
          setDismissed(wasDismissed);
          setAppState("needs-setup");
        }
      } else {
        setAppState("needs-setup");
      }
    } catch {
      setAppState("needs-setup");
    }
  }, []);

  useEffect(() => { checkSetup(); }, [checkSetup]);

  if (appState === "checking") {
    return (
      <div style={{
        minHeight: "100vh", background: BG,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexDirection: "column", gap: 12,
        backgroundImage: `radial-gradient(ellipse 80% 60% at 50% -10%, rgba(99,102,241,0.12), transparent)`,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: `linear-gradient(135deg, ${ACCENT}, ${PURPLE})`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 18, boxShadow: `0 0 20px rgba(99,102,241,0.45)`,
        }}>⚡</div>
        <span style={{ color: MUTED, fontSize: 13 }}>正在初始化…</span>
      </div>
    );
  }

  if (appState === "needs-setup" && !dismissed) {
    return (
      <SetupWizard
        status={setupStatus}
        onRecheck={checkSetup}
        onDismiss={handleDismiss}
      />
    );
  }

  return (
    <MainPage
      status={setupStatus}
      onGoToSetup={dismissed ? handleGoToSetup : undefined}
    />
  );
}
