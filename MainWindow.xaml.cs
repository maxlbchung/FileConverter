using System.Collections.ObjectModel;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Microsoft.Win32;

namespace FileConverter;

public partial class MainWindow : Window
{
    private readonly FFmpegManager _ffmpeg = new();

    private readonly ObservableCollection<string> _videoItems = new();
    private readonly ObservableCollection<string> _audioItems = new();
    private readonly ObservableCollection<string> _imageItems = new();

    private CancellationTokenSource? _activeCts;

    public MainWindow()
    {
        InitializeComponent();
        VideoFiles.ItemsSource = _videoItems;
        AudioFiles.ItemsSource = _audioItems;
        ImageFiles.ItemsSource = _imageItems;
        _videoItems.CollectionChanged += (_, _) => UpdateListVisibility(_videoItems, VideoFiles, VideoEmpty, VideoConvert);
        _audioItems.CollectionChanged += (_, _) => UpdateListVisibility(_audioItems, AudioFiles, AudioEmpty, AudioConvert);
        _imageItems.CollectionChanged += (_, _) => UpdateListVisibility(_imageItems, ImageFiles, ImageEmpty, ImageConvert);
        AudioFormat_Changed(AudioFormat, null!);
        ImageFormat_Changed(ImageFormat, null!);
        Loaded += async (_, _) => await EnsureFFmpegAsync();
    }

    private static void UpdateListVisibility(ObservableCollection<string> items, ListBox list,
                                              UIElement empty, Button convert)
    {
        bool has = items.Count > 0;
        list.Visibility = has ? Visibility.Visible : Visibility.Collapsed;
        empty.Visibility = has ? Visibility.Collapsed : Visibility.Visible;
        convert.IsEnabled = has;
    }

    private async Task EnsureFFmpegAsync()
    {
        if (_ffmpeg.TryLocate())
        {
            GlobalStatus.Text = $"ffmpeg: {_ffmpeg.FFmpegPath}";
            return;
        }

        var choice = MessageBox.Show(
            "FFmpeg wasn't found.\n\n" +
            "FileConverter needs ffmpeg.exe to do anything.\n\n" +
            "• Yes — download a fresh build (~80 MB) to %LOCALAPPDATA%\\FileConverter\n" +
            "• No — point me to an existing ffmpeg.exe on your machine\n" +
            "• Cancel — quit",
            "FFmpeg required",
            MessageBoxButton.YesNoCancel, MessageBoxImage.Question);

        if (choice == MessageBoxResult.Cancel)
        {
            Application.Current.Shutdown();
            return;
        }

        if (choice == MessageBoxResult.No)
        {
            var dlg = new OpenFileDialog { Filter = "ffmpeg.exe|ffmpeg.exe|Executable|*.exe" };
            if (dlg.ShowDialog() != true) { Application.Current.Shutdown(); return; }
            try { _ffmpeg.SetCustomPath(dlg.FileName); GlobalStatus.Text = $"ffmpeg: {_ffmpeg.FFmpegPath}"; }
            catch (Exception ex) { MessageBox.Show(ex.Message); Application.Current.Shutdown(); }
            return;
        }

        await DownloadFFmpegAsync();
    }

    private async Task DownloadFFmpegAsync()
    {
        var cts = new CancellationTokenSource();
        var progress = new Progress<DownloadProgress>(p =>
        {
            var mb = p.Received / 1_000_000.0;
            var total = p.Total > 0 ? $" / {p.Total / 1_000_000.0:F1} MB" : "";
            GlobalStatus.Text = p.Received < 0 ? p.Status : $"{p.Status} {mb:F1} MB{total}";
        });
        try
        {
            await _ffmpeg.DownloadAsync(progress, cts.Token);
            GlobalStatus.Text = $"ffmpeg: {_ffmpeg.FFmpegPath}";
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Download failed: {ex.Message}", "FileConverter", MessageBoxButton.OK, MessageBoxImage.Error);
            Application.Current.Shutdown();
        }
    }

    private static readonly string[] VideoExts =
        { ".mkv", ".mp4", ".webm", ".mov", ".avi", ".flv", ".m4v", ".wmv", ".mpeg", ".mpg", ".ts" };
    private static readonly string[] AudioExts =
        { ".mp3", ".wav", ".flac", ".ogg", ".m4a", ".opus", ".aac", ".wma", ".oga" };
    private static readonly string[] ImageExts =
        { ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif" };

    private void DropZone_DragEnter(object sender, DragEventArgs e)
    {
        e.Effects = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;
        if (sender is Border b) b.BorderBrush = (System.Windows.Media.Brush)FindResource("AccentBrush");
        e.Handled = true;
    }

    private void DropZone_DragLeave(object sender, DragEventArgs e)
    {
        if (sender is Border b) b.BorderBrush = (System.Windows.Media.Brush)FindResource("BorderBrush");
    }

    private void AddFiles(IEnumerable<string> paths, string[] allowedExts, ObservableCollection<string> bucket)
    {
        foreach (var p in paths)
        {
            if (string.IsNullOrEmpty(p)) continue;
            var ext = Path.GetExtension(p).ToLowerInvariant();
            if (!allowedExts.Contains(ext)) continue;
            if (!bucket.Contains(p)) bucket.Add(p);
        }
    }

    private void VideoDrop(object sender, DragEventArgs e)
    {
        DropZone_DragLeave(sender, e);
        if (e.Data.GetData(DataFormats.FileDrop) is string[] files)
            AddFiles(files, VideoExts, _videoItems);
    }
    private void AudioDrop(object sender, DragEventArgs e)
    {
        DropZone_DragLeave(sender, e);
        if (e.Data.GetData(DataFormats.FileDrop) is string[] files)
            AddFiles(files, AudioExts, _audioItems);
    }
    private void ImageDrop(object sender, DragEventArgs e)
    {
        DropZone_DragLeave(sender, e);
        if (e.Data.GetData(DataFormats.FileDrop) is string[] files)
            AddFiles(files, ImageExts, _imageItems);
    }

    private void VideoBrowse_Click(object sender, MouseButtonEventArgs e) => Browse(VideoExts, _videoItems, "Video");
    private void AudioBrowse_Click(object sender, MouseButtonEventArgs e) => Browse(AudioExts, _audioItems, "Audio");
    private void ImageBrowse_Click(object sender, MouseButtonEventArgs e) => Browse(ImageExts, _imageItems, "Image");

    private void Browse(string[] exts, ObservableCollection<string> bucket, string kind)
    {
        var filter = $"{kind} files|{string.Join(";", exts.Select(e => "*" + e))}|All files|*.*";
        var dlg = new OpenFileDialog { Multiselect = true, Filter = filter };
        if (dlg.ShowDialog() == true) AddFiles(dlg.FileNames, exts, bucket);
    }

    private void VideoClear_Click(object sender, RoutedEventArgs e) => _videoItems.Clear();
    private void AudioClear_Click(object sender, RoutedEventArgs e) => _audioItems.Clear();
    private void ImageClear_Click(object sender, RoutedEventArgs e) => _imageItems.Clear();

    private async void VideoConvert_Click(object sender, RoutedEventArgs e)
    {
        var fmt = (string)((ComboBoxItem)VideoFormat.SelectedItem).Tag;
        await ConvertBatchAsync(_videoItems, fmt, VideoProgress, VideoStatus, VideoConvert,
            isVideo: true,
            argsFor: (input, output) => BuildVideoArgs(input, output, fmt));
    }

    private async void AudioConvert_Click(object sender, RoutedEventArgs e)
    {
        var fmt = (string)((ComboBoxItem)AudioFormat.SelectedItem).Tag;
        var bitrate = (string)((ComboBoxItem)AudioBitrate.SelectedItem).Tag;
        await ConvertBatchAsync(_audioItems, fmt, AudioProgress, AudioStatus, AudioConvert,
            isVideo: false,
            argsFor: (input, output) => BuildAudioArgs(input, output, fmt, bitrate));
    }

    private async void ImageConvert_Click(object sender, RoutedEventArgs e)
    {
        var fmt = (string)((ComboBoxItem)ImageFormat.SelectedItem).Tag;
        var q = int.Parse((string)((ComboBoxItem)ImageQuality.SelectedItem).Tag);
        await ConvertBatchAsync(_imageItems, fmt, ImageProgress, ImageStatus, ImageConvert,
            isVideo: false,
            argsFor: (input, output) => BuildImageArgs(input, output, fmt, q));
    }

    private async Task ConvertBatchAsync(
        ObservableCollection<string> items, string fmt,
        ProgressBar bar, TextBlock status, Button convertBtn,
        bool isVideo,
        Func<string, string, List<string>> argsFor)
    {
        if (!_ffmpeg.IsReady) { MessageBox.Show("FFmpeg isn't ready yet."); return; }
        if (items.Count == 0) return;

        _activeCts?.Cancel();
        _activeCts = new CancellationTokenSource();
        var ct = _activeCts.Token;

        bar.Visibility = Visibility.Visible;
        bar.Value = 0;
        convertBtn.IsEnabled = false;
        status.Foreground = (System.Windows.Media.Brush)FindResource("MutedBrush");

        int done = 0, failed = 0;
        var inputs = items.ToList();
        try
        {
            for (int i = 0; i < inputs.Count; i++)
            {
                if (ct.IsCancellationRequested) break;
                var input = inputs[i];
                var output = UniqueOutputPath(input, fmt);
                status.Text = $"({i + 1}/{inputs.Count}) {Path.GetFileName(input)}";

                TimeSpan? duration = null;
                if (isVideo)
                {
                    try { duration = await _ffmpeg.ProbeDurationAsync(input, ct); } catch { }
                }

                var args = argsFor(input, output);
                var fileBaseFraction = (double)i / inputs.Count;
                var progress = new Progress<ConvertProgress>(p =>
                {
                    if (p.Fraction is double f)
                        bar.Value = fileBaseFraction + (f / inputs.Count);
                });

                int rc;
                try
                {
                    rc = await _ffmpeg.RunAsync(args, duration, progress, ct);
                }
                catch (OperationCanceledException) { rc = -1; }

                if (rc == 0 && File.Exists(output))
                {
                    done++;
                }
                else
                {
                    failed++;
                    try { File.Delete(output); } catch { }
                }
                bar.Value = (double)(done + failed) / inputs.Count;
            }

            if (ct.IsCancellationRequested)
            {
                status.Text = $"Cancelled. Done: {done}, failed: {failed}.";
            }
            else if (failed == 0)
            {
                status.Foreground = (System.Windows.Media.Brush)FindResource("SuccessBrush");
                status.Text = $"Done — {done} file{(done == 1 ? "" : "s")} converted. Saved next to original{(done == 1 ? "" : "s")}.";
            }
            else
            {
                status.Foreground = (System.Windows.Media.Brush)FindResource("DangerBrush");
                status.Text = $"Done with errors — {done} succeeded, {failed} failed.";
            }
        }
        finally
        {
            convertBtn.IsEnabled = items.Count > 0;
        }
    }

    private static string UniqueOutputPath(string input, string fmt)
    {
        var dir = Path.GetDirectoryName(input) ?? Directory.GetCurrentDirectory();
        var name = Path.GetFileNameWithoutExtension(input);
        var target = Path.Combine(dir, $"{name}.{fmt}");
        if (string.Equals(Path.GetFullPath(input), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase))
            target = Path.Combine(dir, $"{name}.converted.{fmt}");
        int n = 1;
        while (File.Exists(target))
        {
            target = Path.Combine(dir, $"{name} ({n}).{fmt}");
            n++;
        }
        return target;
    }

    private static List<string> BuildVideoArgs(string input, string output, string fmt) => fmt switch
    {
        "mp4" => new() { "-i", input, "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                          "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output },
        "mov" => new() { "-i", input, "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                          "-c:a", "aac", "-b:a", "192k", output },
        "mkv" => new() { "-i", input, "-c", "copy", output },
        "webm" => new() { "-i", input, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32",
                           "-c:a", "libopus", "-b:a", "128k", output },
        "gif" => new() { "-i", input,
                          "-vf", "fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
                          "-loop", "0", output },
        _ => throw new ArgumentException($"Unknown video format: {fmt}"),
    };

    private static List<string> BuildAudioArgs(string input, string output, string fmt, string bitrate) => fmt switch
    {
        "mp3" => new() { "-i", input, "-vn", "-c:a", "libmp3lame", "-b:a", bitrate, output },
        "wav" => new() { "-i", input, "-vn", "-c:a", "pcm_s16le", output },
        "flac" => new() { "-i", input, "-vn", "-c:a", "flac", output },
        "ogg" => new() { "-i", input, "-vn", "-c:a", "libvorbis", "-b:a", bitrate, output },
        "m4a" => new() { "-i", input, "-vn", "-c:a", "aac", "-b:a", bitrate, output },
        "opus" => new() { "-i", input, "-vn", "-c:a", "libopus", "-b:a", bitrate, output },
        _ => throw new ArgumentException($"Unknown audio format: {fmt}"),
    };

    private static List<string> BuildImageArgs(string input, string output, string fmt, int quality) => fmt switch
    {
        "png" => new() { "-i", input, output },
        "jpg" => new() { "-i", input, "-q:v", MapJpegQuality(quality).ToString(), output },
        "webp" => new() { "-i", input, "-quality", quality.ToString(), output },
        "bmp" => new() { "-i", input, output },
        "tiff" => new() { "-i", input, output },
        _ => throw new ArgumentException($"Unknown image format: {fmt}"),
    };

    // ffmpeg mjpeg quality: 2 (best) to 31 (worst). Map our 0–100 → 31–2.
    private static int MapJpegQuality(int q)
    {
        var inv = 31 - (int)Math.Round(q / 100.0 * 29);
        return Math.Clamp(inv, 2, 31);
    }

    private void AudioFormat_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (AudioFormat is null || AudioBitrate is null) return;
        var fmt = (string?)((ComboBoxItem?)AudioFormat.SelectedItem)?.Tag;
        bool lossless = fmt is "wav" or "flac";
        AudioBitrate.Visibility = lossless ? Visibility.Collapsed : Visibility.Visible;
        AudioBitrateLabel.Visibility = lossless ? Visibility.Collapsed : Visibility.Visible;
    }

    private void ImageFormat_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (ImageFormat is null || ImageQuality is null) return;
        var fmt = (string?)((ComboBoxItem?)ImageFormat.SelectedItem)?.Tag;
        bool needsQuality = fmt is "jpg" or "webp";
        ImageQuality.Visibility = needsQuality ? Visibility.Visible : Visibility.Collapsed;
        ImageQualityLabel.Visibility = needsQuality ? Visibility.Visible : Visibility.Collapsed;
    }
}
