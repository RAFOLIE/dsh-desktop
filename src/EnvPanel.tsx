import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Rust-side env_info payload (all fields nullable — probes degrade). */
export type EnvInfo = {
  app?: { version?: string; installDir?: string };
  dsh?: {
    portAnswering?: boolean;
    owner?: { pid?: number; cmd?: string; chain?: string; owned?: boolean } | null;
    dshCmd?: string | null;
    dshCwd?: string | null;
    customPath?: string | null;
    whereDsh?: string | null;
    localInstall?: { shim?: string; root?: string } | null;
    preferNpx?: boolean;
  };
  node?: { path?: string | null; version?: string | null };
  plugins?: { dshDesktopPlugin?: string | null; dshmarket?: string | null };
  profileDir?: string;
  logDir?: string | null;
  workspaceDir?: string | null;
  cacheDir?: string | null;
  profileSizeBytes?: number | null;
  logTail?: string[];
};

/** Which detail tab is active. */
type Tab = "env" | "log";

const TABS: { id: Tab; label: string }[] = [
  { id: "env", label: "环境" },
  { id: "log", label: "日志" },
];

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "未检测到";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

/** Small self-dismissing toast ("已复制" style); never blocks anything. */
function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="ep-toast">{message}</div>;
}

/** 30px icon button (copy / open dir), weak by default, framed on hover. */
function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="ep-icon-btn"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const CopyIcon = (
  <svg viewBox="0 0 14 14" aria-hidden="true">
    <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M9.5 2.5h-6a1 1 0 0 0-1 1v6" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

const FolderIcon = (
  <svg viewBox="0 0 14 14" aria-hidden="true">
    <path
      d="M1.5 4a1 1 0 0 1 1-1h3l1.2 1.5H11.5a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    />
  </svg>
);

/** One field row inside a section card: name / value / action icons. */
function FieldRow({
  label,
  value,
  mono,
  openable,
  onCopy,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  openable?: boolean;
  onCopy: (text: string) => void;
}) {
  const shown = value === null || value === undefined || value === "" ? "未检测到" : value;
  const absent = shown === "未检测到";
  return (
    <div className="ep-row">
      <div className="ep-row-label">{label}</div>
      <div className={`ep-row-value${mono ? " mono" : ""}${absent ? " absent" : ""}`}>{shown}</div>
      <div className="ep-row-actions">
        {!absent && (
          <IconButton label="复制" onClick={() => onCopy(shown)}>
            {CopyIcon}
          </IconButton>
        )}
        {!absent && openable && (
          <IconButton label="打开目录" onClick={() => invoke("open_path", { path: shown }).catch(() => {})}>
            {FolderIcon}
          </IconButton>
        )}
      </div>
    </div>
  );
}

/** Section = main-function title ABOVE one big rounded card wrapping all its
 *  rows, hairline-separated (spec's core visual rule). */
function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="ep-group">
      <div className="ep-group-title">{title}</div>
      <div className="ep-card">{children}</div>
    </section>
  );
}

/** Log tab: shell session console with level filters, follow-on-scroll,
 *  clear-display (frontend only) and jump-to-latest. */
function LogViewer({ onCopy }: { onCopy: (text: string, note: string) => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [polling, setPolling] = useState(true);
  const [follow, setFollow] = useState(true);
  const [cleared, setCleared] = useState(false);
  const [levels, setLevels] = useState<Record<"INFO" | "WARN" | "ERROR", boolean>>({
    INFO: true,
    WARN: true,
    ERROR: true,
  });
  const consoleRef = useRef<HTMLPreElement>(null);

  const load = useCallback(() => {
    invoke<string[]>("log_tail", { lines: 400 })
      .then((fresh) => {
        setLines(fresh);
        setCleared(false);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(load, 2000);
    return () => window.clearInterval(timer);
  }, [polling, load]);

  // Follow the tail unless the user scrolled up (pause auto-follow only).
  useEffect(() => {
    if (!follow) return;
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, follow, levels]);

  const levelOf = (line: string): "INFO" | "WARN" | "ERROR" | null => {
    const match = line.match(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[(INFO|WARN|ERROR)\]/);
    return (match?.[1] as "INFO" | "WARN" | "ERROR") ?? null;
  };

  const visible = useMemo(() => {
    const source = cleared ? [] : lines ?? [];
    return source.filter((line) => {
      const level = levelOf(line);
      return level === null || levels[level];
    });
  }, [lines, levels, cleared]);

  const lineClass = (line: string): string => {
    if (line.startsWith("**")) return "log-banner";
    if (levelOf(line) === "ERROR") return "log-error";
    if (levelOf(line) === "WARN") return "log-warn";
    return "";
  };

  return (
    <div className="ep-log">
      <div className="ep-log-toolbar">
        {(["INFO", "WARN", "ERROR"] as const).map((level) => (
          <button
            key={level}
            type="button"
            className={`ep-pill ep-pill-sm${levels[level] ? " active" : ""}`}
            aria-pressed={levels[level]}
            onClick={() => setLevels((s) => ({ ...s, [level]: !s[level] }))}
          >
            {level === "WARN" ? "WARNING" : level}
          </button>
        ))}
        <span className="ep-log-spacer" />
        <button type="button" className="ep-tool-btn" onClick={() => setPolling((p) => !p)}>
          {polling ? "暂停自动刷新" : "恢复自动刷新"}
        </button>
        <button
          type="button"
          className="ep-tool-btn"
          onClick={() => onCopy((lines ?? []).join("\n"), "已复制")}
        >
          复制全部
        </button>
        <button type="button" className="ep-tool-btn" onClick={() => setCleared(true)}>
          清空显示
        </button>
        <button
          type="button"
          className="ep-tool-btn"
          onClick={() => {
            setFollow(true);
            const el = consoleRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          跳到最新
        </button>
      </div>
      <pre
        ref={consoleRef}
        className="ep-log-console"
        onScroll={(event) => {
          const el = event.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
      >
        {lines === null && "读取中…"}
        {lines !== null && visible.length === 0 && (cleared ? "(已清空显示,新日志继续到达)" : "(空)")}
        {visible.map((line, i) => (
          <span key={i} className={lineClass(line)}>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

/** The environment panel: search bar / env+log tabs / grouped fact cards /
 *  bottom action bar. Only real data and real actions. */
export default function EnvPanel({
  initialTab,
  info,
  error,
  refreshing,
  onRefresh,
  onClose,
}: {
  initialTab: Tab;
  info: EnvInfo | null;
  error: string;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  // Esc closes; focus starts in the search box (spec: keyboard support).
  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Dismiss the "更多" dropdown on outside clicks.
  useEffect(() => {
    if (!moreOpen) return;
    const onClick = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [moreOpen]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 1600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const copy = useCallback((text: string, note = "已复制") => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setToast(note);
  }, []);

  const dsh = info?.dsh;
  const owner = dsh?.owner;
  const running = dsh?.portAnswering === true;

  const q = query.trim().toLowerCase();
  const matches = (label: string, value: string | null | undefined) =>
    q === "" ||
    label.toLowerCase().includes(q) ||
    (value ?? "").toLowerCase().includes(q);

  const exportBundle = () => {
    setMoreOpen(false);
    invoke<{ dir: string; content: string }>("diagnostic_export")
      .then((result) => {
        navigator.clipboard?.writeText(result.content).catch(() => {});
        invoke("open_path", { path: result.dir }).catch(() => {});
        setToast("诊断包已复制+已导出");
      })
      .catch(() => setToast("诊断包导出失败"));
  };

  const restart = () => {
    if (!window.confirm("重启 dsh web 后端?会话数据不丢失,窗口将短暂回到启动页")) return;
    invoke("dsh_restart_backend").catch(() => {});
    onClose();
  };

  const statusRow = running ? (
    <span className="ep-status ok">
      <span className="ep-dot ok" />
      运行正常
    </span>
  ) : (
    <span className="ep-status warn">
      <span className="ep-dot warn" />
      无应答
    </span>
  );

  return (
    <div
      className="ep-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ep-dialog" role="dialog" aria-modal="true" aria-label="环境管理">
        {/* 1. Search bar */}
        <div className="ep-search">
          <svg className="ep-search-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10 10 14 14" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <input
            ref={searchRef}
            value={query}
            placeholder="搜索环境信息"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query !== "" ? (
            <button type="button" className="ep-icon-btn" title="清空搜索" aria-label="清空搜索" onClick={() => setQuery("")}>
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0.8 0.8 9.2 9.2 M9.2 0.8 0.8 9.2" stroke="currentColor" strokeWidth="1.2" fill="none" />
              </svg>
            </button>
          ) : (
            <button type="button" className="ep-icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0.8 0.8 9.2 9.2 M9.2 0.8 0.8 9.2" stroke="currentColor" strokeWidth="1.2" fill="none" />
              </svg>
            </button>
          )}
        </div>

        {/* Body: tabs + full-width content (single column) */}
        <div className="ep-body">
          <div className="ep-detail">
            <nav className="ep-nav">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`ep-tab${tab === t.id ? " active" : ""}`}
                  aria-current={tab === t.id ? "page" : undefined}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </nav>

            <div className="ep-content">
              {tab === "env" ? (
                info === null && error === "" ? (
                  <div className="ep-loading">
                    <div className="spinner" aria-hidden="true" />
                    正在采集环境信息…
                  </div>
                ) : (
                  <div className="ep-content-inner">
                    {error !== "" && (
                      <div className="ep-error">
                        检测失败:{error}
                        <button type="button" className="ep-tool-btn" onClick={onRefresh}>
                          重新检测
                        </button>
                      </div>
                    )}
                    {info !== null && (
                      <>
                        <SectionCard title="运行状态">
                          {matches("应用状态", running ? "运行正常" : "无应答") && (
                            <div className="ep-row">
                              <div className="ep-row-label">应用状态</div>
                              <div className="ep-row-value">{statusRow}</div>
                              <div className="ep-row-actions" />
                            </div>
                          )}
                          {matches("占用进程 PID", owner?.pid !== undefined ? String(owner.pid) : null) && (
                            <FieldRow label="占用进程 PID" value={owner?.pid !== undefined ? String(owner.pid) : null} mono onCopy={copy} />
                          )}
                          {matches("进程命令行", owner?.cmd) && (
                            <FieldRow label="进程命令行" value={owner?.cmd ?? null} mono onCopy={copy} />
                          )}
                          {matches("归属", owner?.owned ? "本地" : "外部") && (
                            <FieldRow
                              label="归属"
                              value={owner == null ? null : owner.owned ? "本应用子进程(受监护)" : "外部实例(不归本应用管)"}
                              onCopy={copy}
                            />
                          )}
                          {matches("父链", owner?.chain) && (
                            <FieldRow label="父链" value={owner?.chain ?? null} mono onCopy={copy} />
                          )}
                        </SectionCard>

                        <SectionCard title="DSH 内核">
                          {matches("where dsh", dsh?.whereDsh) && (
                            <FieldRow label="where dsh" value={dsh?.whereDsh ?? null} mono openable onCopy={copy} />
                          )}
                          {matches("自定义路径", dsh?.customPath) && (
                            <FieldRow label="自定义路径" value={dsh?.customPath ?? null} mono openable onCopy={copy} />
                          )}
                          {matches("本地安装", dsh?.localInstall?.shim) && (
                            <FieldRow label="本地安装" value={dsh?.localInstall?.shim ?? null} mono openable onCopy={copy} />
                          )}
                          {matches("DSH_CMD 环境变量", dsh?.dshCmd) && (
                            <FieldRow label="DSH_CMD 环境变量" value={dsh?.dshCmd ?? null} mono onCopy={copy} />
                          )}
                          {matches("DSH_CWD 环境变量", dsh?.dshCwd) && (
                            <FieldRow label="DSH_CWD 环境变量" value={dsh?.dshCwd ?? null} mono onCopy={copy} />
                          )}
                          {matches("npx 回退已授权", dsh?.preferNpx ? "是" : "否") && (
                            <FieldRow label="npx 回退已授权" value={dsh?.preferNpx ? "是" : "否"} onCopy={copy} />
                          )}
                        </SectionCard>

                        <SectionCard title="组件版本">
                          {matches("dsh-desktop-plugin", info.plugins?.dshDesktopPlugin) && (
                            <FieldRow label="dsh-desktop-plugin" value={info.plugins?.dshDesktopPlugin ?? null} mono onCopy={copy} />
                          )}
                          {matches("dshmarket", info.plugins?.dshmarket) && (
                            <FieldRow label="dshmarket" value={info.plugins?.dshmarket ?? null} mono onCopy={copy} />
                          )}
                          {matches("Node.js", info.node?.version) && (
                            <FieldRow label="Node.js" value={info.node?.version ?? null} mono onCopy={copy} />
                          )}
                          {matches("DeepSeek Harness 版本", info.app?.version) && (
                            <FieldRow label="DeepSeek Harness 版本" value={info.app?.version} mono onCopy={copy} />
                          )}
                        </SectionCard>

                        <SectionCard title="位置与存储">
                          {matches("Profile 目录", info.profileDir) && (
                            <FieldRow label="Profile 目录" value={info.profileDir} mono openable onCopy={copy} />
                          )}
                          {matches("工作目录", info.workspaceDir) && (
                            <FieldRow label="工作目录" value={info.workspaceDir ?? null} mono openable onCopy={copy} />
                          )}
                          {matches("日志目录", info.logDir) && (
                            <FieldRow label="日志目录" value={info.logDir ?? null} mono openable onCopy={copy} />
                          )}
                          {matches("缓存目录", info.cacheDir) && (
                            <FieldRow label="缓存目录" value={info.cacheDir ?? null} mono onCopy={copy} />
                          )}
                          {matches("磁盘占用", undefined) && (
                            <FieldRow
                              label="磁盘占用 (Profile)"
                              value={info.profileSizeBytes === null || info.profileSizeBytes === undefined ? null : formatBytes(info.profileSizeBytes)}
                              onCopy={copy}
                            />
                          )}
                        </SectionCard>
                      </>
                    )}
                  </div>
                )
              ) : (
                <LogViewer onCopy={copy} />
              )}
            </div>
          </div>
        </div>

        {/* 4. Bottom action bar (right-aligned actions only) */}
        <div className="ep-bottom">
          <button type="button" className="ep-secondary" disabled={refreshing} onClick={onRefresh}>
            {refreshing ? "检测中…" : "刷新检测"}
          </button>
          <button type="button" className="ep-primary" onClick={restart}>
            重启
          </button>
          <div className="ep-more" ref={moreRef}>
            <button type="button" className="ep-secondary" onClick={() => setMoreOpen((o) => !o)}>
              更多 ⌃
            </button>
              {moreOpen && (
                <div className="ep-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      const dir = info?.dsh?.dshCwd ?? info?.workspaceDir;
                      if (dir) invoke("open_path", { path: dir }).catch(() => {});
                    }}
                  >
                    打开工作目录
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      if (info?.logDir) invoke("open_path", { path: info.logDir }).catch(() => {});
                    }}
                  >
                    打开日志目录
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      copy(JSON.stringify(info ?? {}, null, 2), "环境信息已复制");
                    }}
                  >
                    复制全部环境信息
                  </button>
                  <button type="button" role="menuitem" onClick={exportBundle}>
                    导出诊断信息
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      if (!window.confirm("前后端重启?应用与 DSH 后端都会重启,会话数据不丢失")) return;
                      invoke("app_full_restart").catch(() => {});
                    }}
                  >
                    前后端重启
                  </button>
                </div>
              )}
          </div>
        </div>

        <Toast message={toast} />
      </div>
    </div>
  );
}
