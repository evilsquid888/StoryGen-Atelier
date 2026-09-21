const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('../src/services/grokCliService');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-cli-test-'));
// Point GROK_CLI_BIN at a file that exists so resolveBinary succeeds without a real install.
const env = { GROK_CLI_BIN: process.execPath, GROK_CLI_WORKDIR: workDir };
const ok = (obj) => ({ code: 0, stdout: JSON.stringify(obj), stderr: '' });

test('detects the binary from GROK_CLI_BIN or PATH', () => {
  assert.equal(cli.isAvailable(env), true);
  assert.equal(cli.isAvailable({ GROK_CLI_BIN: '/definitely/not/here/grok' }), false);
  assert.equal(cli.isAvailable({ GROK_CLI_BIN: 'grok', PATH: '/nonexistent-dir' }), false);
});

test('generateText sends ACP content blocks and returns the text field', async () => {
  let call;
  const text = await cli.generateText(
    [{ text: 'Return JSON.' }, { inlineData: { mimeType: 'image/png', data: 'aW1n' } }],
    { env, execImpl: async (bin, args) => { call = { bin, args }; return ok({ text: ' [] ', stopReason: 'end_turn' }); } }
  );
  assert.equal(text, '[]');
  assert.equal(call.bin, process.execPath);
  const i = call.args.indexOf('--prompt-json');
  assert.deepEqual(JSON.parse(call.args[i + 1]), [
    { type: 'text', text: 'Return JSON.' },
    { type: 'image', data: 'aW1n', mimeType: 'image/png' },
  ]);
  assert.ok(call.args.includes('--output-format') && call.args.includes('json'));
  assert.ok(call.args.includes('--no-auto-update'));
  assert.equal(call.args[call.args.indexOf('--cwd') + 1], workDir);
});

test('surfaces CLI error events and non-zero exits', async () => {
  await assert.rejects(
    cli.generateText([{ text: 'x' }], { env, execImpl: async () => ({ code: 1, stdout: '{"type":"error","message":"Not signed in"}', stderr: '' }) }),
    /Not signed in/
  );
  await assert.rejects(
    cli.generateText([{ text: 'x' }], { env, execImpl: async () => ({ code: 1, stdout: '', stderr: 'boom' }) }),
    /exited with code 1: boom/
  );
  await assert.rejects(
    cli.generateText([{ text: 'x' }], { env: { GROK_CLI_BIN: '/nope/grok' }, execImpl: async () => ok({}) }),
    /not found/
  );
});

test('generateImage uses image_gen, then image_edit with a reference, and reads the file back', async () => {
  const out = path.join(workDir, 'images', '1.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from('iVBORw0KGgo=', 'base64'));

  let call;
  const uri = await cli.generateImage({ prompt: 'a fox on a hill' }, {
    env, execImpl: async (_b, args) => { call = args; return ok({ structuredOutput: { path: out }, text: '' }); },
  });
  assert.equal(uri, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(call[call.indexOf('--tools') + 1], 'image_gen');
  assert.ok(call.includes('--always-approve') && !call.includes('--json-schema'));
  assert.match(call[call.indexOf('-p') + 1], /a fox on a hill/);
  assert.match(call[call.indexOf('-p') + 1], /aspect_ratio="16:9"/);

  const uri2 = await cli.generateImage({ prompt: 'the fox jumps', referenceImage: 'data:image/png;base64,iVBORw0KGgo=' }, {
    env, execImpl: async (_b, args) => { call = args; return ok({ text: `{"path":"${out}"}` }); },
  });
  assert.equal(uri2, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(call[call.indexOf('--tools') + 1], 'image_gen,image_edit');
  const instruction = call[call.indexOf('-p') + 1];
  const refMatch = /image="([^"]+)"/.exec(instruction);
  assert.ok(refMatch && fs.existsSync(refMatch[1]), 'reference frame written to disk');
});

test('generateVideo pins first/last frames or animates a single image', async () => {
  const out = path.join(workDir, 'videos', '1.mp4');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'mp4');
  const frame = { bytesBase64Encoded: 'iVBORw0KGgo=', mimeType: 'image/png' };

  let call;
  const file = await cli.generateVideo({ prompt: 'dolly in', firstFrame: frame, lastFrame: frame, durationSeconds: 6 }, {
    env: { ...env, GROK_CLI_VIDEO_RESOLUTION: '1080p' },
    execImpl: async (_b, args) => { call = args; return ok({ text: `Saved to ${out}` }); },
  });
  assert.equal(file, out);
  assert.equal(call[call.indexOf('--tools') + 1], 'reference_to_video');
  const instr = call[call.indexOf('-p') + 1];
  assert.match(instr, /first_frame="[^"]+"/);
  assert.match(instr, /last_frame="[^"]+"/);
  assert.match(instr, /duration=6/);
  assert.match(instr, /resolution_name="1080p"/);

  await cli.generateVideo({ prompt: 'hold', firstFrame: frame, durationSeconds: 40 }, {
    env, execImpl: async (_b, args) => { call = args; return ok({ structuredOutput: { path: out } }); },
  });
  assert.equal(call[call.indexOf('--tools') + 1], 'image_to_video');
  assert.match(call[call.indexOf('-p') + 1], /duration=15/);

  let attempts = 0;
  await assert.rejects(
    cli.generateVideo({ prompt: 'x', firstFrame: frame, durationSeconds: 4 }, { env, execImpl: async () => { attempts += 1; return ok({ text: 'done, no file' }); } }),
    /did not report a saved file/
  );
  assert.equal(attempts, 2, 'retries once when the agent skipped the tool');
});

test('resolves session-relative or misreported paths against the Grok session folder', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
  const sessionId = '01a0c494-199f-72c3-80f6-c9d577191d08';
  const session = path.join(home, 'sessions', encodeURIComponent(workDir), sessionId);
  fs.mkdirSync(path.join(session, 'images'), { recursive: true });
  fs.mkdirSync(path.join(session, 'videos'), { recursive: true });
  const img = path.join(session, 'images', '1.jpg');
  fs.writeFileSync(img, Buffer.from('/9j/', 'base64'));
  const vid = path.join(session, 'videos', '1.mp4');
  fs.writeFileSync(vid, 'mp4');
  const envHome = { ...env, GROK_CLI_HOME: home };

  // Model guessed a cwd-relative path that does not exist.
  const uri = await cli.generateImage({ prompt: 'x' }, {
    env: envHome,
    execImpl: async () => ok({ sessionId, text: `{"path": "${path.join(workDir, 'images', '1.jpg')}"}` }),
  });
  assert.equal(uri, `data:image/jpeg;base64,${fs.readFileSync(img).toString('base64')}`);

  // Model reported only the short session-relative form.
  const uri2 = await cli.generateImage({ prompt: 'x' }, {
    env: envHome, execImpl: async () => ok({ sessionId, text: 'Saved to images/1.jpg' }),
  });
  assert.equal(uri2, uri);

  // Model reported nothing usable: fall back to the newest video in the session.
  const frame = { bytesBase64Encoded: 'iVBORw0KGgo=', mimeType: 'image/png' };
  const file = await cli.generateVideo({ prompt: 'x', firstFrame: frame, durationSeconds: 4 }, {
    env: envHome, execImpl: async () => ok({ sessionId, text: 'Done.' }),
  });
  assert.equal(file, vid);
});
