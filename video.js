import { loadFFmpeg, fetchFile } from "./ffmpeg-loader.js";

const $ = (id) => document.getElementById(id);
const dropzone = $("dropzone");
const fileInput = $("file-input");
const fileInfo = $("file-info");
const fileName = $("file-name");
const fileSize = $("file-size");
const outputFormat = $("output-format");
const convertBtn = $("convert-btn");
const resetBtn = $("reset-btn");
const progress = $("progress");
const progressFill = $("progress-fill");
const progressText = $("progress-text");
const result = $("result");
const downloadLink = $("download-link");
const logSection = $("log");
const logOutput = $("log-output");

let currentFile = null;
let lastDownloadUrl = null;

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let i = -1;
  do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
  return `${bytes.toFixed(2)} ${units[i]}`;
};

const setStatus = (msg, isError = false) => {
  progressText.textContent = msg;
  progressText.classList.toggle("error-status", isError);
};

const appendLog = (line) => {
  logSection.classList.remove("hidden");
  logOutput.textContent += line + "\n";
  logOutput.scrollTop = logOutput.scrollHeight;
};

const onProgress = ({ progress: p }) => {
  const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
  progressFill.style.width = `${pct}%`;
  setStatus(`Converting… ${pct}%`);
};

const selectFile = (file) => {
  if (!file) return;
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

const buildArgs = (inputName, outputName, format, attempt) => {
  // attempt 1 = fast remux when possible; attempt 2 = full re-encode
  const fast = attempt === 1;
  switch (format) {
    case "mp4":
      return fast
        ? ["-i", inputName, "-c", "copy", "-map", "0:v:0?", "-map", "0:a:0?",
           "-movflags", "+faststart", outputName]
        : ["-i", inputName, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputName];
    case "mov":
      return fast
        ? ["-i", inputName, "-c", "copy", "-map", "0:v:0?", "-map", "0:a:0?", outputName]
        : ["-i", inputName, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
           "-c:a", "aac", "-b:a", "192k", outputName];
    case "mkv":
      return fast
        ? ["-i", inputName, "-c", "copy", outputName]
        : ["-i", inputName, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
           "-c:a", "aac", "-b:a", "192k", outputName];
    case "webm":
      // VP9 + Opus is slow in wasm; use VP8 + libvorbis fallback if needed.
      return fast
        ? ["-i", inputName, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32",
           "-c:a", "libopus", "-b:a", "128k", outputName]
        : ["-i", inputName, "-c:v", "libvpx", "-b:v", "1M",
           "-c:a", "libvorbis", outputName];
    case "gif":
      // Single attempt; palettegen for quality.
      return ["-i", inputName,
              "-vf", "fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
              "-loop", "0", outputName];
    default:
      throw new Error(`Unknown format: ${format}`);
  }
};

const convert = async () => {
  if (!currentFile) return;
  const format = outputFormat.value;
  convertBtn.disabled = true;
  resetBtn.disabled = true;
  outputFormat.disabled = true;
  progress.classList.remove("hidden");
  result.classList.add("hidden");
  progressFill.style.width = "0%";
  progressFill.style.background = "var(--accent)";
  logOutput.textContent = "";

  try {
    const ffmpeg = await loadFFmpeg({
      onLog: appendLog,
      onProgress,
      onStatus: setStatus,
    });

    const extMatch = currentFile.name.match(/\.([^.]+)$/);
    const inputExt = extMatch ? extMatch[1].toLowerCase() : "bin";
    const inputName = `input.${inputExt}`;
    const outputName = currentFile.name.replace(/\.[^.]+$/, "") + `.${format}`;
    const workOutput = `output.${format}`;

    setStatus("Reading file…");
    await ffmpeg.writeFile(inputName, await fetchFile(currentFile));

    // Try fast path (remux for mp4/mov/mkv, default encoders for webm/gif).
    setStatus(format === "gif" ? "Encoding GIF…" : "Converting…");
    let exitCode = await ffmpeg.exec(buildArgs(inputName, workOutput, format, 1));

    // Fallback to full re-encode if remux failed and format supports it.
    if (exitCode !== 0 && format !== "gif" && format !== "webm") {
      setStatus("Codec not directly compatible — re-encoding (slower)…");
      progressFill.style.width = "0%";
      exitCode = await ffmpeg.exec(buildArgs(inputName, workOutput, format, 2));
    } else if (exitCode !== 0 && format === "webm") {
      setStatus("VP9 failed — trying VP8…");
      progressFill.style.width = "0%";
      exitCode = await ffmpeg.exec(buildArgs(inputName, workOutput, format, 2));
    }

    if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}`);

    setStatus("Finalizing…");
    const data = await ffmpeg.readFile(workOutput);
    const mime = {
      mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
      webm: "video/webm", gif: "image/gif",
    }[format];
    const blob = new Blob([data.buffer], { type: mime });
    lastDownloadUrl = URL.createObjectURL(blob);
    downloadLink.href = lastDownloadUrl;
    downloadLink.download = outputName;
    downloadLink.textContent = `Download ${outputName} (${formatBytes(blob.size)})`;

    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(workOutput).catch(() => {});

    progress.classList.add("hidden");
    result.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message || err}`, true);
    progressFill.style.background = "var(--danger)";
  } finally {
    convertBtn.disabled = false;
    resetBtn.disabled = false;
    outputFormat.disabled = false;
  }
};

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
  selectFile(e.dataTransfer?.files?.[0]);
});

convertBtn.addEventListener("click", convert);
resetBtn.addEventListener("click", reset);
