const { execFile } = require('child_process');
const fs = require('fs');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

let cachedPath = null;

/**
 * Resolve the FFmpeg binary to use, in order of preference:
 * 1. FFMPEG_PATH environment variable
 * 2. Bundled binary from the optional ffmpeg-static package
 * 3. `ffmpeg` on the system PATH
 */
function getFFmpegPath() {
  if (cachedPath) {
    return cachedPath;
  }

  if (process.env.FFMPEG_PATH) {
    cachedPath = process.env.FFMPEG_PATH;
    return cachedPath;
  }

  try {
    cachedPath = require('ffmpeg-static');
  } catch (error) {
    cachedPath = null;
  }

  cachedPath = cachedPath || 'ffmpeg';
  return cachedPath;
}

async function checkFFmpeg() {
  try {
    await execFileAsync(getFFmpegPath(), ['-version']);
    return true;
  } catch (error) {
    return false;
  }
}

async function runFFmpeg(args) {
  return execFileAsync(getFFmpegPath(), args, { maxBuffer: 32 * 1024 * 1024 });
}

function getFFprobePath() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  const ffmpegPath = getFFmpegPath();
  if (ffmpegPath !== 'ffmpeg') {
    const candidate = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    if (candidate !== ffmpegPath && fs.existsSync(candidate)) return candidate;
  }
  return 'ffprobe';
}

async function getMediaDuration(filePath) {
  try {
    const { stdout } = await execFileAsync(getFFprobePath(), [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath
    ]);
    const duration = Number(String(stdout || '').trim());
    if (Number.isFinite(duration) && duration > 0) return duration;
  } catch (_error) {
    // The bundled ffmpeg-static package does not include ffprobe; use FFmpeg's metadata output below.
  }

  try {
    await runFFmpeg(['-i', filePath]);
  } catch (error) {
    const match = String(error.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    if (match) {
      const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      if (Number.isFinite(duration) && duration > 0) return duration;
    }
  }
  throw new Error(`Could not determine media duration for ${filePath}`);
}

function ffmpegInstallHint() {
  const hints = {
    win32: 'winget install Gyan.FFmpeg (then restart your terminal)',
    darwin: 'brew install ffmpeg',
    linux: 'sudo apt install ffmpeg (or your distro equivalent)'
  };

  const platformHint = hints[process.platform] || 'https://ffmpeg.org/download.html';
  return `FFmpeg not found. Install it with: ${platformHint} — or run "npm install" again to fetch the bundled ffmpeg-static binary, or set FFMPEG_PATH to your ffmpeg executable.`;
}

async function inspectMediaFile(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, error: 'File path is missing or invalid' };
  }
  let stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch (_err) {
    return { valid: false, error: `File does not exist on disk: ${filePath}` };
  }

  if (!stats || stats.size === 0) {
    return { valid: false, error: `File is 0 bytes: ${filePath}` };
  }

  let duration = null;
  let hasVideo = false;
  let hasAudio = false;
  let width = 0;
  let height = 0;

  try {
    const { stdout } = await execFileAsync(getFFprobePath(), [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,width,height:format=duration',
      '-of', 'json',
      filePath
    ]);
    const info = JSON.parse(stdout || '{}');
    duration = Number(info.format?.duration) || null;
    if (Array.isArray(info.streams)) {
      for (const s of info.streams) {
        if (s.codec_type === 'video') {
          hasVideo = true;
          width = Number(s.width) || width;
          height = Number(s.height) || height;
        }
        if (s.codec_type === 'audio') {
          hasAudio = true;
        }
      }
    }
  } catch (_err) {
    try {
      await runFFmpeg(['-i', filePath]);
    } catch (ffmpegErr) {
      const stderr = String(ffmpegErr.stderr || '');
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
      if (durationMatch) {
        duration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
      }
      if (/Video:/i.test(stderr)) hasVideo = true;
      if (/Audio:/i.test(stderr)) hasAudio = true;
      const resMatch = stderr.match(/(\d{3,4})x(\d{3,4})/);
      if (resMatch) {
        width = Number(resMatch[1]);
        height = Number(resMatch[2]);
      }
    }
  }

  const valid = Boolean(stats.size > 500 * 1024 && (hasVideo || duration > 0));
  return {
    valid,
    sizeBytes: stats.size,
    sizeMb: (stats.size / (1024 * 1024)).toFixed(2),
    duration: duration ? Math.round(duration) : null,
    hasVideo,
    hasAudio,
    width,
    height,
    error: valid ? null : `Invalid media container (size: ${stats.size} bytes, video: ${hasVideo}, audio: ${hasAudio})`
  };
}

module.exports = { getFFmpegPath, getFFprobePath, getMediaDuration, inspectMediaFile, checkFFmpeg, runFFmpeg, ffmpegInstallHint };
