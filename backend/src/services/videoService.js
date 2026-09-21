// StoryGenApp/backend/src/services/videoService.js
// Interpolation-chain video pipeline: Grok analyzes each shot pair, Grok Imagine
// renders the transition clips, and ffmpeg stitches them.

const fs = require('fs');
const path = require('path');
const { fetch } = require('undici');
const { log } = require('../utils/logger');
const { analyzeShotTransition } = require('./llmService');
const grokVideoService = require('./grokVideoService');
const videoLogStore = require('./videoLogStore');

const dataDir = path.join(__dirname, '../../data');
const videoDir = path.join(dataDir, 'videos');
const ensureDirs = () => {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
};

// Helper to read image bytes (from URL or Base64 data URI)
const readImageBytes = async (imageUrl) => {
  if (!imageUrl) return null;

  const DATA_URL_REGEX = /^data:(.+?);base64,(.+)$/;
  const dataMatch = DATA_URL_REGEX.exec(imageUrl);

  if (dataMatch) {
    // Already a base64 data URI
    return { bytesBase64Encoded: dataMatch[2], mimeType: dataMatch[1] || 'image/png' };
  }

  if (imageUrl.startsWith('http')) {
    // Fetch from URL
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`Failed to fetch image from URL: ${imageUrl}, Status: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { bytesBase64Encoded: buffer.toString('base64'), mimeType: res.headers.get('content-type') || 'image/png' };
  }
  
  // If it's a local file path (unlikely in this flow now but keep for robustness)
  if (fs.existsSync(imageUrl)) {
    const buffer = await fs.promises.readFile(imageUrl);
    const ext = path.extname(imageUrl).toLowerCase();
    let mimeType = 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    if (ext === '.webp') mimeType = 'image/webp';
    if (ext === '.gif') mimeType = 'image/gif';
    return { bytesBase64Encoded: buffer.toString('base64'), mimeType: mimeType };
  }

  throw new Error(`Unsupported image URL/path format: ${imageUrl}`);
};

// Generate one clip with Grok Imagine and save it under data/videos.
const generateClipDirectly = async (params) => {
  const firstFrame = await readImageBytes(params.first_frame_url);
  const lastFrame = await readImageBytes(params.last_frame_url);
  if (!firstFrame) throw new Error('A first frame image is required for clip generation');

  const downloadUrl = await grokVideoService.generateVideo({
    prompt: params.prompt,
    firstFrame,
    lastFrame,
    durationSeconds: params.duration_seconds,
  });

  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) throw new Error(`Failed to download Grok video: ${fileRes.status}`);

  const buffer = Buffer.from(await fileRes.arrayBuffer());
  const fileName = `clip_grok_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`;
  const outPath = path.join(videoDir, fileName);
  await fs.promises.writeFile(outPath, buffer);
  return { video_path: outPath, provider: 'grok' };
};

/**
 * Generate a full video from a storyboard using "Interpolation Chain" (Slide Window).
 * 1. Analyze pairs (Shot A -> Shot B) to get transition prompt & duration.
 * 2. Generate clips in parallel.
 * 3. Stitch clips.
 */
exports.generateFullVideoFromShots = async (storyboard) => {
  ensureDirs();
  const startTime = Date.now();
  
  const logId = videoLogStore.createLog(storyboard);
  log('video_generation_start', { shot_count: storyboard.length, logId });

  if (!storyboard || storyboard.length < 2) {
    const error = "Need at least 2 shots to generate a video sequence.";
    videoLogStore.updateLog(logId, { status: 'error', errorMessage: error });
    throw new Error(error);
  }

  try {
    // --- PHASE 1: PLAN (Analyze Transitions) ---
    const transitionPlans = [];
    // Sliding window: [0,1], [1,2], [2,3]...
    for (let i = 0; i < storyboard.length - 1; i++) {
      const shotA = storyboard[i];
      const shotB = storyboard[i+1];
      
      log('analyzing_transition', { from: shotA.shot, to: shotB.shot });
      
      try {
         // Call LLM to analyze visual transition
         const analysis = await analyzeShotTransition(shotA, shotB);
         
         transitionPlans.push({
           index: i,
           shotA: { shot: shotA.shot, description: shotA.description, imageUrl: shotA.imageUrl },
           shotB: { shot: shotB.shot, description: shotB.description, imageUrl: shotB.imageUrl },
           prompt: analysis.transition_prompt,
           duration: analysis.duration
         });
      } catch (e) {
          console.error(`Failed to analyze transition for shots ${shotA.shot}->${shotB.shot}`, e);
          // Fallback plan
          transitionPlans.push({
            index: i,
            shotA: { shot: shotA.shot, description: shotA.description, imageUrl: shotA.imageUrl },
            shotB: { shot: shotB.shot, description: shotB.description, imageUrl: shotB.imageUrl },
            prompt: "Cinematic transition, smooth camera movement.",
            duration: 6
          });
      }
    }

    // Add a closing clip for the final shot (no trailing frame).
    const closingShot = storyboard[storyboard.length - 1];
    const parsedClosingDuration = parseInt(closingShot.duration, 10);
    const validDurations = [4, 6, 8];
    const closingDuration = validDurations.includes(parsedClosingDuration) ? parsedClosingDuration : 6;
    const closingPrompt = `${closingShot.prompt || closingShot.description || "Final lingering shot."} Hold on the final frame with a gentle cinematic finish.`;
    transitionPlans.push({
      index: transitionPlans.length,
      shotA: { shot: closingShot.shot, description: closingShot.description, imageUrl: closingShot.imageUrl },
      shotB: null,
      prompt: closingPrompt,
      duration: closingDuration,
      isClosing: true
    });

    log('transition_plans_ready', { count: transitionPlans.length });
    videoLogStore.updateLog(logId, { status: 'generating', transitionPlans });

    // --- PHASE 2: GENERATE (Parallel Execution) ---
    // We map plans to promises
    const generatePromises = transitionPlans.map(async (plan) => {
        const { index, shotA, shotB, prompt, duration } = plan;
        
        try {
            log('generating_clip_start', { index, duration, closing: !!plan.isClosing });
            
            const result = await generateClipDirectly({
                prompt: prompt,
                duration_seconds: duration,
                first_frame_url: shotA.imageUrl,
                last_frame_url: shotB ? shotB.imageUrl : null, // null for the closing shot
            });

            return { index, videoPath: result.video_path, prompt, duration, provider: result.provider };
            
        } catch (e) {
            console.error(`Error generating clip for index ${index}:`, e);
            throw e; 
        }
    });

    // Execute all generations
    const clipResults = await Promise.all(generatePromises);
    
    // Sort by index just to be safe
    clipResults.sort((a, b) => a.index - b.index);
    const videoFiles = clipResults.map(r => r.videoPath);
    
    videoLogStore.updateLog(logId, { status: 'stitching', clipResults });

    // --- PHASE 3: STITCH (Assembly) ---
    log('stitching_videos', { files: videoFiles });
    
    const outputName = `full_story_${Date.now()}.mp4`;
    const outputPath = path.join(videoDir, outputName);
    
    // Create concat list
    const concatListPath = path.join(videoDir, `concat_list_${Date.now()}.txt`);
    const concatContent = videoFiles.filter(Boolean).map(f => `file '${f}'`).join('\n'); // Filter out nulls
    if (!concatContent) {
        throw new Error("No video files to stitch.");
    }
    await fs.promises.writeFile(concatListPath, concatContent);

    const ffmpeg = require('fluent-ffmpeg');
    const ffmpegPath = require('ffmpeg-static');
    if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c', 'copy']) // Fast stream copy
        .on('end', () => {
          log('ffmpeg_stitch_complete', { outputPath });
          resolve();
        })
        .on('error', (err) => {
          log('ffmpeg_stitch_error', { error: err.message });
          reject(err);
        })
        .save(outputPath);
    });
    
    const finalVideoUrl = `http://localhost:${process.env.PORT || 3005}/videos/${outputName}`;
    const duration = Date.now() - startTime;
    
    videoLogStore.updateLog(logId, { 
      status: 'completed', 
      finalVideoUrl, 
      duration 
    });
    
    log('full_video_complete', { output: outputPath, logId, duration });
    return finalVideoUrl;
    
  } catch (error) {
    const duration = Date.now() - startTime;
    videoLogStore.updateLog(logId, { 
      status: 'error', 
      errorMessage: error.message,
      duration 
    });
    throw error;
  }
};

// --- Backwards Compatibility Exports (Optional/Deprecated) ---
exports.generateVideo = async (storyboard) => {
    return exports.generateFullVideoFromShots(storyboard);
};

exports.generateSequencedVideo = async (storyboard, segments) => {
    return exports.generateFullVideoFromShots(storyboard);
};

exports.generateVideosForSegments = async (storyboard, segments) => {
    return exports.generateFullVideoFromShots(storyboard);
};
