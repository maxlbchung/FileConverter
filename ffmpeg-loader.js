import { FFmpeg } from "https://esm.sh/@ffmpeg/ffmpeg@0.12.10";
import { fetchFile } from "https://esm.sh/@ffmpeg/util@0.12.1";

const FFMPEG_DIST = "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm";
const CORE_DIST = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";

let instance = null;
let loading = null;

export { fetchFile };

// The shipped dist/esm/worker.js has relative imports (./const.js, ./errors.js)
// that won't resolve when the worker is constructed from a blob: URL. Fetch
// the three files and inline-bundle them so the worker is self-contained.
const buildWorkerBlobURL = async () => {
  const [worker, consts, errors] = await Promise.all([
    fetch(`${FFMPEG_DIST}/worker.js`).then((r) => r.text()),
    fetch(`${FFMPEG_DIST}/const.js`).then((r) => r.text()),
    fetch(`${FFMPEG_DIST}/errors.js`).then((r) => r.text()),
  ]);
  const stripped = worker.replace(
    /^\s*import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/(?:const|errors)\.js['"];?\s*$/gm,
    "",
  );
  const combined = `${consts}\n${errors}\n${stripped}`;
  return URL.createObjectURL(new Blob([combined], { type: "text/javascript" }));
};

const fetchBlobURL = async (url, type) => {
  const buf = await (await fetch(url)).arrayBuffer();
  return URL.createObjectURL(new Blob([buf], { type }));
};

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
    const [coreURL, wasmURL, classWorkerURL] = await Promise.all([
      fetchBlobURL(`${CORE_DIST}/ffmpeg-core.js`, "text/javascript"),
      fetchBlobURL(`${CORE_DIST}/ffmpeg-core.wasm`, "application/wasm"),
      buildWorkerBlobURL(),
    ]);

    await ff.load({ coreURL, wasmURL, classWorkerURL });
    instance = ff;
    return ff;
  })();

  return loading;
};
