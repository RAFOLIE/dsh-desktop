import { useEffect, useState } from "react";
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

/** Shell boot page: waits for DSH, then hands the whole window to the native
 *  webchat at http://127.0.0.1:3080/. After the replace, this page (and its
 *  Tauri IPC) is gone — all further shell behavior is Rust-side + tray.
 *  While the page lives it also narrates the app self-update via the pill
 *  next to the top-left name: spinner → green check → version only. */
function App() {
  const [status, setStatus] = useState<DshStatus>({ status: "starting" });
  const [customPath, setCustomPath] = useState("");
  const [pathError, setPathError] = useState("");
  const [update, setUpdate] = useState<AppUpdate>({ state: "pending" });
  const [checkVisible, setCheckVisible] = useState(false);
  const [version, setVersion] = useState("");
  const [npmProbe, setNpmProbe] = useState<NpmProbe | null>(null);

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
    let cancelled = false;

    (async () => {
      unlistenStatus = await listen<DshStatus>("dsh-status", (event) => {
        setStatus(event.payload);
      });
      unlistenUpdate = await listen<AppUpdate>("app-update", (event) => {
        setUpdate(event.payload);
      });
      if (cancelled) {
        unlistenStatus();
        unlistenUpdate();
      }
    })();
    getVersion().then(setVersion).catch(() => setVersion(""));

    return () => {
      cancelled = true;
      unlistenStatus?.();
      unlistenUpdate?.();
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

  // Hand the window to the native webchat — but let a running update finish
  // first so the pill's spinner→check story is actually seen. After `done`
  // the Rust side restarts the app onto the new exe (the running process
  // predates the fix); navigation here is only the fallback if that restart
  // never arrives. replace() keeps Back from returning to this boot page.
  useEffect(() => {
    if (status.status !== "ready") return;
    const busy =
      update.state === "pending" ||
      update.state === "checking" ||
      update.state === "downloading";
    if (busy) return;
    // `done`: the Rust side restarts onto the new exe; navigation is only
    // the fallback. `failed`: show why before handing off (used to be a
    // silent swallow — "updated" that never happened).
    const delay =
      update.state === "done" ? 8_000 : update.state === "failed" ? 4_000 : 0;
    const timer = setTimeout(
      () => window.location.replace(WEBCHAT_URL),
      delay,
    );
    return () => clearTimeout(timer);
  }, [status.status, update.state]);

  const displayVersion =
    update.state === "done" && update.to ? update.to : version;
  const spinnerActive =
    update.state === "pending" ||
    update.state === "checking" ||
    update.state === "downloading";

  return (
    <main className="boot">
      <header className="app-header">
        <span className="app-name">DeepSeek Harness</span>
        <span className="version-pill" data-state={update.state}>
          <span className="version-text">v{displayVersion}</span>
          {spinnerActive && (
            <svg className="update-ring" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6" />
            </svg>
          )}
          {update.state === "done" && (
            <svg
              className={`check${checkVisible ? " show" : ""}`}
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path d="M3 8.5 6.5 12 13 4.5" />
            </svg>
          )}
        </span>
      </header>

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
    </main>
  );
}

export default App;
