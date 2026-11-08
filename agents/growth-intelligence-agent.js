const { Logger } = require('../utils/logger');
const { AITextService } = require('../utils/ai-text-service');

class GrowthIntelligenceAgent {
  constructor(db, credentials, agents = {}) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('GrowthIntelligence');
    this.ai = new AITextService(credentials?.credentials || {});
    this.agents = agents; // strategy, scriptWriter, thumbnailDesigner, seoOptimizer, production, publishing, analytics
  }

  async initialize() {
    this.logger.info('Initializing Growth Intelligence Agent...');
    return true;
  }

  /**
   * Main autonomous loop step: Analyze -> Research -> Plan -> Produce
   */
  async runCycle(options = {}) {
    const { auth } = options;
    this.logger.info('Starting Growth Intelligence cycle...');

    try {
      // 1. Analyze existing performance
      const performanceData = await this.analyzePreviousPerformance(auth);
      
      // 2. Understand audience from comments
      const audienceInterests = await this.extractAudienceInterests(auth);

      // 3. Research trending topics
      const trends = await this.researchTrends();

      // 4. Identify successful patterns
      const patterns = this.identifyPatterns(performanceData);

      // 5. Select next topic & Generate script
      const nextPlan = await this.planNextVideo(performanceData, audienceInterests, trends, patterns);

      // 6. Submit to production pipeline
      const jobId = await this.submitToPipeline(nextPlan);

      this.logger.success(`Growth cycle complete. New job submitted: ${jobId}`);
      return { success: true, jobId, plan: nextPlan };
    } catch (error) {
      this.logger.error('Growth cycle failed:', error);
      throw error;
    }
  }

  async analyzePreviousPerformance(auth) {
    this.logger.info('Analyzing previous performance...');
    if (!this.agents.analytics) {
      this.logger.warn('Analytics agent not available, using empty baseline');
      return { videos: [], averageScore: 0 };
    }
    
    const analytics = await this.agents.analytics.getRecentAnalytics(30, { auth });
    // Enrich with subscriber data if available
    return analytics;
  }

  async extractAudienceInterests(auth) {
    this.logger.info('Extracting audience interests from comments...');
    const engagement = this.agents.engagement || null;
    if (engagement && engagement.getSummary) {
      const summary = await engagement.getSummary({ auth });
      return summary.recentThemes || [];
    }
    return [];
  }

  async researchTrends() {
    this.logger.info('Researching trending topics...');
    const strategy = await this.db.getChannelStrategy() || {};
    const pillars = strategy.content_pillars || ['Science', 'Space', 'Apocalypse', 'Survival', 'Humanity', 'Alternate Reality'];
    
    const prompt = `
      You are a YouTube Growth Researcher for a Hindi channel focused on "WHAT IF" scenarios.
      Your goal is to find 3 high-potential, trending, or evergreen viral topics.
      
      Content Pillars: ${pillars.join(', ')}
      
      Research Criteria:
      1. High curiosity factor ("What if..." questions).
      2. Relevance to current scientific discoveries or pop culture mysteries.
      3. Broad appeal to an Indian audience (Universal themes but explained in Hindi).
      4. Avoid repetitive topics that have been covered recently.
      
      Respond with a JSON array of objects:
      [
        {
          "topic": "Dramatic Hindi topic name",
          "concept": "Detailed description of the hypothetical scenario",
          "targetAudience": "Who would love this?",
          "trendReason": "Why is this trending or likely to go viral?"
        }
      ]
    `;
    
    try {
      const response = await this.ai.generateText(prompt, { 
        responseMimeType: 'application/json',
        maxTokens: 1000 
      });
      return JSON.parse(response);
    } catch (error) {
      this.logger.error('Failed to research trends:', error);
      return [];
    }
  }

  identifyPatterns(performanceData) {
    // Identify which styles/topics got better watch time or CTR
    const patterns = {
      bestStyles: [],
      bestLengths: [],
      successfulKeywords: []
    };
    
    if (performanceData.topPerformers) {
      performanceData.topPerformers.forEach(video => {
        // Simple logic to collect successful traits
        if (video.performance.score > 70) {
          // Traits from metadata
        }
      });
    }
    
    return patterns;
  }

  async planNextVideo(performance, audience, trends, patterns) {
    this.logger.info('Planning next video...');
    
    const trendsText = trends.map(t => `- ${t.topic}: ${t.concept} (Reason: ${t.trendReason})`).join('\n');

    const prompt = `
      You are the Lead Producer for FinalTube AI. Based on the following data, select the BEST topic for the next video and create a production plan.
      
      CHANNEL PERFORMANCE:
      Average Score: ${performance.averagePerformanceScore}
      Top Performers: ${performance.topPerformers?.map(p => p.title).join(', ')}
      
      AUDIENCE INTERESTS (from comments):
      ${audience.join(', ') || 'General curiosity about science and survival'}
      
      TRENDING OPPORTUNITIES:
      ${trendsText}
      
      SUCCESSFUL PATTERNS:
      Styles: ${patterns.bestStyles.join(', ')}
      Keywords: ${patterns.successfulKeywords.join(', ')}
      
      LANGUAGE: All text must be in HINDI (Devanagari).
      
      Respond with a JSON object:
      {
        "topic": "The selected Hindi topic (Devanagari)",
        "rationale": "Detailed explanation of why this topic was chosen based on data",
        "style": "story|explainer|list",
        "length": "short|medium|long",
        "angle": "Specific unique angle for this video",
        "targetAudience": "Specific segment of the audience this targets"
      }
    `;

    try {
      const response = await this.ai.generateText(prompt, { 
        responseMimeType: 'application/json',
        maxTokens: 1000 
      });
      return JSON.parse(response);
    } catch (error) {
      this.logger.error('Failed to plan next video:', error);
      // Fallback plan
      return {
        topic: 'क्या होगा अगर पृथ्वी घूमना बंद कर दे?',
        rationale: 'Classic high-curiosity scientific scenario.',
        style: 'explainer',
        length: 'medium'
      };
    }
  }

  async submitToPipeline(plan) {
    this.logger.info(`Submitting job to pipeline: ${plan.topic}`);
    
    // In index.js, there's a startGenerationJob method.
    // Since this agent is used by the main operator, we'll return the plan
    // and let the caller (index.js/operator) handle the actual job start.
    return plan;
  }
}

module.exports = { GrowthIntelligenceAgent };
