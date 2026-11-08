const { Logger } = require('../utils/logger');
const { AITextService } = require('../utils/ai-text-service');

/**
 * MultiLanguageService
 * Handles single-video multi-language assets (Hindi master + English dubbed audio & translation).
 * Generates bilingual titles, descriptions, SRT subtitles, and analyzes YouTube multi-audio track API capabilities.
 */
class MultiLanguageService {
  constructor(credentials, options = {}) {
    this.credentials = credentials;
    this.logger = options.logger || new Logger('MultiLanguageService');
    this.aiTextService = new AITextService(credentials?.credentials || credentials || {});
  }

  /**
   * Generates English translated/localized packaging from Hindi master
   */
  async generateBilingualPackage(hindiScript, hindiSEO) {
    this.logger.info(`Generating bilingual packaging (Hindi master + English dub assets) for: "${hindiScript.title}"`);

    let englishTitle = '';
    let englishDescription = '';

    if (this.aiTextService.isAvailable()) {
      try {
        const prompt = `Translate and culturally localize this YouTube video title and description for an international/English-speaking audience.
Hindi Title: ${hindiScript.title}
Hindi Description: ${hindiSEO.description || hindiScript.fullScript?.substring(0, 300)}

Return ONLY valid JSON:
{
  "englishTitle": "Engaging, high-CTR English title (under 95 chars)",
  "englishDescription": "Comprehensive English description with key chapters and hashtags"
}`;
        const resp = await this.aiTextService.generateText(prompt, { temperature: 0.3, maxTokens: 1024 });
        const match = resp.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          englishTitle = parsed.englishTitle;
          englishDescription = parsed.englishDescription;
        }
      } catch (err) {
        this.logger.warn(`AI bilingual translation error: ${err.message}`);
      }
    }

    if (!englishTitle) {
      englishTitle = `What If: ${hindiScript.title.replace(/क्या हो अगर\.\.\.?/i, '').replace(/क्या होगा अगर/i, '').trim()} [Full Documentary]`;
      englishDescription = `What would happen in this extreme scenario? Dive deep into the science, timeline, and human survival reality.\n\nSubscribe to ImagineX for gripping What-If simulations!`;
    }

    // Build SRT Subtitles for both languages
    const hindiSrt = this.buildSRT(hindiScript.mainContent?.sections, 'hi');
    const englishSrt = this.buildSRT(hindiScript.mainContent?.sections, 'en');

    return {
      masterLanguage: 'hi',
      dubLanguage: 'en',
      hindi: {
        title: hindiScript.title,
        description: hindiSEO.description || '',
        srt: hindiSrt
      },
      english: {
        title: englishTitle,
        description: englishDescription,
        srt: englishSrt
      },
      // Analysis of YouTube multi-audio track platform capability
      multiAudioPlatformStatus: this.getYouTubeMultiAudioStatus()
    };
  }

  /**
   * Build SRT subtitles format from sections
   */
  buildSRT(sections = [], lang = 'hi') {
    if (!Array.isArray(sections) || !sections.length) return '';
    let srt = '';
    let cursorSec = 0;

    sections.forEach((sec, idx) => {
      const durationSec = Math.max(10, Math.round((String(sec.narration || '').split(/\s+/).length / 2.2)));
      const startSec = cursorSec;
      const endSec = cursorSec + durationSec;
      cursorSec = endSec;

      const formatTime = (seconds) => {
        const hrs = String(Math.floor(seconds / 3600)).padStart(2, '0');
        const mins = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
        const secs = String(seconds % 60).padStart(2, '0');
        return `${hrs}:${mins}:${secs},000`;
      };

      const text = lang === 'hi' 
        ? (sec.narration || sec.title || `दृश्य ${idx + 1}`)
        : (sec.title ? `[Scene ${idx + 1}] ${sec.title}` : `Narrative progression stage ${idx + 1}`);

      srt += `${idx + 1}\n${formatTime(startSec)} --> ${formatTime(endSec)}\n${text}\n\n`;
    });

    return srt;
  }

  /**
   * Truthful official YouTube API capability report on multi-audio tracks
   */
  getYouTubeMultiAudioStatus() {
    return {
      supportedViaPublicDataAPIv3: false,
      reason: 'YouTube Data API v3 does not currently provide a public endpoint to attach secondary alternate audio tracks (.wav/.mp3) to an existing video resource. Alternate audio tracks (Multi-Language Audio) are restricted to YouTube Studio CMS partner accounts or manual upload via YouTube Studio Web UI.',
      supportedFeatures: [
        'Multi-language captions/subtitles (via youtube.captions.insert)',
        'Localized multi-language metadata (title, description via video.localizations[lang])',
        'Direct Hindi master video upload with Devanagari metadata'
      ],
      recommendedWorkflow: '1. Video is published with master Hindi audio track, localized English metadata, and synchronized English & Hindi captions via API. 2. English dubbed audio track is exported to the production bundle for immediate 1-click addition in YouTube Studio > Subtitles & Audio.'
    };
  }
}

module.exports = { MultiLanguageService };
