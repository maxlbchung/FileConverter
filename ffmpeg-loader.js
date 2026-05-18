import { FFmpeg } from "https://esm.sh/@ffmpeg/ffmpeg@0.12.10";

const FFMPEG_DIST = "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm";
const CORE_DIST = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";

let instance = null;
let loading = null;

const readViaStream = async (file) => {
  const chunks = [];
  const reader = file.stream().getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

const friendlyReadError = (err, file) => {
  const sizeGB = file.size / (1024 ** 3);
  const big = sizeGB > 1.8;
  if (err?.name === "NotReadableError") {
    return new Error(
      `Couldn't read "${file.name}" from disk. Common causes:\n` +
      `  • The file is open in another program (close VLC, Media Player, etc.)\n` +
      `  • It's a OneDrive/cloud placeholder — right-click it in Explorer → "Always keep on this device"\n` +
      `  • The file moved or was renamed after you picked it — re-select it` +
      (big ? `\n  • It's ${sizeGB.toFixed(1)} GB — too big for browser memory (limit is ~2 GB)` : "")
    );
  }
  if (err?.name === "RangeError" || /too large|allocation|memory/i.test(err?.message || "")) {
    return new Error(`"${file.name}" is too big to load into browser memory (${sizeGB.toFixed(2)} GB). Try a smaller file or use a desktop tool.`);
  }
  return err;
};

export const fetchFile = async (file) => {
  if (typeof file === "string" || file instanceof URL) {
    const buf = await (await fetch(file)).arrayBuffer();
    return new Uint8Array(buf);
  }
  if (!(file instanceof Blob || file instanceof File)) {
    throw new Error("fetchFile: unsupported input type");
  }
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    // arrayBuffer() can fail with NotReadableError on Windows when the file is
    // locked or a OneDrive placeholder, and can hit allocation limits >~2 GB.
    // Try stream() as a fallback — it works for some of these cases.
    try {
      return await readViaStream(file);
    } catch (err2) {
      throw friendlyReadError(err2, file);
    }
  }
};

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
