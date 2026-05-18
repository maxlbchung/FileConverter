using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Text.RegularExpressions;

namespace FileConverter;

public sealed class FFmpegManager
{
    private const string GyanZipUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

    public static string AppDataDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FileConverter");

    public static string BundledFFmpegPath => Path.Combine(AppDataDir, "ffmpeg.exe");
    public static string BundledFFprobePath => Path.Combine(AppDataDir, "ffprobe.exe");

    public string? FFmpegPath { get; private set; }
    public string? FFprobePath { get; private set; }

    public bool IsReady => !string.IsNullOrEmpty(FFmpegPath) && File.Exists(FFmpegPath);

    public bool TryLocate()
    {
        // 1. App-local bundled copy
        if (File.Exists(BundledFFmpegPath))
        {
            FFmpegPath = BundledFFmpegPath;
            FFprobePath = File.Exists(BundledFFprobePath) ? BundledFFprobePath : null;
            return true;
        }
        // 2. Same dir as the app
        var appDir = AppContext.BaseDirectory;
        var local = Path.Combine(appDir, "ffmpeg.exe");
        if (File.Exists(local))
        {
            FFmpegPath = local;
            var probe = Path.Combine(appDir, "ffprobe.exe");
            FFprobePath = File.Exists(probe) ? probe : null;
            return true;
        }
        // 3. PATH
        var pathDirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator);
        foreach (var d in pathDirs)
        {
            if (string.IsNullOrWhiteSpace(d)) continue;
            try
            {
                var candidate = Path.Combine(d, "ffmpeg.exe");
                if (File.Exists(candidate))
                {
                    FFmpegPath = candidate;
                    var probe = Path.Combine(d, "ffprobe.exe");
                    FFprobePath = File.Exists(probe) ? probe : null;
                    return true;
                }
            }
            catch { /* skip unreadable PATH entries */ }
        }
        return false;
    }

    public void SetCustomPath(string ffmpegExe)
    {
        if (!File.Exists(ffmpegExe)) throw new FileNotFoundException(ffmpegExe);
        FFmpegPath = ffmpegExe;
        var dir = Path.GetDirectoryName(ffmpegExe);
        if (dir is not null)
        {
            var probe = Path.Combine(dir, "ffprobe.exe");
            FFprobePath = File.Exists(probe) ? probe : null;
        }
    }

    public async Task DownloadAsync(IProgress<DownloadProgress> progress, CancellationToken ct)
    {
        Directory.CreateDirectory(AppDataDir);
        var zipPath = Path.Combine(AppDataDir, "ffmpeg-download.zip");

        using (var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) })
        {
            http.DefaultRequestHeaders.UserAgent.ParseAdd("FileConverter/1.0");
            using var resp = await http.GetAsync(GyanZipUrl, HttpCompletionOption.ResponseHeadersRead, ct);
            resp.EnsureSuccessStatusCode();
            var total = resp.Content.Headers.ContentLength ?? -1;

            await using var src = await resp.Content.ReadAsStreamAsync(ct);
            await using var dst = File.Create(zipPath);
            var buffer = new byte[81920];
            long received = 0;
            int read;
            var lastReport = DateTime.UtcNow;
            while ((read = await src.ReadAsync(buffer, ct)) > 0)
            {
                await dst.WriteAsync(buffer.AsMemory(0, read), ct);
                received += read;
                if ((DateTime.UtcNow - lastReport).TotalMilliseconds > 100)
                {
                    progress.Report(new DownloadProgress(received, total, "Downloading FFmpeg…"));
                    lastReport = DateTime.UtcNow;
                }
            }
            progress.Report(new DownloadProgress(received, total, "Downloading FFmpeg…"));
        }

        progress.Report(new DownloadProgress(-1, -1, "Extracting…"));
        await Task.Run(() =>
        {
            using var zip = ZipFile.OpenRead(zipPath);
            foreach (var entry in zip.Entries)
            {
                if (entry.Name.Equals("ffmpeg.exe", StringComparison.OrdinalIgnoreCase))
                    entry.ExtractToFile(BundledFFmpegPath, overwrite: true);
                else if (entry.Name.Equals("ffprobe.exe", StringComparison.OrdinalIgnoreCase))
                    entry.ExtractToFile(BundledFFprobePath, overwrite: true);
            }
        }, ct);

        try { File.Delete(zipPath); } catch { }

        if (!File.Exists(BundledFFmpegPath))
            throw new InvalidOperationException("Download finished but ffmpeg.exe wasn't found in the archive.");

        FFmpegPath = BundledFFmpegPath;
        FFprobePath = File.Exists(BundledFFprobePath) ? BundledFFprobePath : null;
    }

    public async Task<TimeSpan?> ProbeDurationAsync(string inputPath, CancellationToken ct)
    {
        // Prefer ffprobe if we have it; otherwise scrape from ffmpeg -i.
        if (FFprobePath is not null)
        {
            var psi = new ProcessStartInfo(FFprobePath,
                $"-v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 \"{inputPath}\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var p = Process.Start(psi)!;
            var stdout = await p.StandardOutput.ReadToEndAsync(ct);
            await p.WaitForExitAsync(ct);
            if (double.TryParse(stdout.Trim(), System.Globalization.NumberStyles.Float,
                                System.Globalization.CultureInfo.InvariantCulture, out var seconds))
                return TimeSpan.FromSeconds(seconds);
        }
        if (FFmpegPath is null) return null;
        var psi2 = new ProcessStartInfo(FFmpegPath, $"-i \"{inputPath}\"")
        {
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        using var p2 = Process.Start(psi2)!;
        var stderr = await p2.StandardError.ReadToEndAsync(ct);
        await p2.WaitForExitAsync(ct);
        var m = Regex.Match(stderr, @"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)");
        if (m.Success)
        {
            return new TimeSpan(0,
                int.Parse(m.Groups[1].Value),
                int.Parse(m.Groups[2].Value),
                0) + TimeSpan.FromSeconds(double.Parse(m.Groups[3].Value, System.Globalization.CultureInfo.InvariantCulture));
        }
        return null;
    }

    public async Task<int> RunAsync(IEnumerable<string> args, TimeSpan? totalDuration,
                                     IProgress<ConvertProgress> progress,
                                     CancellationToken ct)
    {
        if (FFmpegPath is null) throw new InvalidOperationException("FFmpeg not located.");

        var psi = new ProcessStartInfo(FFmpegPath)
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.ArgumentList.Insert(0, "-y");
        psi.ArgumentList.Insert(0, "-hide_banner");

        using var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
        var stderrBuf = new System.Text.StringBuilder();
        var timeRegex = new Regex(@"time=(\d+):(\d+):(\d+(?:\.\d+)?)", RegexOptions.Compiled);

        proc.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            stderrBuf.AppendLine(e.Data);
            var m = timeRegex.Match(e.Data);
            if (m.Success && totalDuration is { } total && total.TotalSeconds > 0)
            {
                var current = new TimeSpan(0,
                    int.Parse(m.Groups[1].Value),
                    int.Parse(m.Groups[2].Value), 0)
                    + TimeSpan.FromSeconds(double.Parse(m.Groups[3].Value, System.Globalization.CultureInfo.InvariantCulture));
                var pct = Math.Clamp(current.TotalSeconds / total.TotalSeconds, 0, 1);
                progress.Report(new ConvertProgress(pct, e.Data));
            }
            else
            {
                progress.Report(new ConvertProgress(null, e.Data));
            }
        };

        proc.Start();
        proc.BeginErrorReadLine();
        // Drain stdout so the process doesn't block on a full pipe.
        _ = Task.Run(() => proc.StandardOutput.ReadToEnd(), ct);

        using (ct.Register(() =>
        {
            try { if (!proc.HasExited) proc.Kill(entireProcessTree: true); } catch { }
        }))
        {
            await proc.WaitForExitAsync(ct);
        }
        return proc.ExitCode;
    }
}

public readonly record struct DownloadProgress(long Received, long Total, string Status);
public readonly record struct ConvertProgress(double? Fraction, string LastLine);
