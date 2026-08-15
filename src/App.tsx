import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";

/** Rust→frontend lifecycle payloads emitted on the `dsh-status` channel. */
type DshStatus =
  | { status: "starting"; method?: string }
  | { status: "ready"; attached: boolean; method?: string }
  | { status: "notfound" }
  | { status: "error"; message: string };

/** Shell boot page: waits for DSH, then hands the whole window to the native
 *  webchat at http://127.0.0.1:3080/. After the replace, this page (and its
 *  Tauri IPC) is gone — all further shell behavior is Rust-side + tray. */
function App() {
  const [status, setStatus] = useState<DshStatus>({ status: "starting" });
  const [customPath, setCustomPath] = useState("");
  const [pathError, setPathError] = useState("");

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    (async () => {
      unlisten = await listen<DshStatus>("dsh-status", (event) => {
        const next = event.payload;
        setStatus(next);
        // Hand the window to the native webchat; replace() keeps Back from
        // returning to this boot page.
        if (next.status === "ready") {
          window.location.replace("http://127.0.0.1:3080/");
        }
      });
      if (cancelled) {
        unlisten();
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <main className="boot">
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
        </div>
      )}

      {status.status === "ready" && (
        <div className="state">
          <div className="spinner" aria-hidden="true" />
          <div className="text">
            已连接{status.attached ? "(附加到已有实例)" : ""},正在打开…
          </div>
        </div>
      )}

      {status.status === "notfound" && (
        <div className="state">
          <div className="text error">未找到本机 DSH</div>
          <div className="detail">
            已搜索 PATH(where dsh,含 npm 全局 dsh/dsh.cmd)、应用目录与用户目录,均未发现 DSH 安装。请选择:
          </div>
          <button type="button" onClick={() => invoke("dsh_download")}>
            下载并启动(首次约几分钟)
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
            推荐:命令行执行 npm i -g @deepseek-ai/dsh
            全局安装,之后启动不再询问;选过「下载并启动」后下次也会自动走 npx
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
