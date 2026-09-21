// Grok Build CLI provider. Drives the locally installed `grok` binary in
// headless mode so text, image, and video generation run through the user's
// Grok Build session (SuperGrok / X Premium+) instead of a raw API key.
//
//   text  : `grok --prompt-json <ACP blocks> --output-format json`
//   image : `grok -p "<instruction>" --tools image_gen,image_edit --json-schema {path}`
//   video : `grok -p "<instruction>" --tools image_to_video,reference_to_video --json-schema {path}`
//
// Every call is a fresh headless session with --always-approve, a tool
// allowlist, and a bounded --max-turns, so the agent can only do the one
// Imagine call we ask for. Generated files land in a per-app work dir that
// the caller reads back.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { log } = require('../utils/logger');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_WORKDIR = path.join(__dirname, '../../data/grok-cli');
const PATH_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { path: { type: 'string', description: 'Absolute path of the saved file' } },
  required: ['path'],
});

const clean = (value) => (value || '').trim();

const getConfig = (env = process.env) => ({
  binary: clean(env.GROK_CLI_BIN) || 'grok',
  model: clean(env.GROK_CLI_MODEL),
  workDir: clean(env.GROK_CLI_WORKDIR) || DEFAULT_WORKDIR,
  timeoutMs: Number.parseInt(env.GROK_CLI_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS,
  imageAspectRatio: clean(env.GROK_CLI_IMAGE_ASPECT_RATIO) || '16:9',
  videoResolution: clean(env.GROK_CLI_VIDEO_RESOLUTION) || '720p',
  videoAspectRatio: clean(env.GROK_CLI_VIDEO_ASPECT_RATIO) || '16:9',
});

// Resolve the binary: an explicit GROK_CLI_BIN path, or `grok` on PATH.
const resolveBinary = (env = process.env) => {
  const { binary } = getConfig(env);
  if (binary.includes(path.sep)) return fs.existsSync(binary) ? binary : null;
  const searchPath = env.PATH || process.env.PATH || '';
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

const isAvailable = (env = process.env) => resolveBinary(env) !== null;

const defaultExec = (bin, args, options) => new Promise((resolve) => {
  execFile(bin, args, options, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error });
  });
});

const parseHeadlessOutput = (stdout) => {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    // The CLI may print an error event before the final object; use the last JSON line.
    const lines = trimmed.split('\n').filter((l) => l.trim().startsWith('{'));
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]); } catch (_e) { /* keep looking */ }
    }
    return null;
  }
};

// Run one headless grok invocation and return the parsed JSON result object.
const runGrok = async (args, options = {}) => {
  const env = options.env || process.env;
  const execImpl = options.execImpl || defaultExec;
  const cfg = getConfig(env);
  const bin = resolveBinary(env);
  if (!bin) throw new Error(`Grok Build CLI not found (looked for "${cfg.binary}"). Install it: curl -fsSL https://x.ai/cli/install.sh | bash`);

  fs.mkdirSync(cfg.workDir, { recursive: true });
  const fullArgs = [...args, '--output-format', 'json', '--no-auto-update', '--cwd', cfg.workDir];
  if (cfg.model) fullArgs.push('--model', cfg.model);

  log('grok_cli_exec', { bin, args: fullArgs.filter((a) => a.length < 120) });
  const { code, stdout, stderr } = await execImpl(bin, fullArgs, {
    cwd: cfg.workDir,
    env: { ...process.env, ...env },
    timeout: cfg.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });

  const parsed = parseHeadlessOutput(stdout);
  if (parsed && parsed.type === 'error') {
    throw new Error(`Grok CLI error: ${parsed.message || 'unknown error'}`);
  }
  if (code !== 0) {
    const detail = (stderr || stdout || '').trim().split('\n').slice(-3).join(' ');
    throw new Error(`Grok CLI exited with code ${code}: ${detail}`);
  }
  if (!parsed) throw new Error('Grok CLI returned no JSON output');
  return parsed;
};

// ---------- text ----------

const toAcpBlocks = (promptParts) => promptParts.map((part) => {
  if (typeof part?.text === 'string') return { type: 'text', text: part.text };
  if (part?.inlineData?.data) {
    return { type: 'image', data: part.inlineData.data, mimeType: part.inlineData.mimeType || 'image/jpeg' };
  }
  throw new Error('Unsupported Grok CLI prompt part');
});

const generateText = async (promptParts, options = {}) => {
  const result = await runGrok([
    '--prompt-json', JSON.stringify(toAcpBlocks(promptParts)),
    '--tools', 'read_file',
    '--no-plan', '--no-subagents', '--max-turns', '1',
  ], options);
  const text = typeof result.text === 'string' ? result.text.trim() : '';
  if (!text) throw new Error('Grok CLI text response was empty');
  return text;
};

// ---------- shared file helpers ----------

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

// Persist a base64 frame so the CLI tools can reference it by absolute path.
const writeFrameFile = (workDir, label, { bytesBase64Encoded, mimeType }) => {
  const dir = path.join(workDir, 'inputs');
  fs.mkdirSync(dir, { recursive: true });
  const ext = EXT_BY_MIME[(mimeType || '').split(';')[0]] || '.png';
  const file = path.join(dir, `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(file, Buffer.from(bytesBase64Encoded, 'base64'));
  return file;
};

const dataUriToFrame = (dataUri) => {
  const match = /^data:(.+?);base64,(.+)$/.exec(dataUri || '');
  if (!match) return null;
  return { mimeType: match[1], bytesBase64Encoded: match[2] };
};

const extractPath = (result, extensions) => {
  const structured = result.structuredOutput || result.structured_output;
  const candidates = [];
  if (structured && typeof structured.path === 'string') candidates.push(structured.path);
  const text = typeof result.text === 'string' ? result.text : '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.path === 'string') candidates.push(parsed.path);
  } catch (_) { /* not JSON */ }
  const re = new RegExp(`(/[^\\s"'\`]+\\.(?:${extensions.join('|')}))`, 'i');
  const m = re.exec(text);
  if (m) candidates.push(m[1]);
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error(`Grok CLI did not report a saved file. Response: ${text.slice(0, 200)}`);
  return found;
};

const fileToDataUri = (file) => {
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] || 'image/png';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
};

// ---------- image ----------

const buildImageInstruction = ({ prompt, referencePath, aspectRatio }) => {
  const tool = referencePath
    ? `Call the image_edit tool exactly once with image="${referencePath}" and aspect_ratio="${aspectRatio}". The reference image shows the main character; render a NEW frame where this SAME character (identical appearance, clothing, colors) performs the action in the prompt.`
    : `Call the image_gen tool exactly once with aspect_ratio="${aspectRatio}".`;
  return [
    'You are a rendering worker. Do not ask questions, do not plan, do not write files yourself.',
    tool,
    'Use this prompt verbatim:',
    '<<<PROMPT',
    prompt,
    'PROMPT>>>',
    'When the tool returns, respond with ONLY a JSON object {"path": "<absolute path of the saved image>"}.',
  ].join('\n');
};

// Returns a data URI of the generated frame.
const generateImage = async ({ prompt, referenceImage = null }, options = {}) => {
  const env = options.env || process.env;
  const cfg = getConfig(env);
  fs.mkdirSync(cfg.workDir, { recursive: true });

  let referencePath = null;
  if (referenceImage) {
    const frame = referenceImage.startsWith('data:')
      ? dataUriToFrame(referenceImage)
      : { mimeType: 'image/png', bytesBase64Encoded: referenceImage };
    referencePath = writeFrameFile(cfg.workDir, 'ref', frame);
  }

  const result = await runGrok([
    '-p', buildImageInstruction({ prompt, referencePath, aspectRatio: cfg.imageAspectRatio }),
    '--tools', referencePath ? 'image_gen,image_edit' : 'image_gen',
    '--json-schema', PATH_SCHEMA,
    '--always-approve', '--no-plan', '--no-subagents', '--max-turns', '4',
  ], options);

  const file = extractPath(result, ['png', 'jpg', 'jpeg', 'webp']);
  return fileToDataUri(file);
};

// ---------- video ----------

const buildVideoInstruction = ({ prompt, firstPath, lastPath, duration, aspectRatio, resolution }) => {
  const call = lastPath
    ? `Call the reference_to_video tool exactly once with first_frame="${firstPath}", last_frame="${lastPath}", duration=${duration}, aspect_ratio="${aspectRatio}", resolution_name="${resolution}". The clip must start exactly on the first frame and end exactly on the last frame.`
    : `Call the image_to_video tool exactly once with image="${firstPath}", duration=${duration}, aspect_ratio="${aspectRatio}", resolution_name="${resolution}".`;
  return [
    'You are a rendering worker. Do not ask questions, do not plan, do not generate new images.',
    call,
    'Use this prompt verbatim:',
    '<<<PROMPT',
    prompt,
    'PROMPT>>>',
    'When the tool returns, respond with ONLY a JSON object {"path": "<absolute path of the saved video>"}.',
  ].join('\n');
};

// Returns the absolute path of the generated .mp4 (inside the CLI work dir).
const generateVideo = async ({ prompt, firstFrame, lastFrame = null, durationSeconds }, options = {}) => {
  const env = options.env || process.env;
  const cfg = getConfig(env);
  if (!firstFrame) throw new Error('A first frame is required for Grok CLI video generation');
  fs.mkdirSync(cfg.workDir, { recursive: true });

  const firstPath = writeFrameFile(cfg.workDir, 'first', firstFrame);
  const lastPath = lastFrame ? writeFrameFile(cfg.workDir, 'last', lastFrame) : null;
  const parsed = Number.parseInt(durationSeconds, 10);
  const duration = Number.isInteger(parsed) ? Math.min(15, Math.max(1, parsed)) : 6;

  const result = await runGrok([
    '-p', buildVideoInstruction({
      prompt, firstPath, lastPath, duration,
      aspectRatio: cfg.videoAspectRatio, resolution: cfg.videoResolution,
    }),
    '--tools', lastPath ? 'reference_to_video' : 'image_to_video',
    '--json-schema', PATH_SCHEMA,
    '--always-approve', '--no-plan', '--no-subagents', '--max-turns', '4',
  ], options);

  return extractPath(result, ['mp4', 'mov', 'webm']);
};

module.exports = {
  getConfig,
  resolveBinary,
  isAvailable,
  runGrok,
  toAcpBlocks,
  generateText,
  generateImage,
  generateVideo,
  buildImageInstruction,
  buildVideoInstruction,
  _internal: { parseHeadlessOutput, extractPath, tmpdir: os.tmpdir },
};
