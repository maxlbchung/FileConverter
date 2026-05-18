import { FFmpeg } from "https://esm.sh/@ffmpeg/ffmpeg@0.12.10";
import { fetchFile, toBlobURL } from "https://esm.sh/@ffmpeg/util@0.12.1";

const FFMPEG_BASE = "https://esm.sh/@ffmpeg/ffmpeg@0.12.10/es2022";
const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

let instance = null;
let loading = null;

export { fetchFile };

export const loadFFmpeg = async ({ onLog, onProgress, onStatus } = {}) => {
  if (instance) {
    if (onLog) instance.on("log", ({ message }) => onLog(message));
    if (onProgress) instance.on("progress", (e) => onProgress(e));
    return instance;
  }
  if (loading) return loading;

  loading = (async () => {
    const ff = new FFmpeg();
    if (onLog) ff.on("log", ({ message }) => onLog(message));
    if (onProgress) ff.on("progress", (e) => onProgress(e));

    onStatus?.("Loading FFmpeg core (first run only — ~30 MB)…");
    // Worker must be constructed from a same-origin URL — fetch it cross-origin
    // and wrap in a blob URL so `new Worker(blob:...)` works on GitHub Pages.
    const [coreURL, wasmURL, classWorkerURL] = await Promise.all([
      toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      toBlobURL(`${FFMPEG_BASE}/worker.js`, "text/javascript"),
    ]);

    await ff.load({ coreURL, wasmURL, classWorkerURL });
    instance = ff;
    return ff;
  })();

  return loading;
};
