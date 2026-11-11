const OpenAI = require('openai');
const Replicate = require('replicate');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { Logger } = require('./logger');
const { runFFmpeg, getMediaDuration, checkFFmpeg, ffmpegInstallHint, inspectMediaFile } = require('./ffmpeg');
const { MediaGenerationService } = require('./media-generation-service');

const OPENAI_IMAGE_MODEL = 'gpt-image-2';

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

function sanitizeSecretText(text) {
  if (!text) return '';
  let s = String(text);
  const secrets = [
    process.env.CLOUDFLARE_API_TOKEN,
    process.env.CLOUDFLARE_ACCOUNT_ID,
    process.env.OPENAI_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
    process.env.REPLICATE_API_TOKEN,
    process.env.REPLICATE_API_KEY,
    process.env.ELEVENLABS_API_KEY
  ].filter(Boolean);
  for (const secret of secrets) {
    if (secret && secret.length > 3) {
      s = s.split(secret).join('[REDACTED]');
    }
  }
  return s;
}

// Turns an image provider SDK error into one readable line that leads with the
// fix when the cause is recognisable. @google/genai puts the raw JSON error
// body in error.message, which is unreadable on a console.
function describeImageProviderError(provider, model, error) {
  const raw = String(error?.message || error || 'Unknown error');
  let status = Number(error?.status) || null;
  let code = String(error?.code || '');
  let detail = raw;
  try {
    const body = JSON.parse(raw.slice(raw.indexOf('{')));
    if (body?.error) {
      status = status || Number(body.error.code) || null;
      code = body.error.status || code;
      detail = body.error.message || raw;
    }
  } catch (_error) { /* not a JSON error body */ }

  const text = `${code} ${detail}`;
  let fix = null;
  if (provider === 'Gemini') {
    if (/limit:\s*0\b/i.test(text) || (status === 429 && /free.?tier/i.test(text))) {
      fix = `this key has no quota for ${model}. Gemini image models are not on the free tier: turn on billing for the Google Cloud project that owns this API key (AI Studio → API keys → Set up billing). A paid account does not help if the key belongs to a different project.`;
    } else if (status === 429 || /RESOURCE_EXHAUSTED/i.test(code)) {
      fix = 'Gemini rate-limited this key. Wait a minute and retry, or raise the project quota.';
    } else if (/API key not valid|API key expired|API_KEY_INVALID/i.test(text)) {
      fix = 'the Gemini API key was rejected. Create a new key in Google AI Studio and save it in Settings.';
    } else if (/location is not supported|user location/i.test(text)) {
      fix = 'Gemini image generation is not available in your region for this key.';
    } else if (status === 404 || /NOT_FOUND|not supported for generateContent/i.test(text)) {
      fix = `${model} is not available to this key. Set GEMINI_IMAGE_MODEL to an image model your key can use (for example gemini-3.1-flash-image).`;
    } else if (status === 403 || /PERMISSION_DENIED|SERVICE_DISABLED/i.test(text)) {
      fix = "this key's Google Cloud project cannot call the Gemini API. Enable the Generative Language API for that project, or create the key in Google AI Studio.";
    }
  } else if (provider === 'OpenAI') {
    if (status === 401 || /invalid_api_key|Incorrect API key/i.test(text)) {
      fix = 'the OpenAI API key was rejected. Check the key in Settings.';
    } else if (/insufficient_quota|billing/i.test(text)) {
      fix = 'the OpenAI account has no remaining credit. Add billing at platform.openai.com.';
    } else if (status === 403 && /verif/i.test(text)) {
      fix = `${model} requires a verified OpenAI organization (platform.openai.com → Settings → Organization → Verify).`;
    } else if (status === 429) {
      fix = 'OpenAI rate-limited this key. Wait a minute and retry.';
    }
  }

  const label = [status, code && code !== String(status) ? code : null].filter(Boolean).join(' ');
  const summary = `${provider} image generation (${model}) failed${label ? ` [${label}]` : ''}.`;
  const shortDetail = detail.replace(/\s+/g, ' ').trim().slice(0, 220);
  return fix ? `${summary} Fix: ${fix} Details: ${shortDetail}` : `${summary} ${shortDetail}`;
}

class AIVideoGenerator {
  constructor(credentials, options = {}) {
    this.logger = new Logger('AIVideoGenerator');
    const resolvedCredentials = credentials?.credentials || credentials || {};
    this.db = options.db || null;
    this.getMediaDuration = options.getMediaDuration || getMediaDuration;
    this.lastVideoResult = null;
    this.lastNarrationResult = null;
    
    // Initialize AI services with graceful fallback
    const openaiKey = resolvedCredentials.openai?.apiKey || process.env.OPENAI_API_KEY;
    const replicateKey = resolvedCredentials.replicate?.apiKey || process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
    
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
      this.logger.info('OpenAI service initialized');
    } else {
      this.logger.warn('OpenAI API key not found - AI features will be simulated');
    }
    
    if (replicateKey) {
      this.replicate = new Replicate({ auth: replicateKey });
      this.logger.info('Replicate service initialized');
    } else {
      this.logger.warn('Replicate API key not found - advanced video generation unavailable');
    }

    // Gemini media generation (images + native TTS) — primary AI media provider
    const geminiKey = resolvedCredentials.gemini?.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (geminiKey) {
      try {
        const { GoogleGenAI } = require('@google/genai');
        const opts = {
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build'
            }
          }
        };
        if (geminiKey && !geminiKey.startsWith('AQ.')) {
          opts.apiKey = geminiKey;
        }
        this.gemini = new GoogleGenAI(opts);
        this.logger.info('Gemini media service initialized (images + TTS)');
      } catch (error) {
        this.logger.warn('Failed to initialize Gemini media service:', error.message);
      }
    }
    
    // ElevenLabs configuration
    this.elevenLabsApiKey = resolvedCredentials.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY;
    this.elevenLabsVoiceId = resolvedCredentials.elevenLabs?.voiceId || process.env.ELEVENLABS_VOICE_ID;
    this.elevenLabsModel = process.env.ELEVENLABS_TTS_MODEL || 'eleven_v3';
    
    // Azure Speech configuration
    this.azureSpeechKey = resolvedCredentials.azure?.speechKey || process.env.AZURE_SPEECH_KEY;
    this.azureSpeechRegion = resolvedCredentials.azure?.speechRegion || process.env.AZURE_SPEECH_REGION;
    this.mediaGeneration = options.mediaGeneration || (this.db
      ? new MediaGenerationService(this.db, resolvedCredentials, { logger: this.logger })
      : null);
  }

  async generateTTSAudio(text, outputPath) {
    this.logger.info('Generating TTS audio...');
    this.lastNarrationResult = null;
    let provider = 'simulation';
    let model = null;

    try {
      let generatedPath;
      if (this.gemini) {
        provider = 'gemini';
        model = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
        generatedPath = await this.generateGeminiTTS(text, outputPath);
      } else if (this.elevenLabsApiKey && this.elevenLabsVoiceId) {
        provider = 'elevenlabs';
        model = this.elevenLabsModel;
        generatedPath = await this.generateElevenLabsTTS(text, outputPath);
      } else if (this.openai) {
        provider = 'openai';
        model = 'gpt-4o-mini-tts';
        generatedPath = await this.generateOpenAITTS(text, outputPath);
      } else {
        generatedPath = await this.simulateTTSGeneration(text, outputPath);
      }

      const usable = await this.isUsableAudioFile(generatedPath);
      this.lastNarrationResult = {
        status: usable ? 'ready' : 'unavailable',
        path: generatedPath,
        provider,
        model,
        externalTaskId: null,
        generatedAt: new Date().toISOString(),
        simulated: !usable,
        cost: { provider, amount: null, currency: null, invoiceRequired: provider !== 'simulation' }
      };
      return generatedPath;
    } catch (error) {
      this.lastNarrationResult = {
        status: 'failed', path: null, provider, model, externalTaskId: null,
        generatedAt: new Date().toISOString(), simulated: false, error: error.message,
        cost: { provider, amount: null, currency: null, invoiceRequired: provider !== 'simulation' }
      };
      this.logger.error('TTS generation failed:', error);
      throw error;
    }
  }

  async generateElevenLabsTTS(text, outputPath) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}`;
    
    const data = {
      text: text,
      model_id: this.elevenLabsModel,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true
      }
    };

    const response = await axios({
      method: 'POST',
      url: url,
      data: data,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': this.elevenLabsApiKey
      },
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        this.logger.info('ElevenLabs TTS generation complete');
        resolve(outputPath);
      });
      writer.on('error', reject);
    });
  }

  async generateOpenAITTS(text, outputPath) {
    const response = await this.openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "coral",
      input: text,
      speed: 1.0
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    this.logger.info('OpenAI TTS generation complete');
    return outputPath;
  }

  async generateGeminiTTS(text, outputPath) {
    const rawText = String(text || '').trim();
    if (!rawText) throw new Error('Cannot synthesize empty narration text');

    const primaryModel = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts';
    const candidateModels = [...new Set([primaryModel, 'gemini-3.8-flash-tts'])];
    const voiceName = process.env.GEMINI_TTS_VOICE || 'Kore';

    // Chunk narration text intelligently by paragraph / sentence boundaries (target ~350 chars/chunk)
    const chunks = this._chunkTextForTTS(rawText, 450);
    this.logger.info(`Synthesizing Hindi narration across ${chunks.length} audio chunks using Gemini TTS (voice: ${voiceName})...`);

    const pcmBuffers = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      let chunkAudioBase64 = null;
      let lastErr = null;

      for (const model of candidateModels) {
        try {
          const response = await this.gemini.models.generateContent({
            model,
            contents: [{ parts: [{ text: chunk }] }],
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName }
                }
              }
            }
          });

          chunkAudioBase64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (chunkAudioBase64) break;
        } catch (err) {
          lastErr = err;
          this.logger.warn(`Gemini TTS model ${model} failed on chunk ${i + 1}/${chunks.length}: ${err.message}`);
        }
      }

      if (!chunkAudioBase64) {
        throw new Error(`Gemini TTS failed on chunk ${i + 1}/${chunks.length}: ${lastErr?.message || 'No audio returned'}`);
      }

      pcmBuffers.push(Buffer.from(chunkAudioBase64, 'base64'));
    }

    const fullPcmBuffer = Buffer.concat(pcmBuffers);
    const pcmPath = outputPath + '.pcm';
    await fs.writeFile(pcmPath, fullPcmBuffer);

    // Convert raw 24kHz mono 16-bit PCM to output container (e.g. mp3) with high fidelity
    await runFFmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath, '-b:a', '192k', outputPath]);
    await fs.unlink(pcmPath).catch(() => {});

    this.logger.info(`Gemini TTS full narration synthesis complete (${chunks.length} chunks synthesized)`);
    return outputPath;
  }

  _chunkTextForTTS(text, maxChars = 450) {
    const rawParagraphs = text.split(/\n+/).map(p => p.trim()).filter(Boolean);
    const chunks = [];
    let current = '';

    for (const para of rawParagraphs) {
      if ((current + ' ' + para).length <= maxChars) {
        current = current ? (current + '\n' + para) : para;
      } else {
        if (current) chunks.push(current);
        if (para.length <= maxChars) {
          current = para;
        } else {
          // Split large paragraph on Hindi sentence delimiters (। or .)
          const sentences = para.split(/([।!?.]\s*)/).filter(Boolean);
          let sentenceBuf = '';
          for (let s = 0; s < sentences.length; s += 2) {
            const sentence = (sentences[s] || '') + (sentences[s + 1] || '');
            if ((sentenceBuf + sentence).length <= maxChars) {
              sentenceBuf += sentence;
            } else {
              if (sentenceBuf) chunks.push(sentenceBuf.trim());
              sentenceBuf = sentence;
            }
          }
          current = sentenceBuf.trim();
        }
      }
    }

    if (current) chunks.push(current.trim());
    return chunks.length > 0 ? chunks : [text];
  }

  async generateVisualAssets(prompt, style = "ethereal", count = 1) {
    this.logger.info(`Generating ${count} visual assets with style: ${style}`);

    try {
      if (!this.openai && !this.gemini && !process.env.CLOUDFLARE_API_TOKEN) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('No AI image provider configured in production (requires Cloudflare, OpenAI, or Gemini)');
        }
        return await this.simulateVisualAssets(prompt, style, count);
      }

      const enhancedPrompt = this.enhanceVisualPrompt(prompt, style);
      const localPaths = [];

      for (let i = 0; i < count; i++) {
        const imagePath = path.join(__dirname, '..', 'data', 'assets', `visual_${Date.now()}_${i}.png`);
        await this.generateImage(enhancedPrompt, imagePath);
        localPaths.push(imagePath);
      }

      this.logger.info(`Generated ${localPaths.length} visual assets`);
      return localPaths;
    } catch (error) {
      this.logger.error('Visual asset generation failed:', error);
      if (process.env.NODE_ENV === 'production') {
        throw error;
      }
      return await this.simulateVisualAssets(prompt, style, count);
    }
  }

  async generateImage(prompt, imagePath) {
    await fs.mkdir(path.dirname(imagePath), { recursive: true });

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    const providers = [];
    if (accountId && apiToken) {
      providers.push({
        name: 'Cloudflare',
        model: process.env.CLOUDFLARE_FLUX_MODEL || '@cf/black-forest-labs/flux-2-klein-4b',
        run: () => this.generateCloudflareImage(prompt, imagePath)
      });
    }
    if (this.openai) {
      providers.push({ name: 'OpenAI', model: OPENAI_IMAGE_MODEL, run: () => this.generateOpenAIImage(prompt, imagePath) });
    }
    if (this.gemini) {
      providers.push({ name: 'Gemini', model: this.geminiImageModel(), run: () => this.generateGeminiImage(prompt, imagePath) });
    }
    if (!providers.length) {
      throw new Error('No image generation provider configured');
    }

    // Try every configured provider before giving up, so a broken OpenAI key
    // does not hide a working Gemini key (or the reverse).
    const failures = [];
    for (const [index, provider] of providers.entries()) {
      try {
        return await provider.run();
      } catch (error) {
        const description = describeImageProviderError(provider.name, provider.model, error);
        failures.push(description);
        if (index < providers.length - 1) {
          this.logger.warn(`${description} Trying ${providers[index + 1].name} instead.`);
        }
      }
    }

    const error = new Error(failures.join(' | '));
    error.providerFailures = failures;
    throw error;
  }

  async generateCloudflareImage(prompt, imagePath) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      throw new Error('Cloudflare credentials (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN) are not configured');
    }

    const primaryModel = process.env.CLOUDFLARE_FLUX_MODEL || '@cf/black-forest-labs/flux-2-klein-4b';
    const candidateModels = [primaryModel, '@cf/black-forest-labs/flux-1-schnell'];
    const uniqueModels = [...new Set(candidateModels)];

    let lastError = null;

    for (const modelName of uniqueModels) {
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelName}`;
      this.logger.info(`Generating image using Cloudflare Workers AI model: ${modelName}`);

      let attempts = 0;
      const maxRetries = 2;

      while (attempts < maxRetries) {
        attempts++;
        try {
          const response = await axios.post(
            url,
            {
              prompt,
              num_steps: 4,
              width: 1024,
              height: 576
            },
            {
              headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
              },
              responseType: 'arraybuffer',
              timeout: 30000
            }
          );

          let imageBuffer = null;
          const contentType = String(response.headers['content-type'] || '').toLowerCase();

          if (contentType.includes('image/') || Buffer.isBuffer(response.data)) {
            const raw = Buffer.from(response.data);
            if (raw.length > 8 && (raw[0] === 0x89 || (raw[0] === 0xFF && raw[1] === 0xD8))) {
              imageBuffer = raw;
            } else {
              try {
                const parsed = JSON.parse(raw.toString('utf8'));
                if (parsed.result?.image) {
                  imageBuffer = Buffer.from(parsed.result.image, 'base64');
                } else if (typeof parsed.result === 'string') {
                  imageBuffer = Buffer.from(parsed.result, 'base64');
                } else if (!parsed.success) {
                  throw new Error(`Cloudflare API error: ${JSON.stringify(parsed.errors || parsed)}`);
                }
              } catch (parseErr) {
                if (raw.length > 500) {
                  imageBuffer = raw;
                } else {
                  throw parseErr;
                }
              }
            }
          }

          if (!imageBuffer || imageBuffer.length < 100) {
            throw new Error('Cloudflare API returned empty or invalid image buffer');
          }

          const metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
          if (!metadata.width || !metadata.height) {
            throw new Error('Generated image is invalid or corrupted');
          }

          const extension = path.extname(imagePath).toLowerCase();
          const output = sharp(imageBuffer, { failOn: 'error' }).resize(1920, 1080, { fit: 'cover' });
          if (extension === '.jpg' || extension === '.jpeg') {
            await output.jpeg({ quality: 92 }).toFile(imagePath);
          } else if (extension === '.webp') {
            await output.webp({ quality: 92 }).toFile(imagePath);
          } else {
            await output.png().toFile(imagePath);
          }

          this.logger.info(`Cloudflare image generation succeeded with model: ${modelName} (1920x1080)`);
          return imagePath;
        } catch (error) {
          lastError = new Error(sanitizeSecretText(error.message));
          this.logger.warn(`Cloudflare model ${modelName} attempt ${attempts}/${maxRetries} failed: ${lastError.message}`);
          if (attempts < maxRetries) {
            await new Promise(res => setTimeout(res, 1500 * attempts));
          }
        }
      }
    }

    throw new Error(`Cloudflare image generation failed: ${lastError?.message || 'Unknown error'}`);
  }

  geminiImageModel() {
    return process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
  }

  async generateOpenAIImage(prompt, imagePath) {
    const response = await this.openai.images.generate({
      model: OPENAI_IMAGE_MODEL,
      prompt: prompt,
      n: 1,
      size: "1536x1024",
      quality: "high",
    });

    if (response.data[0].b64_json) {
      const buffer = Buffer.from(response.data[0].b64_json, 'base64');
      await fs.writeFile(imagePath, buffer);
    } else {
      await this.downloadImage(response.data[0].url, imagePath);
    }

    return imagePath;
  }

  async generateGeminiImage(prompt, imagePath) {
    const model = this.geminiImageModel();

    const response = await this.gemini.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: '16:9',
          imageSize: '1K'
        }
      }
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    const imageParts = parts.filter(part =>
      part.inlineData?.data && (!part.inlineData.mimeType || part.inlineData.mimeType.startsWith('image/'))
    );
    const renderedImages = imageParts.filter(part => part.thought !== true);
    const imagePart = (renderedImages.length ? renderedImages : imageParts).at(-1);
    if (!imagePart) {
      throw new Error('Gemini image generation returned no image data');
    }

    const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
    const metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Gemini image generation returned an invalid image asset');
    }

    const extension = path.extname(imagePath).toLowerCase();
    const output = sharp(imageBuffer, { failOn: 'error' });
    if (extension === '.jpg' || extension === '.jpeg') {
      await output.jpeg({ quality: 92 }).toFile(imagePath);
    } else if (extension === '.webp') {
      await output.webp({ quality: 92 }).toFile(imagePath);
    } else {
      await output.png().toFile(imagePath);
    }
    return imagePath;
  }

  enhanceVisualPrompt(prompt, style) {
    const styleEnhancements = {
      cartoon: "simple 2D cartoon animation, 2D vector art style, clean outlines, vibrant colors, expressive cartoon characters",
      animated: "simple 2D cartoon animation, 2D vector art style, expressive characters, vivid colors, clean linework",
      ethereal: "simple 2D cartoon animation, mystical atmosphere, 2D vector art style, vibrant colors",
      modern: "modern 2D cartoon animation, clean design, vibrant color palette, expressive characters",
      cinematic: "dramatic 2D cartoon illustration, cinematic lighting, 2D animation style, bold contrast"
    };

    const normalizedStyle = String(style || '').trim().toLowerCase();
    const enhancement = styleEnhancements[normalizedStyle] || styleEnhancements.cartoon;
    return `${prompt}, ${enhancement}, 16:9 aspect ratio, 1080p high quality`;
  }

  async downloadImage(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async generateVideo(script, visualAssets, audioPath, outputPath, options = {}) {
    this.logger.info('Generating 1080p 16:9 video with Ken Burns motion & Hindi narration...');
    this.lastVideoResult = null;
    try {
      const produced = await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath, options);
      const videoPath = typeof produced === 'string' ? produced : produced.videoPath;
      const fallbackVisuals = Boolean(produced && produced.fallbackVisuals);
      
      this.lastVideoResult = {
        requestedProvider: 'slideshow',
        actualProvider: 'slideshow',
        model: 'gemini-image+ffmpeg',
        mode: 'slideshow',
        generatedSeconds: produced?.duration || 0,
        fallbackVisuals,
        tasks: [],
        scenes: []
      };
      return videoPath;
    } catch (error) {
      const sanitizedMsg = sanitizeSecretText(error?.message || String(error));
      this.logger.error(`Video generation failed: ${sanitizedMsg}`, error);
      this.lastVideoResult = {
        requestedProvider: 'slideshow',
        actualProvider: 'failed',
        model: null,
        mode: 'failed',
        generatedSeconds: 0,
        fallbackReason: sanitizedMsg,
        tasks: [],
        scenes: []
      };
      throw new Error(`Video rendering failed: ${sanitizedMsg}`);
    }
  }

  async generateHybridVideo(clips, visualAssets, audioPath, outputPath, totalDuration) {
    if (!(await checkFFmpeg())) throw new Error(ffmpegInstallHint());
    const validImages = await this.filterLocalImageAssets(visualAssets);
    const segments = clips.map(clip => ({ type: 'video', path: clip.path, duration: clip.duration }));
    const generatedDuration = segments.reduce((sum, item) => sum + item.duration, 0);
    const remaining = Math.max(0, this.parseDurationSeconds(totalDuration) - generatedDuration);
    if (remaining && validImages.length) {
      const perImage = Math.max(2, remaining / validImages.length);
      for (const imagePath of validImages) segments.push({ type: 'image', path: imagePath, duration: perImage });
    }
    if (!segments.length) throw new Error('No usable provider clips or still images were generated');

    const visualPath = outputPath.replace(/\.mp4$/i, '_hybrid_visual.mp4');
    await this.renderMediaTimeline(segments, visualPath);
    await this.addAudioToVideo(visualPath, audioPath, outputPath, { loopVideo: true });
    await fs.unlink(visualPath).catch(() => {});
    return outputPath;
  }

  async renderMediaTimeline(segments, outputPath) {
    const args = ['-y'];
    for (const segment of segments) {
      const duration = Number(segment.duration).toFixed(2);
      if (segment.type === 'image') args.push('-loop', '1', '-t', duration, '-framerate', '30', '-i', segment.path);
      // Loop short clips to fill their slot, but bound the input: an unbounded
      // -stream_loop keeps FFmpeg decoding long after trim has what it needs.
      else args.push('-stream_loop', '-1', '-t', duration, '-i', segment.path);
    }
    const filters = segments.map((segment, index) =>
      `[${index}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p,trim=duration=${Number(segment.duration).toFixed(2)},setpts=PTS-STARTPTS[v${index}]`
    );
    filters.push(`${segments.map((_, index) => `[v${index}]`).join('')}concat=n=${segments.length}:v=1:a=0[vout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath);
    await runFFmpeg(args);
    return outputPath;
  }

  async filterLocalImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const images = [];
    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) continue;
      try {
        await fs.access(asset);
        images.push(asset);
      } catch (_error) { /* ignore missing assets */ }
    }
    return images;
  }

  parseDurationSeconds(value) {
    if (Number.isFinite(Number(value))) return Math.max(0, Number(value));
    const parts = String(value || '').split(':').map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) return Math.max(0, parts[0] * 60 + parts[1]);
    if (parts.length === 3 && parts.every(Number.isFinite)) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
    return 0;
  }

  async generateReplicateVideo(script, visualAssets, audioPath, outputPath) {
    const output = await this.replicate.run(
      "wan-video/wan-2.7-i2v",
      {
        input: {
          image: visualAssets[0],
          prompt: script.title || "smooth cinematic motion",
          duration: 5,
          resolution: "720p"
        }
      }
    );

    // Download the generated video
    if (output && output.length > 0) {
      await this.downloadVideo(output[0], outputPath);
      
      // Add audio track
      await this.addAudioToVideo(outputPath, audioPath, outputPath);
    }

    return outputPath;
  }

  async generateFallbackSlides(script, slidesDir) {
    await fs.mkdir(slidesDir, { recursive: true });
    const slideTitles = [];
    slideTitles.push(script?.title || 'ImagineX Production');

    if (script?.mainContent && Array.isArray(script.mainContent.sections)) {
      script.mainContent.sections.forEach((sec, idx) => {
        slideTitles.push(sec.title || `Section ${idx + 1}`);
      });
    }
    slideTitles.push('धन्यवाद - Subscribe for More');

    const stills = [];
    const colors = [
      ['#1E1E2E', '#2A2A3D'],
      ['#181825', '#1E1E2E'],
      ['#11111B', '#181825'],
      ['#1F1F28', '#2D2D3D']
    ];

    for (let i = 0; i < slideTitles.length; i++) {
      const title = slideTitles[i];
      const bgPair = colors[i % colors.length];
      const svg = `<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg_${i}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${bgPair[0]}"/>
      <stop offset="100%" stop-color="${bgPair[1]}"/>
    </linearGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#bg_${i})"/>
  <rect x="80" y="80" width="1760" height="920" rx="24" fill="none" stroke="#45475A" stroke-width="4" stroke-dasharray="12 12"/>
  <text x="960" y="480" font-family="DejaVu Sans, Arial, sans-serif" font-size="64" font-weight="bold" fill="#F5E0DC" text-anchor="middle" dominant-baseline="middle">${escapeXml(title.slice(0, 55))}</text>
  <text x="960" y="600" font-family="DejaVu Sans, Arial, sans-serif" font-size="32" fill="#BAC2DE" text-anchor="middle" dominant-baseline="middle">ImagineX Hindi Documentary Fallback Visual</text>
  <text x="960" y="980" font-family="DejaVu Sans, Arial, sans-serif" font-size="24" fill="#A6ADC8" text-anchor="middle">FinalTube AI • High Quality Render</text>
</svg>`;

      const stillPath = path.join(slidesDir, `fallback_slide_${String(i).padStart(3, '0')}.png`);
      await sharp(Buffer.from(svg)).png().toFile(stillPath);
      stills.push(stillPath);
    }
    return stills;
  }

  async generateSlideshowVideo(script, visualAssets, audioPath, outputPath, options = {}) {
    this.logger.info('Creating slideshow video...');

    if (!(await checkFFmpeg())) {
      throw new Error(ffmpegInstallHint());
    }

    const slidesDir = path.join(path.dirname(outputPath), 'slides');
    const localImages = await this.filterLocalImageAssets(visualAssets);
    let stills = [];
    let usedFallbackVisuals = false;

    if (localImages.length === 0) {
      this.logger.warn('No AI visual assets generated; creating 1920x1080 fallback slide images');
      stills = await this.generateFallbackSlides(script, slidesDir);
      usedFallbackVisuals = true;
    } else {
      let browser = null;
      try {
        const { chromium } = require('playwright');
        browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setViewportSize({ width: 1920, height: 1080 });

        const imageAssets = await this.filterImageAssets(visualAssets);
        await page.setContent(this.createSlideshowHTML(script, imageAssets));
        await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' });
        await page.waitForTimeout(1000);

        const slideCount = await page.evaluate(() => document.querySelectorAll('.slide').length);
        await fs.mkdir(slidesDir, { recursive: true });

        for (let i = 0; i < slideCount; i++) {
          await page.evaluate((index) => {
            document.querySelectorAll('.slide').forEach((slide, s) => {
              slide.classList.toggle('active', s === index);
            });
          }, i);

          const stillPath = path.join(slidesDir, `slide_${String(i).padStart(3, '0')}.png`);
          await page.screenshot({ path: stillPath });
          stills.push(stillPath);
        }
      } catch (browserError) {
        this.logger.warn(`Playwright slide capture unavailable (${browserError.message}), using direct high-res visual assets`);
        stills = localImages;
      } finally {
        if (browser) {
          await browser.close().catch(() => {});
        }
      }
    }

    if (stills.length === 0) {
      throw new Error('No slides or visual assets available to render');
    }

    const videoPath = outputPath.replace(/\.mp4$/i, '_visual.mp4');
    const duration = await this.resolveSlideshowDuration(script, audioPath);
    await this.renderSlidesToVideo(stills, duration, videoPath);

    // Add audio and burn subtitles if available
    await this.addAudioToVideo(videoPath, audioPath, outputPath, options);

    if (stills[0] && stills[0].startsWith(slidesDir)) {
      await this.cleanupDirectory(slidesDir).catch(() => {});
    }

    const inspection = await inspectMediaFile(outputPath, { requireVideo: true, requireAudio: true });
    if (!inspection.valid) {
      throw new Error(`Output MP4 validation failed: ${inspection.error}`);
    }

    return {
      videoPath: outputPath,
      fallbackVisuals: usedFallbackVisuals,
      duration: inspection.duration,
      inspection
    };
  }

  async resolveSlideshowDuration(script, audioPath) {
    try {
      return (await this.getMediaDuration(audioPath)) + 0.5;
    } catch (error) {
      this.logger.warn(`Could not read narration duration, falling back to word-count estimate: ${error.message}`);
      return this.calculateScriptDuration(script);
    }
  }

  async renderSlidesToVideo(stills, totalDuration, videoPath) {
    if (stills.length === 0) {
      throw new Error('No slides to render');
    }

    const fade = 0.5;
    const overlapDuration = fade * Math.max(0, stills.length - 1);
    const perSlide = (totalDuration + overlapDuration) / stills.length;

    const args = ['-y'];
    const filters = [];

    stills.forEach((still, index) => {
      args.push('-i', still);
      
      const numFrames = Math.max(1, Math.round(perSlide * 30));
      let zoomExpr;
      const effectType = index % 3;
      if (effectType === 0) {
        // Smooth Zoom In
        zoomExpr = `zoompan=z='min(zoom+0.0012,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${numFrames}:s=1920x1080:fps=30`;
      } else if (effectType === 1) {
        // Smooth Zoom Out
        zoomExpr = `zoompan=z='max(1.18-0.0012*on,1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${numFrames}:s=1920x1080:fps=30`;
      } else {
        // Smooth Pan Across
        zoomExpr = `zoompan=z=1.12:x='if(gte(on,1),(iw-iw/zoom)*(on/${numFrames}),0)':y='ih/2-(ih/zoom/2)':d=${numFrames}:s=1920x1080:fps=30`;
      }
      filters.push(`[${index}:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,${zoomExpr},format=yuv420p[v${index}]`);
    });

    if (stills.length === 1) {
      args.push('-filter_complex', `${filters[0]};[v0]format=yuv420p[vout]`, '-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart', videoPath);
      await runFFmpeg(args);
      return videoPath;
    }

    // Chain crossfades
    let prev = '[v0]';
    for (let i = 1; i < stills.length; i++) {
      const out = `[vx${i}]`;
      const offset = (i * (perSlide - fade)).toFixed(2);
      filters.push(`${prev}[v${i}]xfade=transition=fade:duration=${fade}:offset=${offset}${out}`);
      prev = out;
    }
    filters.push(`${prev}format=yuv420p[vfinal]`);

    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[vfinal]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-movflags', '+faststart',
      '-r', '30',
      videoPath
    );

    await runFFmpeg(args);
    return videoPath;
  }

  async filterImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const mimeTypes = {
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp'
    };
    const images = [];

    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) {
        continue;
      }

      try {
        const imageBuffer = await fs.readFile(asset);
        const metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
        const mimeType = mimeTypes[metadata.format];
        if (mimeType && metadata.width && metadata.height) {
          images.push(`data:${mimeType};base64,${imageBuffer.toString('base64')}`);
        }
      } catch (_error) {
        // Skip missing or invalid image files
      }
    }

    return images;
  }

  createSlideshowHTML(script, visualAssets) {
    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            margin: 0;
            padding: 0;
            width: 1920px;
            height: 1080px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-family: 'Arial', sans-serif;
            overflow: hidden;
        }
        
        .slide {
            position: absolute;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 2s ease-in-out;
        }
        
        .slide.active {
            opacity: 1;
        }
        
        .content {
            position: relative;
            z-index: 2;
            text-align: center;
            color: white;
            max-width: 80%;
        }
        
        h1 {
            font-size: 72px;
            margin-bottom: 30px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        h2 {
            font-size: 48px;
            margin-bottom: 20px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        p {
            font-size: 36px;
            line-height: 1.4;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
        }
        
        .background-image {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            z-index: 0;
        }

        /* Darkens the image just enough to keep the slide text readable */
        .scrim {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.6) 100%);
            z-index: 1;
        }

        .particles {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            z-index: -1;
        }
        
        .particle {
            position: absolute;
            background: rgba(255,255,255,0.8);
            border-radius: 50%;
            animation: float 6s ease-in-out infinite;
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-20px); }
        }
    </style>
</head>
<body>
    <div class="particles"></div>
    
    <!-- Title Slide -->
    <div class="slide active">
        ${visualAssets[0] ? `<img class="background-image" src="${visualAssets[0]}" /><div class="scrim"></div>` : ''}
        <div class="content">
            <h1>${script.title}</h1>
        </div>
    </div>

    ${this.generateContentSlides(script, visualAssets).join('')}

    <!-- Subscribe Slide -->
    <div class="slide">
        <div class="content">
            <h2>Thanks for watching</h2>
            <p>Subscribe for more videos like this</p>
        </div>
    </div>
    
    <script>
        // Create floating particles
        function createParticles() {
            const container = document.querySelector('.particles');
            for (let i = 0; i < 20; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.top = Math.random() * 100 + '%';
                particle.style.width = (Math.random() * 4 + 2) + 'px';
                particle.style.height = particle.style.width;
                particle.style.animationDelay = Math.random() * 6 + 's';
                container.appendChild(particle);
            }
        }
        
        let currentSlide = 0;
        const slides = document.querySelectorAll('.slide');
        
        function advanceAnimation() {
            slides[currentSlide].classList.remove('active');
            currentSlide = (currentSlide + 1) % slides.length;
            slides[currentSlide].classList.add('active');
        }
        
        window.advanceAnimation = advanceAnimation;
        createParticles();
    </script>
</body>
</html>`;
  }

  generateContentSlides(script, visualAssets) {
    const slides = [];
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        const assetIndex = Math.min(index + 1, visualAssets.length - 1);
        
        slides.push(`
        <div class="slide">
            ${visualAssets[assetIndex] ? `<img class="background-image" src="${visualAssets[assetIndex]}" /><div class="scrim"></div>` : ''}
            <div class="content">
                <h2>${section.title}</h2>
                ${this.formatSectionContent(section)}
            </div>
        </div>`);
      });
    }
    
    return slides;
  }

  formatSectionContent(section) {
    if (section.items && Array.isArray(section.items)) {
      return section.items.slice(0, 3).map(item => 
        `<p>${item.number}. ${item.title}</p>`
      ).join('');
    }
    
    if (section.steps && Array.isArray(section.steps)) {
      return section.steps.slice(0, 3).map(step => 
        `<p>${step.title}</p>`
      ).join('');
    }
    
    // Script writers store spoken lines as an array of strings
    if (Array.isArray(section.content)) {
      return section.content
        .filter(line => typeof line === 'string' && line.trim())
        .slice(0, 3)
        .map(line => `<p>${line.slice(0, 120)}${line.length > 120 ? '...' : ''}</p>`)
        .join('');
    }

    if (typeof section.content === 'string') {
      return `<p>${section.content.slice(0, 200)}${section.content.length > 200 ? '...' : ''}</p>`;
    }

    return '';
  }

  calculateScriptDuration(script) {
    // Estimate duration based on word count (average 150 words per minute)
    let totalWords = 0;
    
    if (script.hook) totalWords += script.hook.text.split(' ').length;
    if (script.introduction) {
      totalWords += (script.introduction.greeting || '').split(' ').length;
      totalWords += (script.introduction.topicIntro || '').split(' ').length;
    }
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        if (typeof section.content === 'string') {
          totalWords += section.content.split(' ').length;
        }
        if (section.items) {
          section.items.forEach(item => {
            totalWords += (item.title + ' ' + item.description).split(' ').length;
          });
        }
        if (section.steps) {
          section.steps.forEach(step => {
            totalWords += (step.title + ' ' + step.description).split(' ').length;
          });
        }
      });
    }
    
    if (script.conclusion) {
      totalWords += script.conclusion.finalThought.split(' ').length;
    }
    
    // Convert to duration (150 words per minute)
    return Math.max(30, Math.ceil((totalWords / 150) * 60));
  }

  async ensureBackgroundMusicTrack() {
    const bgPath = path.join(__dirname, '..', 'data', 'audio', 'bg_music.mp3');
    try {
      await fs.access(bgPath);
      return bgPath;
    } catch (_error) {
      try {
        await fs.mkdir(path.dirname(bgPath), { recursive: true });
        await runFFmpeg([
          '-y', '-f', 'lavfi',
          '-i', 'sine=frequency=220:sample_rate=44100',
          '-t', '300',
          '-af', 'volume=0.04,lowpass=f=500',
          '-c:a', 'libmp3lame', bgPath
        ]);
        return bgPath;
      } catch (_e) {
        return null;
      }
    }
  }

  async addAudioToVideo(videoPath, audioPath, outputPath, options = {}) {
    const hasRealAudio = await this.isUsableAudioFile(audioPath);

    if (!hasRealAudio) {
      if (options.allowSilent === true) {
        this.logger.warn('Creating an intentionally silent video from an operator-confirmed override.');
        if (videoPath !== outputPath) await fs.copyFile(videoPath, outputPath);
        return outputPath;
      }
      const error = new Error('Narration audio is required. Regenerate narration or explicitly confirm an intentional silent video.');
      error.code = 'NARRATION_REQUIRED';
      throw error;
    }

    // FFmpeg cannot write to its own input, so mux to a temp file when paths collide
    const muxPath = outputPath === videoPath
      ? outputPath.replace(/\.mp4$/i, '_muxed.mp4')
      : outputPath;

    const bgMusicPath = await this.ensureBackgroundMusicTrack();
    const videoInput = options.loopVideo ? ['-stream_loop', '-1', '-i', videoPath] : ['-i', videoPath];

    let hasCaptions = false;
    const safeCaptionsPath = '/tmp/current_subtitles.srt';
    if (options.captionsPath) {
      try {
        await fs.access(options.captionsPath);
        await fs.copyFile(options.captionsPath, safeCaptionsPath);
        hasCaptions = true;
      } catch (err) {
        this.logger.debug(`Could not access captions at ${options.captionsPath}: ${err.message}`);
      }
    }

    try {
      if (bgMusicPath) {
        // Mix narration (100% volume) + background music (12% volume)
        if (hasCaptions) {
          const filterComplex = `[0:v]subtitles=${safeCaptionsPath}:force_style='FontName=Noto Sans Devanagari,FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=4,MarginV=45'[vout];[1:a]volume=1.0[narration];[2:a]volume=0.12[bgm];[narration][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`;
          const args = [
            '-y',
            ...videoInput,
            '-i', audioPath,
            '-stream_loop', '-1', '-i', bgMusicPath,
            '-filter_complex', filterComplex,
            '-map', '[vout]',
            '-map', '[aout]',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-shortest',
            muxPath
          ];
          await runFFmpeg(args);
        } else {
          const args = [
            '-y',
            ...videoInput,
            '-i', audioPath,
            '-stream_loop', '-1', '-i', bgMusicPath,
            '-filter_complex', '[1:a]volume=1.0[narration];[2:a]volume=0.12[bgm];[narration][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]',
            '-map', '0:v:0',
            '-map', '[aout]',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-shortest',
            muxPath
          ];
          await runFFmpeg(args);
        }
      } else {
        if (hasCaptions) {
          const filterComplex = `[0:v]subtitles=${safeCaptionsPath}:force_style='FontName=Noto Sans Devanagari,FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=4,MarginV=45'[vout]`;
          await runFFmpeg([
            '-y',
            ...videoInput,
            '-i', audioPath,
            '-filter_complex', filterComplex,
            '-map', '[vout]',
            '-map', '1:a:0',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-shortest',
            muxPath
          ]);
        } else {
          await runFFmpeg(['-y', ...videoInput, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', muxPath]);
        }
      }
    } finally {
      if (hasCaptions) {
        await fs.unlink(safeCaptionsPath).catch(() => {});
      }
    }

    if (muxPath !== outputPath) {
      await fs.rename(muxPath, outputPath);
    }

    this.logger.info('Audio and background music added to video successfully');
    return outputPath;
  }

  async isUsableAudioFile(audioPath) {
    if (typeof audioPath !== 'string' || audioPath.endsWith('.info')) {
      return false;
    }

    try {
      const stats = await fs.stat(audioPath);
      return stats.isFile() && stats.size > 0;
    } catch (error) {
      return false;
    }
  }

  async downloadVideo(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async cleanupDirectory(dirPath) {
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        await fs.unlink(path.join(dirPath, file));
      }
      await fs.rmdir(dirPath);
    } catch (error) {
      this.logger.warn('Cleanup failed:', error.message);
    }
  }

  async generateThumbnail(script, style = "ethereal") {
    this.logger.info('Generating custom thumbnail...');

    try {
      if (!this.openai && !this.gemini) {
        return await this.simulateThumbnailGeneration(script, style);
      }

      const prompt = `YouTube thumbnail for "${script.title}", ${style} style, eye-catching, high contrast text, professional design, clickable, engaging`;
      const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_${Date.now()}.png`);

      await this.generateImage(prompt, thumbnailPath);
      const metadata = await sharp(thumbnailPath).metadata();

      return {
        path: thumbnailPath,
        dimensions: { width: metadata.width, height: metadata.height },
        fileSize: await this.getFileSize(thumbnailPath)
      };
    } catch (error) {
      this.logger.error('Thumbnail generation failed:', error);
      return await this.simulateThumbnailGeneration(script, style);
    }
  }

  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  // Simulation methods for when APIs are not available
  async simulateTTSGeneration(text, outputPath) {
    this.logger.info('Simulating TTS generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI TTS audio would be generated here',
      text: text.substring(0, 100) + '...',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateVisualAssets(prompt, style, count) {
    this.logger.info(`Simulating ${count} visual assets...`);
    
    const paths = [];
    for (let i = 0; i < count; i++) {
      const assetPath = path.join(__dirname, '..', 'data', 'assets', `visual_sim_${Date.now()}_${i}.info`);
      
      await fs.writeFile(assetPath, JSON.stringify({
        message: 'AI visual asset would be generated here',
        prompt: prompt,
        style: style,
        timestamp: new Date().toISOString()
      }, null, 2));
      
      paths.push(assetPath);
    }
    
    return paths;
  }

  async simulateVideoGeneration(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Simulating video generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI video would be generated here',
      script: script.title,
      visualAssets: visualAssets.length,
      audioPath: audioPath,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateThumbnailGeneration(script, style) {
    this.logger.info('Simulating thumbnail generation...');
    
    const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_sim_${Date.now()}.info`);
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    
    await fs.writeFile(thumbnailPath, JSON.stringify({
      message: 'AI thumbnail would be generated here',
      title: script.title,
      style: style,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return {
      path: thumbnailPath,
      dimensions: { width: 1792, height: 1024 },
      fileSize: 1024,
      simulated: true
    };
  }
}

module.exports = { AIVideoGenerator, describeImageProviderError };
