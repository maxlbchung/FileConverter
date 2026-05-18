import { FFmpeg } from "https://esm.sh/@ffmpeg/ffmpeg@0.12.10";
import { fetchFile, toBlobURL } from "https://esm.sh/@ffmpeg/util@0.12.1";

const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

const $ = (id) => document.getElementById(id);
const dropzone = $("dropzone");
const fileInput = $("file-input");
const fileInfo = $("file-info");
const fileName = $("file-name");
const fileSize = $("file-size");
const convertBtn = $("convert-btn");
const resetBtn = $("reset-btn");
const progress = $("progress");
const progressFill = $("progress-fill");
const progressText = $("progress-text");
const result = $("result");
const downloadLink = $("download-link");
const logSection = $("log");
const logOutput = $("log-output");

let ffmpeg = null;
let ffmpegLoading = null;
let currentFile = null;
let lastDownloadUrl = null;

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let i = -1;
  do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
  return `${bytes.toFixed(2)} ${units[i]}`;
};

const setStatus = (msg) => { progressText.textContent = msg; };

const appendLog = (line) => {
  logSection.classList.remove("hidden");
  logOutput.textContent += line + "\n";
  logOutput.scrollTop = logOutput.scrollHeight;
};

const loadFFmpeg = async () => {
  if (ffmpeg) return ffmpeg;
  if (ffmpegLoading) return ffmpegLoading;

  ffmpegLoading = (async () => {
    const instance = new FFmpeg();
    instance.on("log", ({ message }) => appendLog(message));
    instance.on("progress", ({ progress: p }) => {
      const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
      progressFill.style.width = `${pct}%`;
      setStatus(`Converting… ${pct}%`);
    });

    setStatus("Loading FFmpeg core…");
    await instance.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    });
    ffmpeg = instance;
    return instance;
  })();

  return ffmpegLoading;
};

const selectFile = (file) => {
  if (!file) return;
  const isMkv = file.name.toLowerCase().endsWith(".mkv") || file.type === "video/x-matroska";
  if (!isMkv) {
    alert("Please choose an .mkv file.");
    return;
  }
  currentFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  fileInfo.classList.remove("hidden");
  convertBtn.disabled = false;
  result.classList.add("hidden");
  progress.classList.add("hidden");
  if (lastDownloadUrl) {
    URL.revokeObjectURL(lastDownloadUrl);
    lastDownloadUrl = null;
  }
};

const reset = () => {
  currentFile = null;
  fileInput.value = "";
  fileInfo.classList.add("hidden");
  progress.classList.add("hidden");
  result.classList.add("hidden");
  convertBtn.disabled = true;
  progressFill.style.width = "0%";
  if (lastDownloadUrl) {
    URL.revokeObjectURL(lastDownloadUrl);
    lastDownloadUrl = null;
  }
};

const convert = async () => {
  if (!currentFile) return;
  convertBtn.disabled = true;
  resetBtn.disabled = true;
  progress.classList.remove("hidden");
  result.classList.add("hidden");
  progressFill.style.width = "0%";
  logOutput.textContent = "";

  try {
    const instance = await loadFFmpeg();

    const inputName = "input.mkv";
    const outputName = currentFile.name.replace(/\.mkv$/i, "") + ".mp4";
    const workOutput = "output.mp4";

    setStatus("Reading file…");
    await instance.writeFile(inputName, await fetchFile(currentFile));

    setStatus("Remuxing to MP4…");
    // First try a fast remux (no re-encoding) — works when video/audio codecs
    // are already MP4-compatible (h264/h265 + aac/ac3, etc.).
    let exitCode = await instance.exec([
      "-i", inputName,
      "-c", "copy",
      "-map", "0:v:0?",
      "-map", "0:a:0?",
      "-movflags", "+faststart",
      workOutput,
    ]);

    if (exitCode !== 0) {
      setStatus("Codec not MP4-compatible — re-encoding (this is slower)…");
      progressFill.style.width = "0%";
      exitCode = await instance.exec([
        "-i", inputName,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        workOutput,
      ]);
    }

    if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}`);

    setStatus("Finalizing…");
    const data = await instance.readFile(workOutput);
    const blob = new Blob([data.buffer], { type: "video/mp4" });
    lastDownloadUrl = URL.createObjectURL(blob);
    downloadLink.href = lastDownloadUrl;
    downloadLink.download = outputName;
    downloadLink.textContent = `Download ${outputName} (${formatBytes(blob.size)})`;

    await instance.deleteFile(inputName).catch(() => {});
    await instance.deleteFile(workOutput).catch(() => {});

    progress.classList.add("hidden");
    result.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message || err}`);
    progressFill.style.background = "var(--danger)";
  } finally {
    convertBtn.disabled = false;
    resetBtn.disabled = false;
  }
};

// Wire up drag-and-drop
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", (e) => selectFile(e.target.files?.[0]));

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
  })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  selectFile(file);
});

convertBtn.addEventListener("click", convert);
resetBtn.addEventListener("click", reset);
