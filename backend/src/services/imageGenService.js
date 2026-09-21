// Storyboard frame generation via Grok Imagine (xAI).
// Shot 1 uses text-to-image; later shots pass the first frame through the
// image-edits endpoint so the hero character stays visually consistent.
const grokClient = require('./grokClient');

const DEFAULT_IMAGE_STYLE = "Cinematic neon-noir, teal-magenta palette, volumetric rain and fog, soft bloom, anamorphic lens, shallow depth of field, subtle film grain, 16:9 composition";

const getBaseImageStyle = (env = process.env) => (env.IMAGE_STYLE || '').trim() || DEFAULT_IMAGE_STYLE;

const buildImagePrompt = (prompt, previousStyleHint, styleOverride, heroSubject, env) => {
  const appliedStyle = styleOverride && styleOverride.trim() !== '' ? styleOverride.trim() : getBaseImageStyle(env);

  // Build character consistency instruction
  const heroInstruction = heroSubject
    ? `CRITICAL - Main Character Description (MUST match exactly): ${heroSubject}.`
    : "";

  // Slightly tighten the prompt for visual fidelity and cross-shot consistency.
  const styleGlue = previousStyleHint
    ? `Maintain exact style continuity with previous shot: "${previousStyleHint}".`
    : "Establish the base look; following shots must keep this style.";

  return `
    Role: Cinematic frame artist.
    Goal: Render a single storyboard frame that matches the shared style and camera feel.
    ${heroInstruction}
    Style: ${appliedStyle}.
    Continuity: ${styleGlue}
    Frame description: ${prompt}.
    Constraints: no text, no captions, 16:9, high fidelity. The main character MUST look identical to the reference image if provided.
  `;
};

const placeholderImage = (prompt) => {
  const encodedPrompt = encodeURIComponent(prompt.substring(0, 50) + "...");
  return `https://placehold.co/600x400/222/FFF?text=${encodedPrompt}`;
};

// Both /images/generations and /images/edits answer with { data: [{ url }] }
// or { data: [{ b64_json }] } depending on response_format.
const extractImage = (json) => {
  const first = Array.isArray(json?.data) ? json.data[0] : null;
  if (!first) throw new Error('Grok image response contained no data');
  if (first.b64_json) {
    return first.b64_json.startsWith('data:') ? first.b64_json : `data:image/jpeg;base64,${first.b64_json}`;
  }
  if (first.url) return first.url;
  throw new Error('Grok image response contained neither b64_json nor url');
};

const generateWithGrok = async (imagePrompt, referenceImageBase64, options) => {
  const { env, fetchImpl } = options;
  const { imageModel } = grokClient.getConfig(env);
  const resolution = (env.XAI_IMAGE_RESOLUTION || '').trim() || '1k';

  const common = {
    model: imageModel,
    aspect_ratio: '16:9',
    resolution,
    response_format: 'b64_json',
    n: 1,
  };

  if (referenceImageBase64) {
    const body = {
      ...common,
      prompt: `Reference image shows the main character. Generate a new image where this SAME character (identical appearance, clothing, colors) performs the action described below:\n\n${imagePrompt}`,
      image: {
        type: 'image_url',
        url: referenceImageBase64.startsWith('data:')
          ? referenceImageBase64
          : `data:image/png;base64,${referenceImageBase64}`,
      },
    };
    const json = await grokClient.request('/images/edits', {
      method: 'POST', env, fetchImpl, body: JSON.stringify(body),
    });
    return extractImage(json);
  }

  const json = await grokClient.request('/images/generations', {
    method: 'POST', env, fetchImpl, body: JSON.stringify({ ...common, prompt: imagePrompt }),
  });
  return extractImage(json);
};

// Generate a frame for one storyboard shot.
// referenceImageBase64: base64 string of the first shot image (for character consistency)
// heroSubject: detailed character description from shot 1
// options: { env, fetchImpl } for tests
exports.generateImage = async (prompt, previousStyleHint = "", styleOverride, referenceImageBase64 = null, heroSubject = "", options = {}) => {
  const env = options.env || process.env;
  const imagePrompt = buildImagePrompt(prompt, previousStyleHint, styleOverride, heroSubject, env);

  if (!grokClient.hasApiKey(env)) {
    console.log("No valid XAI_API_KEY found. Using placeholder image.");
    return placeholderImage(prompt);
  }

  try {
    const imageUrl = await generateWithGrok(imagePrompt, referenceImageBase64, { env, fetchImpl: options.fetchImpl });
    console.log("Image generated successfully via Grok Imagine.");
    return imageUrl;
  } catch (error) {
    console.error("Error generating image with Grok Imagine:", error);
    console.log("Falling back to placeholder.");
  }

  return placeholderImage(prompt);
};

exports.getBaseImageStyle = getBaseImageStyle;
