import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";

/** Rust→frontend lifecycle payloads emitted on the `dsh-status` channel. */
type DshStatus =
  | { status: "starting"; method?: string }
  | { status: "ready"; attached: boolean; method?: string }
  | { status: "notfound" }
  | { status: "error"; message: string };

/** Rust→frontend payloads emitted on the `app-update` channel by update.rs.
 *  `pending` is the frontend-only state before the first event arrives. */
type AppUpdate =
  | { state: "pending" }
  | { state: "checking" }
  | { state: "downloading"; from?: string; to?: string }
  | { state: "done"; from?: string; to?: string }
  | { state: "none" }
  | { state: "failed"; message?: string };

const WEBCHAT_URL = "http://127.0.0.1:3080/";
const REGISTRY_OFFICIAL = "https://registry.npmjs.org";
const REGISTRY_MIRROR = "https://registry.npmmirror.com";

/** Rust-side parallel speed probe of the two npm registries (ms, null=unreachable). */
type NpmProbe = { npmjsMs: number | null; npmmirrorMs: number | null; fastest: string | null };

/** The persistent shell. The window is undecorated; the app's own title bar
 *  rides on top for the whole session (boot view → webchat iframe → env
 *  overlay), so the name is always clickable and the version pill is always
 *  visible. The webchat itself loads in a same-site iframe — the shell never
 *  navigates away, which also keeps chat state alive behind the env overlay. */
function App() {
  const [status, setStatus] = useState<DshStatus>({ status: "starting" });
  const [customPath, setCustomPath] = useState("");
  const [pathError, setPathError] = useState("");
  const [update, setUpdate] = useState<AppUpdate>({ state: "pending" });
  const [checkVisible, setCheckVisible] = useState(false);
  const [version, setVersion] = useState("");
  const [npmProbe, setNpmProbe] = useState<NpmProbe | null>(null);
  /** The iframe mounts on the first `ready` and stays mounted for the rest of
   *  the session; boot regressions (restart / crash heal) only hide it. */
  const [webchatMounted, setWebchatMounted] = useState(false);
  /** Whether the webchat is on screen (boot/error/update-wait views cover it). */
  const [chatVisible, setChatVisible] = useState(false);
  /** Bumped on every ready *transition* after the first mount — remounts the
   *  iframe so a restarted backend gets a fresh webchat instead of a dead page. */
  const [reloadKey, setReloadKey] = useState(0);
  const [envOpen, setEnvOpen] = useState(false);

  // Collapse emit_ready's 10× re-emit into transitions: only a fresh
  // starting→ready edge (re)mounts or reloads the webchat iframe.
  const wasReady = useRef(false);
  const mountedRef = useRef(false);

  // Registry speed probe runs once when the notfound chooser appears; the
  // faster source becomes the primary install button, the other stays as an
  // explicit alternative. A failed probe leaves the plain default button.
  useEffect(() => {
    if (status.status !== "notfound" || npmProbe !== null) return;
    invoke<NpmProbe>("dsh_npm_probe")
      .then(setNpmProbe)
      .catch(() => {});
  }, [status.status, npmProbe]);

  useEffect(() => {
    let unlistenStatus: UnlistenFn | undefined;
    let unlistenUpdate: UnlistenFn | undefined;
    let unlistenShowEnv: UnlistenFn | undefined;
    let cancelled = false;

    (async () => {
      unlistenStatus = await listen<DshStatus>("dsh-status", (event) => {
        setStatus(event.payload);
        if (event.payload.status === "ready") {
          if (!wasReady.current) {
            wasReady.current = true;
            if (mountedRef.current) {
              setReloadKey((key) => key + 1);
            } else {
              mountedRef.current = true;
              setWebchatMounted(true);
            }
          }
        } else {
          wasReady.current = false;
          setChatVisible(false);
        }
      });
      unlistenUpdate = await listen<AppUpdate>("app-update", (event) => {
        setUpdate(event.payload);
      });
      unlistenShowEnv = await listen("show-env", () => {
        setEnvOpen(true);
      });
      if (cancelled) {
        unlistenStatus();
        unlistenUpdate();
        unlistenShowEnv();
      }
    })();
    getVersion().then(setVersion).catch(() => setVersion(""));

    return () => {
      cancelled = true;
      unlistenStatus?.();
      unlistenUpdate?.();
      unlistenShowEnv?.();
    };
  }, []);

  // Fuse: if the update events never arrive (very old build, IPC hiccup),
  // stop holding the handoff on `pending` — startup must never hang.
  useEffect(() => {
    if (update.state !== "pending") return;
    const timer = setTimeout(() => setUpdate({ state: "none" }), 10_000);
    return () => clearTimeout(timer);
  }, [update.state]);

  // The green check appears when the update lands and fades out by itself,
  // leaving the (new) version behind in the pill.
  useEffect(() => {
    if (update.state === "done") {
      setCheckVisible(true);
      const timer = setTimeout(() => setCheckVisible(false), 1_800);
      return () => clearTimeout(timer);
    }
    setCheckVisible(false);
  }, [update]);

  // Reveal the webchat on ready — but let a running update finish first so
  // the pill's spinner→check story is actually seen. After `done` the Rust
  // side restarts the app onto the new exe; switching here is only the
  // fallback if that restart never arrives. `failed`: show why first.
  useEffect(() => {
    if (status.status !== "ready") return;
    const busy =
      update.state === "pending" ||
      update.state === "checking" ||
      update.state === "downloading";
    if (busy) return;
    const delay =
      update.state === "done" ? 8_000 : update.state === "failed" ? 4_000 : 0;
    const timer = setTimeout(() => setChatVisible(true), delay);
    return () => clearTimeout(timer);
  }, [status.status, update.state]);

  const displayVersion =
    update.state === "done" && update.to ? update.to : version;
  const spinnerActive =
    update.state === "pending" ||
    update.state === "checking" ||
    update.state === "downloading";

  return (
    <main className="shell">
      <TitleBar
        displayVersion={displayVersion}
        updateState={update.state}
        spinnerActive={spinnerActive}
        checkVisible={checkVisible}
        envOpen={envOpen}
        onToggleEnv={() => setEnvOpen((open) => !open)}
      />

      <div className="content">
        {webchatMounted && (
          <iframe
            key={reloadKey}
            src={WEBCHAT_URL}
            className="webchat"
            title="DSH webchat"
            allow="clipboard-read; clipboard-write; fullscreen"
            style={{ display: chatVisible || envOpen ? "block" : "none" }}
          />
        )}

        {!chatVisible && (
          <div className="boot-wrap">
            {status.status === "starting" && (
              <div className="state">
                <div className="spinner" aria-hidden="true" />
                <div className="text">
                  正在启动 DSH…
                  {status.method ? `(${status.method})` : ""}
                </div>
                {status.method?.includes("npx") && (
                  <div className="detail">首次运行需下载 DSH 包,可能需要几分钟,请耐心等待</div>
                )}
                {update.state === "downloading" && (
                  <div className="detail">
                    正在更新应用 v{update.to ?? ""}…完成后自动进入
                  </div>
                )}
                {update.state === "done" && (
                  <div className="detail">已更新到 v{update.to ?? ""},正在自动重启…</div>
                )}
                {update.state === "failed" && (
                  <div className="detail">
                    应用更新失败(网络),已跳过——下次启动自动重试,或稍后用托盘「检查前端更新」
                  </div>
                )}
              </div>
            )}

            {status.status === "ready" && (
              <div className="state">
                <div className="spinner" aria-hidden="true" />
                <div className="text">
                  已连接{status.attached ? "(附加到已有实例)" : ""},
                  {update.state === "downloading"
                    ? "等待应用更新完成…"
                    : update.state === "done"
                      ? "新版本已就绪,自动重启中…"
                      : "正在打开…"}
                </div>
                {update.state === "downloading" && (
                  <div className="detail">正在更新应用 v{update.to ?? ""}…完成后自动进入</div>
                )}
                {update.state === "done" && (
                  <div className="detail">新版本 v{update.to ?? ""} 已就绪,应用即将自动重启生效</div>
                )}
                {update.state === "failed" && update.message !== undefined && (
                  <div className="detail">
                    应用更新失败(网络),已跳过——下次启动自动重试,或稍后用托盘「检查前端更新」
                  </div>
                )}
              </div>
            )}

            {status.status === "notfound" && (
              <div className="state">
                <div className="text error">未找到本机 DSH</div>
                <div className="detail">
                  已搜索 PATH(where dsh,含 npm 全局 dsh/dsh.cmd)、应用目录与用户目录,均未发现 DSH 安装。推荐一键安装:
                </div>
                {(() => {
                  const mirrorFastest = npmProbe?.fastest === "npmmirror";
                  const ms = (v: number | null) => (v === null ? "不通" : `${v}ms`);
                  const primaryRegistry: string | null = mirrorFastest
                    ? REGISTRY_MIRROR
                    : npmProbe?.fastest === "npmjs"
                      ? REGISTRY_OFFICIAL
                      : null; // probe pending/failed: plain npm default
                  const secondaryRegistry = mirrorFastest ? REGISTRY_OFFICIAL : REGISTRY_MIRROR;
                  const primaryLabel = mirrorFastest
                    ? `一键全局安装并启动(已选最快:国内镜像 ${ms(npmProbe?.npmmirrorMs ?? null)})`
                    : npmProbe?.fastest === "npmjs"
                      ? `一键全局安装并启动(已选最快:官方源 ${ms(npmProbe.npmjsMs)})`
                      : "一键全局安装并启动(推荐,约 1-3 分钟)";
                  const secondaryLabel = mirrorFastest
                    ? `改用官方源安装(${ms(npmProbe?.npmjsMs ?? null)})`
                    : `改用国内镜像安装(${ms(npmProbe?.npmmirrorMs ?? null)})`;
                  return (
                    <>
                      <button type="button" onClick={() => invoke("dsh_install_npm", { registry: primaryRegistry })}>
                        {primaryLabel}
                      </button>
                      {npmProbe !== null && (
                        <button className="btn-secondary" type="button" onClick={() => invoke("dsh_install_npm", { registry: secondaryRegistry })}>
                          {secondaryLabel}
                        </button>
                      )}
                    </>
                  );
                })()}
                <button type="button" onClick={() => invoke("dsh_download")}>
                  下载并启动(npx 缓存,备选)
                </button>
                <input
                  className="path-input"
                  value={customPath}
                  placeholder="已知安装位置?粘贴 dsh.cmd 完整路径"
                  onChange={(event) => { setCustomPath(event.target.value); setPathError("") }}
                />
                <button
                  type="button"
                  onClick={() => {
                    invoke("dsh_custom_path", { path: customPath })
                      .catch((error: string) => { setPathError(String(error)) })
                  }}
                >
                  使用此路径启动
                </button>
                {pathError !== "" && <div className="detail">{pathError}</div>}
                <button type="button" onClick={() => invoke("dsh_retry")}>
                  重新检测
                </button>
                <button type="button" onClick={() => invoke("dsh_exit")}>
                  退出
                </button>
                <div className="detail">
                  全局安装后终端可用 dsh 命令,应用启动最快且无需网络;不想全局装就选 npx 备选或填路径
                </div>
              </div>
            )}

            {status.status === "error" && (
              <div className="state">
                <div className="text error">DSH 启动失败</div>
                <div className="detail">{status.message}</div>
                <button type="button" onClick={() => invoke("dsh_retry")}>
                  重试
                </button>
                <button type="button" onClick={() => invoke("dsh_download")}>
                  改用 npx 下载启动
                </button>
              </div>
            )}
          </div>
        )}

        {envOpen && <EnvPage onClose={() => setEnvOpen(false)} />}
      </div>
    </main>
  );
}

/** The app's own title bar (window is undecorated): logo + name (click → env
 *  overlay) + version pill with the update story, a drag region, and native
 *  minimize / maximize-restore / close buttons. All window operations go
 *  through app commands (Rust-side calls) — the frontend window-plugin path
 *  silently no-op'd here. Close goes through the Rust CloseRequested
 *  handler, which hides to tray instead of exiting. */
function TitleBar({
  displayVersion,
  updateState,
  spinnerActive,
  checkVisible,
  envOpen,
  onToggleEnv,
}: {
  displayVersion: string;
  updateState: AppUpdate["state"];
  spinnerActive: boolean;
  checkVisible: boolean;
  envOpen: boolean;
  onToggleEnv: () => void;
}) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const sync = () => {
      invoke<boolean>("window_is_maximized")
        .then(setMaximized)
        .catch(() => {});
    };
    sync();
    const timer = window.setInterval(sync, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const dragStrip = (
    <div
      className="titlebar-drag"
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        invoke("window_start_drag").catch(() => {});
      }}
      onDoubleClick={() => invoke("window_toggle_maximize").catch(() => {})}
    />
  );

  return (
    <header className="titlebar">
      <svg className="tb-logo" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 1.2 13.7 4.5v6.4L8 14.2 2.3 10.9V4.5Z"
          fill="none"
          stroke="#58a6ff"
          strokeWidth="1.4"
        />
        <circle cx="8" cy="7.7" r="1.7" fill="#58a6ff" />
      </svg>
      <button
        type="button"
        className="app-name"
        title="查看环境配置"
        onClick={onToggleEnv}
      >
        DeepSeek Harness
      </button>
      <span className="version-pill" data-state={updateState}>
        <span className="version-text">v{displayVersion}</span>
        {spinnerActive && (
          <svg className="update-ring" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" />
          </svg>
        )}
        {updateState === "done" && (
          <svg
            className={`check${checkVisible ? " show" : ""}`}
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path d="M3 8.5 6.5 12 13 4.5" />
          </svg>
        )}
      </span>
      {envOpen && <span className="tb-env-hint">环境配置</span>}

      {dragStrip}

      <button
        type="button"
        className="tb-btn"
        title="最小化"
        onClick={() => invoke("window_minimize").catch(() => {})}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <rect x="0.5" y="4.75" width="9" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        className="tb-btn"
        title={maximized ? "还原" : "最大化"}
        onClick={() => invoke("window_toggle_maximize").catch(() => {})}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
            <path d="M2.8 2.2V0.8h6.4v6.4H7.8" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="tb-btn tb-close"
        title="关闭(隐藏到托盘,DSH 继续运行)"
        onClick={() => invoke("window_close").catch(() => {})}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.8 0.8 9.2 9.2 M9.2 0.8 0.8 9.2" stroke="currentColor" strokeWidth="1.1" fill="none" />
        </svg>
      </button>
    </header>
  );
}

/** Rust-side env_info payload (all fields nullable — probes degrade). */
type EnvInfo = {
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
  logTail?: string[];
};

/** One label-over-value fact row (Comfy Desktop StatusFactPanel style). */
function Fact({
  label,
  value,
  mono,
  openable,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  openable?: boolean;
}) {
  const shown = value === null || value === undefined || value === "" ? "—" : value;
  return (
    <div className="env-row">
      <div className="env-label">{label}</div>
      <div className="env-value-wrap">
        <span className={`env-value${mono ? " mono" : ""}`}>{shown}</span>
        {shown !== "—" && (
          <>
            <button
              type="button"
              className="env-mini"
              title="复制"
              onClick={() => navigator.clipboard?.writeText(shown)}
            >
              复制
            </button>
            {openable && (
              <button
                type="button"
                className="env-mini"
                title="在资源管理器中打开"
                onClick={() => invoke("open_path", { path: shown })}
              >
                打开目录
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Environment panel overlay: slides over whatever is underneath (webchat or
 *  boot view) without unmounting it, so chat state survives a visit. */
function EnvPage({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<EnvInfo | null>(null);
  const [error, setError] = useState("");
  const load = () => {
    setError("");
    setInfo(null);
    invoke<EnvInfo>("env_info")
      .then(setInfo)
      .catch((e: string) => setError(String(e)));
  };
  useEffect(() => {
    load();
  }, []);

  const dsh = info?.dsh;
  const owner = dsh?.owner;
  return (
    <div className="env-overlay">
      <div className="env-page">
        <div className="env-actions">
          <span className="env-title">环境配置</span>
          <button type="button" className="btn-secondary" onClick={load}>
            刷新
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            关闭
          </button>
        </div>
        {error !== "" && <div className="detail">{error}</div>}
        {info === null && error === "" && <div className="detail">正在采集环境信息…</div>}

        {info !== null && (
          <>
            <section className="env-section">
              <div className="env-section-title">运行状态</div>
              <Fact label="DSH 端口 (3080)" value={dsh?.portAnswering ? "应答正常" : "无应答"} />
              <Fact label="占用进程 PID" value={owner?.pid !== undefined ? String(owner.pid) : null} />
              <Fact label="进程命令行" value={owner?.cmd ?? null} mono />
              <Fact
                label="归属"
                value={owner === null || owner === undefined ? null : owner.owned ? "本应用子进程(受监护)" : "外部实例(不归本应用管)"}
              />
              <Fact label="父链" value={owner?.chain ?? null} mono />
            </section>

            <section className="env-section">
              <div className="env-section-title">DSH 内核</div>
              <Fact label="where dsh" value={dsh?.whereDsh ?? null} mono openable />
              <Fact label="自定义路径" value={dsh?.customPath ?? null} mono openable />
              <Fact label="本地安装" value={dsh?.localInstall?.shim ?? null} mono openable />
              <Fact label="DSH_CMD 环境变量" value={dsh?.dshCmd ?? null} mono />
              <Fact label="DSH_CWD 环境变量" value={dsh?.dshCwd ?? null} mono />
              <Fact label="npx 回退已授权" value={dsh?.preferNpx ? "是" : "否"} />
              <Fact label="dsh-desktop-plugin" value={info.plugins?.dshDesktopPlugin ?? null} />
              <Fact label="dshmarket" value={info.plugins?.dshmarket ?? null} />
              <Fact label="Profile 目录" value={info.profileDir} mono openable />
            </section>

            <section className="env-section">
              <div className="env-section-title">Node 环境</div>
              <Fact label="node 路径" value={info.node?.path ?? null} mono openable />
              <Fact label="node 版本" value={info.node?.version ?? null} />
            </section>

            <section className="env-section">
              <div className="env-section-title">本应用</div>
              <Fact label="版本" value={info.app?.version} />
              <Fact label="安装目录" value={info.app?.installDir} mono openable />
            </section>

            <section className="env-section">
              <div className="env-section-title">日志 (dsh.log 尾部)</div>
              <pre className="env-console">{(info.logTail ?? []).join("\n") || "(空)"}</pre>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
