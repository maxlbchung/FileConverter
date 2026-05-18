import { FFmpeg } from "https://esm.sh/@ffmpeg/ffmpeg@0.12.10";

const FFMPEG_DIST = "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm";
const CORE_DIST = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";

let instance = null;
let loading = null;
let mountCounter = 0;

const friendlyReadError = (err, file) => {
  const sizeGB = file.size / (1024 ** 3);
  const big = sizeGB > 1.8;
  if (err?.name === "NotReadableError") {
    return new Error(
      `Couldn't read "${file.name}" from disk. Common causes:\n` +
      `  • The file is open in another program (close VLC, Media Player, etc.)\n` +
      `  • It's a OneDrive/cloud placeholder — right-click it in Explorer → "Always keep on this device"\n` +
      `  • The file moved or was renamed after you picked it — re-select it` +
      (big ? `\n  • It's ${sizeGB.toFixed(1)} GB — also at/above the browser memory limit (~2 GB)` : "")
    );
  }
  if (err?.name === "RangeError" || /too large|allocation|memory/i.test(err?.message || "")) {
    return new Error(`"${file.name}" is too big to load into browser memory (${sizeGB.toFixed(2)} GB). Use a desktop tool for files this size.`);
  }
  return err;
};

// fetchFile is kept for URL/string inputs only — File inputs should use
// prepareInput() below, which mounts via WORKERFS and never materializes
// the whole file.
export const fetchFile = async (input) => {
  if (typeof input === "string" || input instanceof URL) {
    const buf = await (await fetch(input)).arrayBuffer();
    return new Uint8Array(buf);
  }
  throw new Error("fetchFile: use prepareInput() for File/Blob inputs");
};

// Mount a File into ffmpeg's WORKERFS so ffmpeg can read it lazily in chunks.
// Returns the path inside ffmpeg's FS plus a cleanup function. The mount point
// is unique per call so concurrent jobs don't collide.
export const prepareInput = async (ffmpeg, file) => {
  // Upfront sanity read so locked / placeholder / inaccessible files fail
  // with a clear message instead of a cryptic ffmpeg "Invalid data" later.
  // Reading only 64 KB keeps this cheap even for multi-GB files.
  try {
    await file.slice(0, Math.min(file.size, 65536)).arrayBuffer();
  } catch (err) {
    throw friendlyReadError(err, file);
  }

  const mountPoint = `/mnt${mountCounter++}`;
  await ffmpeg.createDir(mountPoint).catch(() => {});
  // WORKERFS mounts the File objects so they're readable at
  // `${mountPoint}/${file.name}` without copying any bytes into MEMFS.
  await ffmpeg.mount("WORKERFS", { files: [file] }, mountPoint);

  return {
    inputPath: `${mountPoint}/${file.name}`,
    cleanup: async () => {
      try { await ffmpeg.unmount(mountPoint); } catch { }
      try { await ffmpeg.deleteDir(mountPoint); } catch { }
    },
  };
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

// Global handler slots so callers can swap progress/log routing per job.
// Internal: installed once on the ffmpeg instance, dispatches to current slot.
let activeHandlers = { onProgress: null, onLog: null };

export const setFFmpegHandlers = ({ onProgress = null, onLog = null } = {}) => {
  activeHandlers = { onProgress, onLog };
};

export const loadFFmpeg = async ({ onStatus } = {}) => {
  if (instance) return instance;
  if (loading) return loading;

  loading = (async () => {
    const ff = new FFmpeg();
    ff.on("log", ({ message }) => { activeHandlers.onLog?.(message); });
    ff.on("progress", (e) => { activeHandlers.onProgress?.(e); });

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
