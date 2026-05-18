import { loadFFmpeg, fetchFile } from "./ffmpeg-loader.js";

const $ = (id) => document.getElementById(id);
const dropzone = $("dropzone");
const fileInput = $("file-input");
const fileInfo = $("file-info");
const fileName = $("file-name");
const fileSize = $("file-size");
const outputFormat = $("output-format");
const bitrateSelect = $("bitrate");
const bitrateRow = $("bitrate-row");
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

const LOSSLESS = new Set(["wav", "flac"]);

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

const updateBitrateVisibility = () => {
  bitrateRow.classList.toggle("hidden", LOSSLESS.has(outputFormat.value));
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

const buildArgs = (inputName, outputName, format, bitrate) => {
  // -vn drops any video stream (album art, etc.) so the audio container is clean.
  const base = ["-i", inputName, "-vn"];
  switch (format) {
    case "mp3":
      return [...base, "-c:a", "libmp3lame", "-b:a", bitrate, outputName];
    case "wav":
      return [...base, "-c:a", "pcm_s16le", outputName];
    case "flac":
      return [...base, "-c:a", "flac", outputName];
    case "ogg":
      return [...base, "-c:a", "libvorbis", "-b:a", bitrate, outputName];
    case "m4a":
      return [...base, "-c:a", "aac", "-b:a", bitrate, outputName];
    case "opus":
      return [...base, "-c:a", "libopus", "-b:a", bitrate, outputName];
    default:
      throw new Error(`Unknown format: ${format}`);
  }
};

const convert = async () => {
  if (!currentFile) return;
  const format = outputFormat.value;
  const bitrate = bitrateSelect.value;
  convertBtn.disabled = true;
  resetBtn.disabled = true;
  outputFormat.disabled = true;
  bitrateSelect.disabled = true;
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

    setStatus("Converting…");
    const exitCode = await ffmpeg.exec(buildArgs(inputName, workOutput, format, bitrate));
    if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}`);

    setStatus("Finalizing…");
    const data = await ffmpeg.readFile(workOutput);
    const mime = {
      mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac",
      ogg: "audio/ogg", m4a: "audio/mp4", opus: "audio/opus",
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
    bitrateSelect.disabled = false;
  }
};

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", (e) => selectFile(e.target.files?.[0]));
outputFormat.addEventListener("change", updateBitrateVisibility);

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
updateBitrateVisibility();
