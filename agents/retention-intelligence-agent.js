const { Logger } = require('../utils/logger');
const { AITextService } = require('../utils/ai-text-service');

/**
 * RetentionIntelligenceAgent
 * Enforces audience-retention pacing, 5-15s hook, curiosity loops,
 * and analyzes empirical YouTube watch curves to optimize storytelling structure.
 */
class RetentionIntelligenceAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('RetentionIntelligence');
    this.aiTextService = new AITextService(credentials?.credentials || credentials || {});
  }

  async initialize() {
    this.logger.info('Initializing Retention Intelligence Agent...');
    return true;
  }

  /**
   * Reviews and optimizes a draft script for maximum audience retention (5-15s hook, curiosity loops, no fluff)
   */
  async optimizeScriptRetention(script) {
    this.logger.info(`Analyzing script retention dynamics for: "${script.title}"`);

    // Rule 1: Validate 5-15 second explosive hook
    let hookText = String(script.hook || '').trim();
    if (!hookText || hookText.length < 30) {
      hookText = `कल्पना कीजिए... ठीक 5 सेकंड बाद, आपकी आँखों के सामने पूरी दुनिया का सारा पानी गायब हो जाए! (Imagine this... in exactly 5 seconds, all the water on Earth vanishes!)`;
    }

    // Rule 2: Remove fluff greetings and channel intros
    const bannedIntros = [
      'नमस्कार दोस्तों',
      'हेलो दोस्तों',
      'welcome to my channel',
      'स्वागत है आपका',
      'आज के इस वीडियो में हम बात करेंगे'
    ];

    for (const banned of bannedIntros) {
      if (hookText.toLowerCase().includes(banned.toLowerCase())) {
        hookText = hookText.replace(new RegExp(banned, 'gi'), '').trim();
      }
    }

    // Rule 3: Enforce curiosity loops between narrative sections
    const sections = Array.isArray(script.mainContent?.sections) ? script.mainContent.sections : [];
    const optimizedSections = sections.map((sec, idx) => {
      let narration = String(sec.narration || sec.content || '').trim();
      // Add mid-video curiosity loop at ~30% and ~70% if missing
      if (idx === Math.floor(sections.length * 0.3) && !narration.includes('लेकिन सबसे भयानक बात') && !narration.includes('पर क्या आप जानते हैं')) {
        narration += ' लेकिन वैज्ञानिक जिस सबसे भयानक परिणाम से डर रहे थे, वह तो अभी शुरू भी नहीं हुआ था...';
      }
      return {
        ...sec,
        narration
      };
    });

    const retentionScore = this.calculateScriptRetentionScore(hookText, optimizedSections);

    return {
      ...script,
      hook: hookText,
      mainContent: {
        ...(script.mainContent || {}),
        sections: optimizedSections
      },
      retentionScore,
      retentionOptimized: true
    };
  }

  calculateScriptRetentionScore(hook, sections) {
    let score = 70;
    if (hook.length >= 40 && hook.length <= 250) score += 15;
    if (sections.length >= 8 && sections.length <= 16) score += 10;
    const hasCuriosityLoop = sections.some(s => String(s.narration).includes('लेकिन') || String(s.narration).includes('रहस्य'));
    if (hasCuriosityLoop) score += 5;
    return Math.min(100, score);
  }

  /**
   * Ingests real retention curve points from YouTube Analytics (if available) and extracts actionable script insights
   */
  async analyzeEmpiricalRetention(videoId) {
    if (!videoId) return { available: false, reason: 'No videoId provided' };

    try {
      const snapshot = await this.db.getRow(
        'SELECT * FROM retention_snapshots WHERE video_id = ? ORDER BY created_at DESC LIMIT 1',
        [videoId]
      );

      if (!snapshot) {
        return {
          available: false,
          simulated: false,
          reason: 'No empirical retention curve provided by YouTube Analytics yet for this video.'
        };
      }

      const points = JSON.parse(snapshot.points || '[]');
      if (points.length < 5) {
        return { available: false, reason: 'Insufficient curve points' };
      }

      // Identify major drop-off points
      const dropOffs = [];
      for (let i = 1; i < points.length; i++) {
        const drop = points[i - 1].audienceWatchRatio - points[i].audienceWatchRatio;
        if (drop > 0.08) { // >8% drop in single segment
          dropOffs.push({
            atSeconds: points[i].elapsedSeconds,
            dropPercent: (drop * 100).toFixed(1)
          });
        }
      }

      return {
        available: true,
        videoId,
        totalPoints: points.length,
        averageWatchRatio: snapshot.summary?.averageWatchPercentage || null,
        majorDropOffs: dropOffs,
        recommendation: dropOffs.length > 0 
          ? `High drop-off detected around ${dropOffs[0].atSeconds}s. Tighten pacing and insert visual motion.`
          : 'Retention curve is healthy and stable across narrative beats.'
      };
    } catch (err) {
      this.logger.warn(`Retention analysis failed for ${videoId}: ${err.message}`);
      return { available: false, error: err.message };
    }
  }
}

module.exports = { RetentionIntelligenceAgent };
