require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { Logger } = require('./utils/logger');
const { Database, createDatabase } = require('./database/db');
const { CredentialManager } = require('./utils/credential-manager');
const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
const { ScriptWriterAgent } = require('./agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('./agents/production-management-agent');
const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
const { DailyAutomation } = require('./schedules/daily-automation');
const { OperatorService } = require('./utils/operator-service');
const { AutonomousChannelOperator } = require('./utils/autonomous-channel-operator');
const { ActivationMetrics } = require('./utils/activation-metrics');
const { AnonymousTelemetry } = require('./utils/anonymous-telemetry');
const { ProductionReadinessService } = require('./utils/production-readiness-service');
const { GenerationRecoveryService, GENERATION_STAGES } = require('./utils/generation-recovery-service');
const { ProvenanceService } = require('./utils/provenance-service');
const { SceneRepairService } = require('./utils/scene-repair-service');
const { ShortsRepurposingService } = require('./utils/shorts-repurposing-service');
const { AudienceEngagementService } = require('./utils/audience-engagement-service');
const { GrowthExperimentService } = require('./utils/growth-experiment-service');
const { AITextService } = require('./utils/ai-text-service');
const { DiscoverabilityService } = require('./utils/discoverability-service');
let GrowthIntelligenceAgent = null;
try {
  GrowthIntelligenceAgent = require('./agents/growth-intelligence-agent').GrowthIntelligenceAgent;
} catch (_err) {
  // Gracefully handles environments where the optional growth intelligence agent is not loaded
}

let YouTubeUploadAgent = null;
try {
  YouTubeUploadAgent = require('./agents/youtube-upload-agent').YouTubeUploadAgent;
} catch (_err) {
  // Gracefully handles environments where the optional direct upload agent is not loaded
}
const { StorySeriesIntelligenceAgent } = require('./agents/story-series-agent');
const { RetentionIntelligenceAgent } = require('./agents/retention-intelligence-agent');
const { MonetizationReadinessAgent } = require('./agents/monetization-readiness-agent');
const { AutonomousChannelManager } = require('./agents/channel-manager-agent');
const { MultiLanguageService } = require('./utils/multi-language-service');
const { version } = require('./package.json');
const chalk = require('chalk');

function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host).toLowerCase()) || /^127\./.test(String(host));
}

class YouTubeAutomationAgent {
  constructor() {
    this.logger = new Logger('MainAgent');
    this.db = null;
    this.credentials = null;
    this.agents = {};
    this.app = express();
    this.isInitialized = false;
    this.startupState = 'starting'; // 'starting' | 'ready' | 'degraded' | 'failed'
    this.startupStage = 'idle';
    this.startupError = null;
    this.startupDuration = 0;
    this.initPromise = null;
    this.apiConfigured = false;
    this.activeJobs = new Map();
    this.operator = null;
    this.autonomous = null;
    this.activation = null;
    this.telemetry = null;
    this.readiness = null;
    this.recovery = null;
    this.provenance = null;
    this.scenes = null;
    this.shorts = null;
    this.engagement = null;
    this.experiments = null;
    this.discoverability = null;
    this.setupRequired = false;
  }

  async initialize() {
    if (this.startupState === 'ready' || this.startupState === 'degraded') {
      return true;
    }
    const startTime = Date.now();
    this.startupState = 'starting';
    this.startupError = null;

    try {
      console.log(chalk.cyan.bold(`\n🎬 YouTube Automation Agent v${version}`));
      console.log(chalk.gray('─'.repeat(50)));
      
      // Stage 1: Database Initialization
      this.startupStage = 'database_init';
      const stage1Start = Date.now();
      this.logger.info('[Startup] Stage 1/6: Initializing database...');
      this.db = createDatabase();
      await this.db.initialize();
      await this.db.markInterruptedJobs();
      this.logger.info(`[Startup] Stage 1/6 (database_init) completed in ${Date.now() - stage1Start}ms`);

      // Stage 2: Core Services Instantiation
      this.startupStage = 'services_init';
      const stage2Start = Date.now();
      this.logger.info('[Startup] Stage 2/6: Instantiating recovery & operator services...');
      this.recovery = new GenerationRecoveryService(this.db, {
        logger: this.logger,
        updateJobStage: (...args) => this.updateJobStage(...args)
      });
      this.operator = new OperatorService(this.db);
      this.provenance = new ProvenanceService(this.db);
      this.discoverability = new DiscoverabilityService(this.db, { logger: this.logger });
      this.autonomous = new AutonomousChannelOperator(this.db, {
        researchAndPlan: (strategy, options) => {
          if (!this.agents.strategy) throw new Error('The strategy agent is not configured');
          return this.agents.strategy.researchAndPlanChannel(strategy, options);
        },
        startGenerationJob: input => this.startGenerationJob(input),
        resumeGenerationJob: (jobId, options) => this.resumeGenerationJob(jobId, options),
        waitForGenerationJob: jobId => this.waitForGenerationJob(jobId),
        notify: notification => this.operator.notify(notification)
      });
      this.activation = new ActivationMetrics(this.db);
      this.telemetry = new AnonymousTelemetry(this.db, this.logger);
      this.logger.info(`[Startup] Stage 2/6 (services_init) completed in ${Date.now() - stage2Start}ms`);
      
      // Stage 3: Credential Validation
      this.startupStage = 'credentials_validate';
      const stage3Start = Date.now();
      this.logger.info('[Startup] Stage 3/6: Validating provider credentials...');
      this.credentials = new CredentialManager();
      const credentialsValid = await this.credentials.validateAll();
      this.readiness = new ProductionReadinessService(this.db, this.credentials);
      this.logger.info(`[Startup] Stage 3/6 (credentials_validate) completed in ${Date.now() - stage3Start}ms`);
      
      if (!credentialsValid) {
        console.log(chalk.yellow('\n⚠️  AI text provider credentials missing. Set GEMINI_API_KEY in environment.'));
        this.setupRequired = true;
        this.setupAPI();
        this.startupState = 'degraded';
        this.startupStage = 'complete';
        this.isInitialized = true;
        this.startupDuration = Date.now() - startTime;
        this.logger.warn(`Dashboard started in setup mode (degraded) after ${this.startupDuration}ms; AI generation is disabled until key is added`);
        return true;
      }
      this.setupRequired = false;
      
      // Stage 4: Agent Initialization
      this.startupStage = 'agents_init';
      const stage4Start = Date.now();
      this.logger.info('[Startup] Stage 4/6: Initializing specialized agents...');
      await this.initializeAgents();
      this.scenes = this.agents.production?.sceneRepair || new SceneRepairService(
        this.db,
        this.agents.production?.aiVideoGenerator,
        { logger: this.logger }
      );
      this.shorts = new ShortsRepurposingService(this.db, this.agents.publishing, { logger: this.logger });
      this.engagement = new AudienceEngagementService(
        this.db,
        this.credentials,
        new AITextService(this.credentials?.credentials || {}),
        { logger: this.logger }
      );
      this.experiments = new GrowthExperimentService(
        this.db,
        this.agents.analytics,
        this.agents.publishing,
        { logger: this.logger }
      );
      this.logger.info(`[Startup] Stage 4/6 (agents_init) completed in ${Date.now() - stage4Start}ms`);

      // Stage 5: Capabilities Check
      this.startupStage = 'capabilities_check';
      const stage5Start = Date.now();
      this.logger.info('[Startup] Stage 5/6: Inspecting pipeline capabilities...');
      const capabilities = await this.logCapabilitySummary();
      if (capabilities.hasText && capabilities.hasFFmpeg) {
        await this.activation.markSetupReady(capabilities);
      }
      this.logger.info(`[Startup] Stage 5/6 (capabilities_check) completed in ${Date.now() - stage5Start}ms`);
      
      // Setup API endpoints
      this.setupAPI();
      
      // Stage 6: Scheduler Initialization
      this.startupStage = 'scheduler_init';
      const stage6Start = Date.now();
      this.logger.info('[Startup] Stage 6/6: Setting up automation scheduler...');
      this.scheduler = new DailyAutomation(this.agents, this.db, {
        generateContent: input => this.queueScheduledContent(input),
        engagement: this.engagement,
        experiments: this.experiments
      });
      await this.scheduler.initialize();

      if (await this.db.getSetting('automation_paused') === 'true') {
        await this.scheduler.pauseAutomation();
      }
      this.logger.info(`[Startup] Stage 6/6 (scheduler_init) completed in ${Date.now() - stage6Start}ms`);
      
      this.startupState = 'ready';
      this.startupStage = 'complete';
      this.isInitialized = true;
      this.startupDuration = Date.now() - startTime;
      this.logger.success(`YouTube Automation Agent initialized successfully in ${this.startupDuration}ms!`);
      
      return true;
    } catch (error) {
      this.startupState = 'failed';
      this.startupError = error.message || String(error);
      this.isInitialized = false;
      this.logger.error(`[Startup] FAILED at stage "${this.startupStage}" after ${Date.now() - startTime}ms:`, error);
      return false;
    }
  }

  async initializeAgents() {
    this.agents = {
      strategy: new ContentStrategyAgent(this.db, this.credentials),
      scriptWriter: new ScriptWriterAgent(this.db, this.credentials),
      thumbnailDesigner: new ThumbnailDesignerAgent(this.db, this.credentials),
      seoOptimizer: new SEOOptimizerAgent(this.db, this.credentials),
      production: new ProductionManagementAgent(this.db, this.credentials),
      publishing: new PublishingSchedulingAgent(this.db, this.credentials),
      analytics: new AnalyticsOptimizationAgent(this.db, this.credentials),
      growthIntelligence: GrowthIntelligenceAgent ? new GrowthIntelligenceAgent(this.db, this.credentials) : null,
      upload: YouTubeUploadAgent ? new YouTubeUploadAgent(this.db, this.credentials) : null,
      storySeries: new StorySeriesIntelligenceAgent(this.db, this.credentials),
      retention: new RetentionIntelligenceAgent(this.db, this.credentials),
      monetization: new MonetizationReadinessAgent(this.db, this.credentials)
    };

    // Central Channel Manager coordinates all specialized agents
    this.agents.channelManager = new AutonomousChannelManager(this.db, this.credentials, this.agents);
    this.multiLanguage = new MultiLanguageService(this.credentials, { logger: this.logger });

    // Initialize each agent
    for (const [name, agent] of Object.entries(this.agents)) {
      if (agent && typeof agent.initialize === 'function') {
        await agent.initialize();
        this.logger.info(`✓ ${name} agent initialized`);
      }
    }

    // Connect growth intelligence to its peer agents if initialized
    if (this.agents.growthIntelligence) {
      this.agents.growthIntelligence.agents = { ...this.agents };
    }

    // Connect publishing agent to upload agent if initialized
    if (this.agents.upload) {
      this.agents.publishing.uploadAgent = this.agents.upload;
    }
  }

  async getReadinessCapabilities() {
    const { checkFFmpeg, ffmpegInstallHint } = require('./utils/ffmpeg');
    const creds = this.credentials?.credentials || {};

    const hasText = Boolean(this.credentials?.hasAITextProvider?.());
    const hasGemini = Boolean(creds.gemini?.apiKey || process.env.GEMINI_API_KEY);
    const hasImages = Boolean(hasGemini || creds.openai?.apiKey || process.env.OPENAI_API_KEY);
    const hasTTS = Boolean(
      hasGemini ||
      creds.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY ||
      creds.openai?.apiKey || process.env.OPENAI_API_KEY ||
      creds.azureSpeech?.subscriptionKey || process.env.AZURE_SPEECH_KEY
    );
    const hasFFmpeg = await checkFFmpeg();
    const hasPublishing = Boolean(this.credentials?.hasPublishingCapability?.());
    const setupCompletedAt = await this.db.getSetting('setup_completed_at');
    const channelStrategy = await this.db.getChannelStrategy();
    const onboardingCompleted = Boolean(setupCompletedAt || channelStrategy);
    const schedulerActive = this.scheduler ? this.scheduler.isEnabled : false;

    return {
      channelConnected: hasPublishing,
      onboardingCompleted,
      aiCredentialsReady: hasText,
      imageGenerationReady: hasImages,
      voiceGenerationReady: hasTTS,
      ffmpegRenderingReady: hasFFmpeg,
      youtubePublishingReady: hasPublishing,
      schedulerActive,
      hints: {
        channelConnected: hasPublishing ? null : 'YouTube OAuth is not connected',
        onboardingCompleted: onboardingCompleted ? null : 'Complete onboarding settings to save channel preferences',
        aiCredentialsReady: hasText ? null : 'Set GEMINI_API_KEY in environment variable',
        imageGenerationReady: hasImages ? null : 'Uses Cloudflare FLUX or Gemini image generation',
        voiceGenerationReady: hasTTS ? null : 'Uses Gemini Hindi TTS',
        ffmpegRenderingReady: hasFFmpeg ? null : ffmpegInstallHint(),
        youtubePublishingReady: hasPublishing ? null : 'YouTube OAuth is not connected',
        schedulerActive: schedulerActive ? null : 'Scheduler is paused. Toggle Master Switch in Settings to resume.'
      }
    };
  }

  async logCapabilitySummary() {
    const capabilities = await this.getReadinessCapabilities();
    const { checkFFmpeg, ffmpegInstallHint } = require('./utils/ffmpeg');

    const summary = [
      { name: 'Script & strategy generation', ok: capabilities.aiCredentialsReady, hint: 'configure Gemini API key in environment' },
      { name: 'Image generation (visuals/thumbnails)', ok: capabilities.imageGenerationReady, hint: 'uses Cloudflare FLUX or Gemini image generation' },
      { name: 'Voice narration (TTS)', ok: capabilities.voiceGenerationReady, hint: 'uses Gemini Hindi TTS' },
      { name: 'Video assembly (FFmpeg)', ok: capabilities.ffmpegRenderingReady, hint: ffmpegInstallHint() },
      { name: 'YouTube publishing', ok: capabilities.youtubePublishingReady, hint: 'Optional for local creation & MP4 downloads; required for direct YouTube upload' }
    ];

    console.log(chalk.cyan('\n🔎 Capability check:'));
    for (const cap of summary) {
      if (cap.ok) {
        console.log(chalk.green(`  ✓ ${cap.name}`));
      } else {
        console.log(chalk.yellow(`  ✗ ${cap.name} — ${cap.hint}`));
      }
    }

    if (!capabilities.ffmpegRenderingReady) {
      this.logger.warn('FFmpeg is missing: no .mp4 files can be produced until it is installed.');
    }
    console.log('');
    return {
      hasText: capabilities.aiCredentialsReady,
      hasImages: capabilities.imageGenerationReady,
      hasTTS: capabilities.voiceGenerationReady,
      hasFFmpeg: capabilities.ffmpegRenderingReady,
      hasUpload: capabilities.youtubePublishingReady
    };
  }

  ensureReady() {
    return (req, res, next) => {
      if (this.startupState === 'starting') {
        return res.status(503).json({
          success: false,
          error: 'Application is still initializing. Please try again shortly.',
          state: 'starting',
          stage: this.startupStage
        });
      }
      if (this.startupState === 'failed') {
        return res.status(503).json({
          success: false,
          error: `Application initialization failed: ${this.startupError || 'Unknown error'}`,
          state: 'failed'
        });
      }
      if (this.startupState === 'degraded' && this.setupRequired) {
        if (req.path === '/generate' || req.path.startsWith('/publish')) {
          return res.status(503).json({
            success: false,
            error: 'Finish setup with npm run walkthrough before generating content',
            state: 'degraded'
          });
        }
      }
      return next();
    };
  }

  requireAPIKey() {
    return (req, res, next) => {
      const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true' || process.env.STRICT_API_KEY === 'true';
      const apiKey = process.env.API_KEY ? process.env.API_KEY.trim() : '';

      if (!apiKey) {
        if (isProduction) {
          this.logger.error('API_KEY is not configured in production environment! Protected endpoints fail closed.');
          return res.status(500).json({
            success: false,
            error: 'Server Misconfiguration: API_KEY environment variable is mandatory in production.'
          });
        }
        return next();
      }

      const clientKey = (req.get('x-api-key') || req.query.apiKey || '').trim();
      const crypto = require('crypto');
      const apiKeyBuffer = Buffer.from(apiKey);
      const clientKeyBuffer = Buffer.from(clientKey);

      if (apiKeyBuffer.length !== clientKeyBuffer.length || !crypto.timingSafeEqual(apiKeyBuffer, clientKeyBuffer)) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid API key' });
      }

      return next();
    };
  }

  getOAuthClientIds() {
    const ids = new Set();
    if (process.env.GOOGLE_OAUTH_CLIENT_ID) ids.add(process.env.GOOGLE_OAUTH_CLIENT_ID.trim());
    if (process.env.OAUTH_CLIENT_ID) ids.add(process.env.OAUTH_CLIENT_ID.trim());
    if (process.env.GOOGLE_CLIENT_ID) ids.add(process.env.GOOGLE_CLIENT_ID.trim());
    if (process.env.YOUTUBE_CLIENT_ID) ids.add(process.env.YOUTUBE_CLIENT_ID.trim());
    if (this.credentials?.youtube?.client_id) ids.add(this.credentials.youtube.client_id.trim());
    try {
      const config = require('./firebase-applet-config.json');
      if (config.oAuthClientId) ids.add(config.oAuthClientId.trim());
      if (config.clientId) ids.add(config.clientId.trim());
    } catch (_err) {
      // ignore
    }
    return Array.from(ids).filter(Boolean);
  }

  getOAuthClientId() {
    const ids = this.getOAuthClientIds();
    return ids[0] || null;
  }

  async verifyGoogleToken(token) {
    if (!token) return null;
    try {
      const axios = require('axios');
      const response = await axios.get(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`);
      const validClientIds = this.getOAuthClientIds();
      
      if (validClientIds.length > 0) {
        const tokenAud = response.data.aud;
        const tokenAzp = response.data.azp;
        const matches = validClientIds.some(id => tokenAud === id || tokenAzp === id);
        
        if (!matches) {
          this.logger.error(`Token verification failed: Client ID mismatch. Token aud: "${tokenAud}", azp: "${tokenAzp}". Configured IDs: ${validClientIds.join(', ')}`);
          return null;
        }
      }
      return response.data;
    } catch (error) {
      this.logger.error('Token verification failed:', error.response?.data || error.message);
      return null;
    }
  }

  getGoogleAuthMiddleware() {
    return async (req, res, next) => {
      const authHeader = req.get('Authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const tokenInfo = await this.verifyGoogleToken(token);
        if (tokenInfo) {
          req.googleToken = token;
          req.googleTokenInfo = tokenInfo;
          
          // Create an OAuth2 client for this request
          const { google } = require('googleapis');
          const oauth2Client = new google.auth.OAuth2();
          oauth2Client.setCredentials({ access_token: token });
          req.googleAuth = oauth2Client;
        }
      }
      next();
    };
  }

  validateGenerateRequestBody(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { valid: false, status: 400, error: 'Request body must be a JSON object' };
    }

    const value = {
      topic: null,
      style: null,
      length: typeof body.length === 'string' ? body.length.toLowerCase() : 'medium',
      strategyContext: null
    };

    // JSON has no `undefined`, so clients send `null` to mean "no value provided".
    // Both are treated as "not set" here: topic/style are optional and default to
    // auto-selection, which is exactly what `null` already represents internally.
    if (body.topic !== undefined && body.topic !== null) {
      if (typeof body.topic !== 'string') {
        return { valid: false, status: 400, error: 'topic must be a string' };
      }

      const topic = body.topic.trim();
      if (topic.length > 200) {
        return { valid: false, status: 400, error: 'topic must be 200 characters or less' };
      }
      value.topic = topic || null;
    }

    if (body.style !== undefined && body.style !== null) {
      if (typeof body.style !== 'string') {
        return { valid: false, status: 400, error: 'style must be a string' };
      }

      const allowedStyles = new Set([
        'tutorial',
        'explainer',
        'list',
        'review',
        'story',
        'educational',
        'informative',
        'engaging',
        'professional',
        'ethereal'
      ]);
      const style = body.style.trim();

      if (style.length > 50) {
        return { valid: false, status: 400, error: 'style must be 50 characters or less' };
      }

      value.style = allowedStyles.has(style.toLowerCase()) ? style.toLowerCase() : style || null;
    }

    if (!['short', 'medium', 'long'].includes(value.length)) {
      return { valid: false, status: 400, error: 'length must be short, medium, or long' };
    }

    if (body.strategyContext !== undefined && body.strategyContext !== null) {
      if (typeof body.strategyContext !== 'object' || Array.isArray(body.strategyContext)) {
        return { valid: false, status: 400, error: 'strategyContext must be an object' };
      }
      const limits = { angle: 500, rationale: 1000, audience: 500, objective: 1000, valueProposition: 1000, constraints: 2000, pillar: 100 };
      value.strategyContext = {};
      for (const [key, max] of Object.entries(limits)) {
        if (body.strategyContext[key] === undefined || body.strategyContext[key] === null) continue;
        if (typeof body.strategyContext[key] !== 'string' || body.strategyContext[key].length > max) {
          return { valid: false, status: 400, error: `strategyContext.${key} must be a string of ${max} characters or less` };
        }
        value.strategyContext[key] = body.strategyContext[key].trim();
      }
    }

    return { valid: true, value };
  }

  validateChannelStrategy(body = {}, current = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Channel strategy must be a JSON object');
    }
    const text = (key, fallback, max) => {
      const value = String(body[key] ?? fallback ?? '').trim();
      if (value.length > max) throw new Error(`${key} must be ${max} characters or less`);
      return value;
    };
    const objective = text('objective', current.objective, 1000);
    const audience = text('audience', current.audience, 500);
    if (!objective) throw new Error('A channel objective is required');
    if (!audience) throw new Error('A target audience is required');

    const rawPillars = body.contentPillars ?? current.contentPillars ?? [];
    if (!Array.isArray(rawPillars)) throw new Error('contentPillars must be an array');
    const contentPillars = rawPillars.map(value => String(value).trim()).filter(Boolean);
    if (!contentPillars.length || contentPillars.length > 8 || contentPillars.some(value => value.length > 100)) {
      throw new Error('Provide 1 to 8 content pillars, each 100 characters or less');
    }

    const integer = (key, fallback, min, max) => {
      const value = Number(body[key] ?? fallback);
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${key} must be an integer from ${min} to ${max}`);
      }
      return value;
    };
    const defaultFormat = text('defaultFormat', current.default_format || 'explainer', 20).toLowerCase();
    const defaultLength = text('defaultLength', current.default_length || 'medium', 20).toLowerCase();
    const status = text('status', current.status || 'draft', 20).toLowerCase();
    const primaryKpi = text('primaryKpi', current.primary_kpi || 'views', 30).toLowerCase();
    const outcomeCurrency = text('outcomeCurrency', current.outcome_currency || 'USD', 3).toUpperCase();
    if (!['explainer', 'tutorial', 'list', 'review', 'story'].includes(defaultFormat)) {
      throw new Error('defaultFormat is not supported');
    }
    if (!['short', 'medium', 'long'].includes(defaultLength)) throw new Error('defaultLength is not supported');
    if (!['draft', 'active', 'paused'].includes(status)) throw new Error('status must be draft, active, or paused');
    if (!['views', 'watch_hours', 'subscribers', 'engagement', 'revenue'].includes(primaryKpi)) {
      throw new Error('primaryKpi is not supported');
    }
    if (!/^[A-Z]{3}$/.test(outcomeCurrency)) throw new Error('outcomeCurrency must be a three-letter currency code');
    const optionalNumber = (key, fallback, min, max) => {
      const raw = body[key] ?? fallback;
      if (raw === undefined || raw === null || raw === '') return null;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${key} must be a number from ${min} to ${max}`);
      }
      return value;
    };

    return {
      objective,
      audience,
      valueProposition: text('valueProposition', current.value_proposition, 1000),
      contentPillars,
      cadencePerWeek: integer('cadencePerWeek', current.cadence_per_week || 1, 1, 7),
      videosPerRun: integer('videosPerRun', current.videos_per_run || 1, 1, 5),
      defaultFormat,
      defaultLength,
      successMetric: text('successMetric', current.success_metric, 300),
      primaryKpi,
      targetValue: optionalNumber('targetValue', current.target_value, 0.01, 1000000000),
      targetWindowDays: integer('targetWindowDays', current.target_window_days || 28, 7, 365),
      monthlyBudget: optionalNumber('monthlyBudget', current.monthly_budget, 0, 10000000),
      outcomeCurrency,
      constraints: text('constraints', current.constraints, 2000),
      status
    };
  }
  setupAPI() {
    if (this.apiConfigured) return;
    this.apiConfigured = true;

    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(this.getGoogleAuthMiddleware());
    this.app.use(express.static(path.join(__dirname, 'dashboard')));

    this.app.get('/api/config/firebase', async (_req, res) => {
      try {
        let fileConfig = {};
        const configPath = path.join(__dirname, 'firebase-applet-config.json');
        try {
          const content = await fs.readFile(configPath, 'utf8');
          fileConfig = JSON.parse(content);
        } catch (_err) {
          // File may not exist on custom deployments
        }

        const config = {
          projectId: process.env.FIREBASE_PROJECT_ID || fileConfig.projectId || '',
          appId: process.env.FIREBASE_APP_ID || fileConfig.appId || '',
          apiKey: process.env.FIREBASE_API_KEY || fileConfig.apiKey || '',
          authDomain: process.env.FIREBASE_AUTH_DOMAIN || fileConfig.authDomain || '',
          storageBucket: process.env.FIREBASE_STORAGE_BUCKET || fileConfig.storageBucket || '',
          messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || fileConfig.messagingSenderId || '',
          measurementId: process.env.FIREBASE_MEASUREMENT_ID || fileConfig.measurementId || '',
          oAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || process.env.YOUTUBE_CLIENT_ID || fileConfig.oAuthClientId || '',
          recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || fileConfig.recaptchaSiteKey || ''
        };

        if (!config.apiKey || !config.projectId) {
          return res.status(503).json({
            error: 'Auth configuration is incomplete on server. Add firebase-applet-config.json or set FIREBASE_API_KEY and FIREBASE_PROJECT_ID environment variables.',
            config
          });
        }

        return res.json(config);
      } catch (error) {
        return res.status(500).json({ error: `Failed to load Auth config: ${error.message}` });
      }
    });

    if (!process.env.API_KEY) {
      this.logger.warn('API_KEY is not set; mutating API routes are unprotected');
    }
    
    // Main dashboard route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
    });

    // Public Policy Pages (unprotected, accessible without login)
    this.app.get('/privacy', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard', 'privacy.html'));
    });
    this.app.get('/privacy.html', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard', 'privacy.html'));
    });

    this.app.get('/terms', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard', 'terms.html'));
    });
    this.app.get('/terms.html', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard', 'terms.html'));
    });
    
    // Health check (always available immediately upon server listening)
    this.app.get('/health', (req, res) => {
      const isReady = this.startupState === 'ready' || this.startupState === 'degraded';
      const statusCode = this.startupState === 'failed' ? 503 : 200;
      res.status(statusCode).json({
        status: isReady ? 'ok' : (this.startupState === 'failed' ? 'error' : 'starting'),
        app: 'FinalTube AI',
        ready: isReady,
        state: this.startupState,
        stage: this.startupStage,
        durationMs: this.startupDuration || undefined,
        ...(this.startupError ? { error: this.startupError } : {}),
        uptime: process.uptime()
      });
    });

    // Enforce startup readiness guard for operational and mutating routes
    this.app.use('/generate', this.ensureReady());
    this.app.use('/publish', this.ensureReady());
    this.app.use('/api', this.ensureReady());

    // Cloud Scheduler Webhook Endpoint
    this.app.post('/api/automation/trigger', this.requireAPIKey(), async (req, res) => {
      try {
        this.logger.info('Cloud Scheduler webhook triggered daily automation run');
        if (this.scheduler && this.scheduler.runDailyContentGeneration) {
          await this.scheduler.runDailyContentGeneration();
          return res.json({ success: true, message: 'Daily automation executed successfully' });
        }
        return res.status(503).json({ success: false, error: 'Scheduler not initialized' });
      } catch (error) {
        this.logger.error('Cloud Scheduler webhook execution failed:', error);
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    // Manual content generation
    this.app.post('/generate', this.requireAPIKey(), async (req, res) => {
      try {
        if (this.setupRequired) {
          return res.status(503).json({ success: false, error: 'Finish setup with npm run walkthrough before generating content' });
        }
        const validation = this.validateGenerateRequestBody(req.body);
        if (!validation.valid) {
          return res.status(validation.status).json({ success: false, error: validation.error });
        }

        const { topic, style, length } = validation.value;
        const result = await this.startGenerationJob({ topic, style, length, source: 'manual' });
        res.status(202).json({ success: true, result });
      } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    // Get analytics
    this.app.get('/analytics', async (req, res) => {
      try {
        if (!this.agents.analytics) return res.json({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [], learning: null });
        const analytics = await this.agents.analytics.getRecentAnalytics();
        const learning = await this.agents.analytics.getLearningSummary();
        res.json({ ...analytics, learning });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/analytics/channel', async (req, res) => {
      try {
        if (!this.agents.analytics?.getChannelSnapshot) {
          return res.json({ success: true, result: { available: false, reason: 'Connect YouTube with npm run walkthrough to see channel statistics.' } });
        }
        const result = await this.agents.analytics.getChannelSnapshot({ 
          refresh: req.query.refresh === '1',
          auth: req.googleAuth 
        });
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/outcomes', async (req, res) => {
      try {
        const learning = this.agents.analytics?.getLearningSummary
          ? await this.agents.analytics.getLearningSummary({ auth: req.googleAuth })
          : { outcome: null };
        return res.json({ success: true, result: learning.outcome || null });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get upcoming schedule
    this.app.get('/schedule', async (req, res) => {
      try {
        const schedule = await this.db.getUpcomingSchedule();
        res.json(schedule);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Manual publish
    this.app.post('/publish/:contentId', this.requireAPIKey(), async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ success: false, error: 'YouTube publishing is not configured' });
        const { contentId } = req.params;
        const bundle = await this.db.getProductionBundle(contentId);
        const short = bundle ? null : await this.db.getShortClip(contentId);
        if ((!bundle || bundle.review_status !== 'approved') && (!short || !['scheduled', 'uploading', 'reconciliation_required'].includes(short.status))) {
          return res.status(409).json({ success: false, error: 'Content must pass review and be approved before publishing' });
        }
        const result = await this.agents.publishing.publishContent(contentId, { auth: req.googleAuth });
        res.json({ success: true, result });
      } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/auth/url', async (req, res) => {
      res.status(410).json({ error: 'Legacy OAuth flow deprecated. Use client-side Firebase Auth.' });
    });

    this.app.post('/api/auth/code', async (req, res) => {
      res.status(410).json({ error: 'Legacy OAuth flow deprecated. Use client-side Firebase Auth.' });
    });

    this.app.get('/api/settings/automation', async (req, res) => {
      try {
        const settings = {
          masterSwitch: (await this.db.getSetting('automation_paused')) !== 'true',
          autoUpload: (await this.db.getSetting('auto_upload')) !== 'false',
          autoPublic: (await this.db.getSetting('auto_public_publishing')) === 'true',
          approvalRequired: (await this.db.getSetting('approval_required')) !== 'false'
        };
        res.json(settings);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/settings/automation', this.requireAPIKey(), async (req, res) => {
      try {
        const { masterSwitch, autoUpload, autoPublic, approvalRequired } = req.body;
        
        if (masterSwitch !== undefined) {
          await this.db.saveSetting('automation_paused', masterSwitch ? 'false' : 'true');
          if (this.scheduler) {
            masterSwitch ? await this.scheduler.resumeAutomation() : await this.scheduler.pauseAutomation();
          }
        }
        if (autoUpload !== undefined) await this.db.saveSetting('auto_upload', autoUpload ? 'true' : 'false');
        if (autoPublic !== undefined) await this.db.saveSetting('auto_public_publishing', autoPublic ? 'true' : 'false');
        if (approvalRequired !== undefined) await this.db.saveSetting('approval_required', approvalRequired ? 'true' : 'false');
        
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/auth/token', async (req, res) => {
      try {
        const { accessToken } = req.body;
        if (!accessToken) {
          return res.status(400).json({ success: false, error: 'Access token is required' });
        }
        
        // Verify token first
        const tokenInfo = await this.verifyGoogleToken(accessToken);
        if (!tokenInfo) {
          return res.status(401).json({ success: false, error: 'Invalid Google access token' });
        }

        this.credentials.tokens.youtube = {
          access_token: accessToken,
          scope: tokenInfo.scope,
          expiry_date: Date.now() + (Number(tokenInfo.expires_in || 3600) * 1000)
        };
        await this.credentials.saveTokens();
        await this.initializeAgents();

        // Fetch actual channel profile immediately and update channel_profiles table
        const { google } = require('googleapis');
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({ access_token: accessToken });
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
        const channelResp = await youtube.channels.list({
          part: 'snippet,statistics',
          mine: true
        });

        if (channelResp.data.items && channelResp.data.items.length > 0) {
          const ch = channelResp.data.items[0];
          await this.db.executeQuery(
            `UPDATE channel_profiles SET channel_name = ?, updated_at = datetime('now') WHERE id = 'default'`,
            [ch.snippet.title]
          );
        }

        res.json({ success: true, tokenInfo });
      } catch (error) {
        this.logger.error('Failed to save auth token:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/auth/disconnect', this.requireAPIKey(), async (req, res) => {
      try {
        this.credentials.tokens.youtube = null;
        await this.credentials.saveTokens();
        await this.initializeAgents();
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.setupOperatorAPI();
  }

  setupOperatorAPI() {
    const protect = this.requireAPIKey();

    this.app.get('/api/dashboard', async (req, res) => {
      try {
        const [stats, jobs, pipeline, schedule, events, notifications, profile, settings, ideas, analytics, learning, activation, channelStrategy, operatorRuns, readiness, engagement, experiments] = await Promise.all([
          this.db.getStats(),
          this.db.listGenerationJobs(20),
          this.db.getPipelineOverview(50),
          this.db.getUpcomingSchedule(30),
          this.db.getRecentAutomationEvents(20),
          this.db.listNotifications(20),
          this.db.getChannelProfile(),
          this.db.getAllSettings(),
          this.db.listContentIdeas(),
          this.agents.analytics
            ? this.agents.analytics.getRecentAnalytics(30)
            : Promise.resolve({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [] }),
          this.agents.analytics?.getLearningSummary
            ? this.agents.analytics.getLearningSummary()
            : Promise.resolve({ measuredVideos: 0, snapshotCount: 0, baseline: {}, recommendations: [], approvedCount: 0, pendingCount: 0 }),
          this.activation
            ? this.activation.getSummary()
            : Promise.resolve({ privacy: 'local-only', counts: {}, milestones: {} }),
          this.db.getChannelStrategy(),
          this.db.listOperatorRuns(10),
          this.readiness
            ? this.readiness.getSummary()
            : Promise.resolve({ status: 'unverified', stale: false, blockingFailures: [], checks: [] }),
          this.engagement
            ? this.engagement.getSummary({ auth: req.googleAuth })
            : Promise.resolve({
                videosTracked: 0, pendingDrafts: 0, postedToday: 0, needsAttentionCount: 0,
                pendingAudienceIdeas: 0, postingEnabled: false, postingDisabledReason: 'setup_required',
                insights: [], recentThemes: [],
                evidencePolicy: 'Comments are fetched read-only from YouTube. Replies post only after operator approval, and fallback analysis never proposes drafts or ideas.'
              }),
          this.experiments
            ? this.experiments.getSummary({ auth: req.googleAuth })
            : Promise.resolve({ experiments: [], candidates: [], activeCount: 0, awaitingDecisionCount: 0, evidencePolicy: 'Finish setup to create a controlled growth experiment.' })
        ]);
        const readinessChecklist = await this.getReadinessCapabilities();
        if (this.telemetry) void this.telemetry.sync(activation);
        res.json({
          stats, jobs, pipeline, schedule, events, notifications, profile, settings, ideas, analytics, learning, activation,
          channelStrategy, operatorRuns, readiness, engagement, experiments,
          system: {
            version,
            initialized: this.isInitialized,
            setupRequired: !readinessChecklist.aiCredentialsReady || !readinessChecklist.onboardingCompleted,
            onboardingCompleted: readinessChecklist.onboardingCompleted,
            publishingConfigured: readinessChecklist.youtubePublishingReady,
            publishingDisabledReason: readinessChecklist.hints.youtubePublishingReady,
            uptime: process.uptime(),
            activeJobs: this.activeJobs.size,
            automationPaused: !readinessChecklist.schedulerActive,
            agents: Object.keys(this.agents),
            autonomousRunning: Boolean(await this.db.getActiveOperatorRun()),
            readinessChecklist,
            videoProviders: this.agents.production?.aiVideoGenerator?.mediaGeneration?.listProviders() || []
          }
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/growth/cycle', protect, async (req, res) => {
      try {
        if (!this.agents.growthIntelligence) {
          return res.status(503).json({ error: 'Growth Intelligence Agent is not initialized' });
        }
        const result = await this.agents.growthIntelligence.runCycle({ auth: req.googleAuth });
        
        // Start the job if a plan was generated
        if (result.success && result.plan) {
          const job = await this.startGenerationJob({
            topic: result.plan.topic,
            style: result.plan.style,
            length: result.plan.length,
            source: 'growth_intelligence'
          });
          result.jobId = job.id;
        }
        
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/jobs/:jobId', async (req, res) => {
      const job = await this.db.getGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      job.checkpoints = await this.db.listGenerationCheckpoints(job.id);
      job.mediaTasks = await this.db.listMediaGenerationTasks(job.id);
      job.resumeFrom = this.recovery?.resumePoint(job.checkpoints);
      return res.json(job);
    });

    this.app.post('/api/jobs/:jobId/resume', protect, async (req, res) => {
      try {
        const result = await this.resumeGenerationJob(req.params.jobId, { stage: req.body?.stage });
        return res.status(202).json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/readiness', async (req, res) => {
      if (!this.readiness) return res.status(503).json({ error: 'Readiness service is not initialized' });
      return res.json(await this.readiness.getSummary());
    });

    this.app.post('/api/readiness/run', protect, async (req, res) => {
      try {
        if (!this.readiness) return res.status(503).json({ error: 'Readiness service is not initialized' });
        const result = await this.readiness.run({
          includePaidMedia: req.body?.includePaidMedia === true,
          includePaidVideo: req.body?.includePaidVideo === true,
          auth: req.googleAuth
        });
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/readiness/production-test', protect, async (req, res) => {
      try {
        const { ProductionManagementAgent } = require('./agents/production-management-agent');
        const productionManager = new ProductionManagementAgent(this.db, this.credentials);
        await productionManager.initialize();

        const sampleScript = {
          title: 'क्या होगा अगर पृथ्वी से ऑक्सीजन केवल 5 सेकंड के लिए गायब हो जाए?',
          hook: { type: 'question', text: 'क्या आपने कभी सोचा है कि अगर सिर्फ पाँच सेकंड के लिए ऑक्सीजन गायब हो जाए तो क्या होगा?' },
          introduction: {
            greeting: 'नमस्ते दोस्तों, फाइनलट्यूब हिंदी में आपका स्वागत है।',
            topicIntro: 'आज हम एक बेहद खतरनाक वैज्ञानिक परिस्थिति की कल्पना करेंगे।',
            valueProposition: 'आइए देखें इस छोटे से बदलाव से हमारी पृथ्वी पर क्या तबाही मचेगी।'
          },
          mainContent: {
            sections: [
              { title: 'पहला दृश्य: इमारतें और कंक्रीट', content: ['ऑक्सीजन के अचानक गायब होते ही दुनिया भर की कंक्रीट की इमारतें धूल बनकर बिखरने लगेंगी।', 'ऑक्सीजन कंक्रीट को मजबूत रखने वाला एक मुख्य बाइंडिंग तत्व है।'], duration: 6 },
              { title: 'दूसरा दृश्य: कान के पर्दे और आसमान', content: ['समुद्र का पानी सीधे भाप बनने लगेगा और वायुमंडल का दबाव अचानक 21 प्रतिशत गिर जाएगा।', 'इससे सभी इंसानों के कान के पर्दे तुरंत फट जाएंगे।'], duration: 6 },
              { title: 'तीसरा दृश्य: सूरज की रोशनी और अंधेरा', content: ['आसमान नीला दिखने के बजाय अचानक काला हो जाएगा क्योंकि हवा में प्रकाश का प्रकीर्णन रुक जाएगा।', 'यह पांच सेकंड मानवता के लिए इतिहास के सबसे भयानक क्षण होंगे।'], duration: 6 }
            ]
          },
          conclusion: {
            type: 'conclusion',
            title: 'निष्कर्ष',
            recap: ['हमने देखा कि ऑक्सीजन हमारे जीवन के लिए कितनी महत्वपूर्ण है।', 'प्रकृति का हर एक तत्व हमारे अस्तित्व की रक्षा करता है।'],
            finalThought: 'कुदरत के इस अद्भुत संतुलन को बनाए रखें।'
          },
          callToAction: {
            subscribe: 'ऐसे ही और रोमांचक वैज्ञानिक रहस्यों के लिए चैनल को सब्सक्राइब करें!',
            like: 'इस वीडियो को लाइक करना न भूलें।',
            comment: 'हमें कमेंट में बताएं अगला सवाल आप क्या पूछना चाहते हैं।'
          },
          duration: '0:30'
        };

        const productionData = {
          strategy: { topic: 'ओक्सीजन गायब!', angle: 'Hindi Science', contentType: 'Story' },
          script: sampleScript,
          thumbnail: { title: 'ओक्सीजन गायब!' },
          seo: { title: 'ओक्सीजन गायब!', description: 'टेस्ट', tags: ['science'] },
          jobId: `test_${Date.now()}`
        };

        const result = await productionManager.processContent(productionData);
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/jobs/:jobId/cancel', protect, async (req, res) => {
      const job = await this.db.getGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (!['queued', 'running'].includes(job.status)) {
        return res.status(409).json({ error: 'Only queued or running jobs can be cancelled' });
      }
      const updated = await this.db.updateGenerationJob(job.id, { cancelRequested: true, details: { cancelReason: req.body?.reason || 'Cancelled by operator' } });
      return res.json({ success: true, result: updated });
    });

    this.app.get('/api/content/:productionId', async (req, res) => {
      let bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      if (this.scenes && !bundle.scenes?.length) {
        await this.scenes.ensureManifest(bundle);
        bundle = await this.db.getProductionBundle(req.params.productionId);
      }
      return res.json(this.decorateContentBundle(bundle));
    });

    this.app.get('/api/content/:productionId/scenes/:sceneId/estimate', async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.regenerationEstimate(req.params.productionId, req.params.sceneId, {
          provider: req.query.provider
        });
        return res.json(result);
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.patch('/api/content/:productionId/scenes/:sceneId', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.updateScene(req.params.productionId, req.params.sceneId, req.body || {});
        await this.refreshContentReview(req.params.productionId, 'Scene changes require review before scheduling');
        return res.json({ success: true, result: this.scenes.decorateScene(result, req.params.productionId) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/scenes/reorder', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.reorder(req.params.productionId, req.body?.sceneIds);
        await this.refreshContentReview(req.params.productionId, 'Timeline order changed; rebuild and review before scheduling');
        return res.json({ success: true, result: result.map(scene => this.scenes.decorateScene(scene, req.params.productionId)) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/scenes/:sceneId/regenerate', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.regenerate(req.params.productionId, req.params.sceneId, req.body || {});
        await this.refreshContentReview(req.params.productionId, 'Regenerated scene must be rebuilt and reviewed');
        return res.status(202).json({ success: true, result: {
          ...result,
          scene: this.scenes.decorateScene(result.scene, req.params.productionId)
        } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/shorts/propose', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        const result = await this.shorts.propose(req.params.productionId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.patch('/api/content/:productionId/shorts/:clipId', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        const result = await this.shorts.update(req.params.productionId, req.params.clipId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/shorts/:clipId/render', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        const result = await this.shorts.render(req.params.productionId, req.params.clipId);
        return res.status(202).json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/shorts/:clipId/approve', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        const result = await this.shorts.approve(req.params.productionId, req.params.clipId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.get('/api/content/:productionId/shorts/:clipId/asset/:kind', async (req, res) => {
      try {
        const clip = await this.db.getShortClip(req.params.clipId);
        if (!clip || clip.productionId !== req.params.productionId) return res.status(404).json({ error: 'Short asset not found' });
        const filePath = req.params.kind === 'video' ? clip.outputPath : req.params.kind === 'captions' ? clip.captionsPath : null;
        if (!filePath) return res.status(404).json({ error: 'Short asset not found' });
        const resolved = path.resolve(filePath);
        const shortsRoot = path.resolve(__dirname, 'data', 'shorts');
        if (!resolved.startsWith(`${shortsRoot}${path.sep}`)) return res.status(403).json({ error: 'Short asset path is not allowed' });
        await fs.access(resolved);
        return res.sendFile(resolved);
      } catch (_error) {
        return res.status(404).json({ error: 'Short asset not found' });
      }
    });

    this.app.post('/api/content/:productionId/scenes/:sceneId/narration', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Narration recovery requires completed setup' });
        const result = await this.scenes.regenerateNarration(req.params.productionId, req.params.sceneId, req.body || {});
        await this.refreshContentReview(req.params.productionId, 'Narration regenerated; rebuild the final video before approval');
        return res.status(202).json({ success: true, result: this.scenes.decorateScene(result, req.params.productionId) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/narration/silence', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Narration recovery requires completed setup' });
        const result = await this.scenes.setSilenceOverride(req.params.productionId, req.body || {});
        await this.refreshContentReview(
          req.params.productionId,
          result.enabled ? 'Intentional silence recorded; rebuild and review before approval' : 'Narration is required again; regenerate it before approval'
        );
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.put(
      '/api/content/:productionId/scenes/:sceneId/asset',
      protect,
      express.raw({ type: ['image/*', 'video/*'], limit: '100mb' }),
      async (req, res) => {
        try {
          if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
          const result = await this.scenes.replaceAsset(req.params.productionId, req.params.sceneId, {
            buffer: req.body,
            contentType: req.get('content-type'),
            filename: req.get('x-file-name'),
            rightsConfirmed: req.get('x-rights-confirmed') === 'true',
            containsSyntheticMedia: req.get('x-synthetic-media') === 'true'
          });
          await this.refreshContentReview(req.params.productionId, 'Replacement scene asset must be rebuilt and reviewed');
          return res.json({ success: true, result: this.scenes.decorateScene(result, req.params.productionId) });
        } catch (error) {
          return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
        }
      }
    );

    this.app.post('/api/content/:productionId/scenes/rebuild', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.rebuild(req.params.productionId);
        await this.refreshContentReview(req.params.productionId, 'Scene repair rebuilt; final approval is required');
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.get('/api/content/:productionId/scenes/:sceneId/asset', async (req, res) => {
      try {
        const scene = await this.db.getProductionScene(req.params.productionId, req.params.sceneId);
        if (!scene?.assetPath) return res.status(404).json({ error: 'Scene asset not found' });
        const resolved = path.resolve(scene.assetPath);
        const dataRoot = path.resolve(__dirname, 'data');
        if (!resolved.startsWith(`${dataRoot}${path.sep}`)) return res.status(403).json({ error: 'Scene asset path is not allowed' });
        await fs.access(resolved);
        return res.sendFile(resolved);
      } catch (_error) {
        return res.status(404).json({ error: 'Scene asset not found' });
      }
    });

    this.app.patch('/api/content/:productionId', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        if (bundle.review_status === 'approved' && bundle.schedule?.status === 'published') {
          return res.status(409).json({ error: 'Published content cannot be edited here' });
        }
        const editorData = this.validateEditorData(req.body, bundle.editorData);
        const result = await this.db.saveContentReview(bundle.id, {
          status: bundle.review_status || 'needs_review',
          editorData,
          qualityChecks: bundle.qualityChecks,
          reviewNotes: req.body.reviewNotes ?? bundle.review_notes,
          reviewedAt: bundle.reviewed_at
        });
        return res.json({ success: true, result: this.decorateContentBundle(result) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/content/:productionId/approve', protect, async (req, res) => {
      try {
        const result = await this.approveContent(req.params.productionId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, quality: error.quality });
      }
    });

    this.app.post('/api/content/:productionId/reject', protect, async (req, res) => {
      const bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      await this.db.saveContentReview(bundle.id, {
        status: 'rejected',
        editorData: bundle.editorData,
        qualityChecks: bundle.qualityChecks,
        reviewNotes: req.body?.notes || 'Rejected by operator',
        reviewedAt: new Date().toISOString()
      });
      await this.db.updateProductionStatus(bundle.id, 'rejected');
      return res.json({ success: true });
    });

    this.app.post('/api/content/:productionId/retry', protect, async (req, res) => {
      const bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      const job = await this.startGenerationJob({
        topic: bundle.strategy.topic || bundle.editorData.title || null,
        style: bundle.strategy.requestedStyle || bundle.strategy.contentType || null,
        length: bundle.strategy.requestedLengthKey || 'medium',
        source: 'retry'
      });
      return res.status(202).json({ success: true, result: job });
    });

    this.app.get('/api/content/:productionId/asset/:kind', async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        const allowed = {
          video: bundle.assets?.finalVideo?.path,
          thumbnail: bundle.assets?.thumbnail?.path,
          audio: bundle.assets?.audio?.path,
          captions: bundle.assets?.captions?.path,
          script: bundle.assets?.script?.originalPath
        };
        const experimentMatch = req.params.kind.match(/^experiment-thumbnail-(\d+)$/);
        const experimentPath = experimentMatch
          ? bundle.editorData?.packagingExperiment?.thumbnailVariants?.[Number(experimentMatch[1])]?.path
          : null;
        const filePath = allowed[req.params.kind] || experimentPath;
        if (!filePath) return res.status(404).json({ error: 'Asset not found' });
        const resolved = path.resolve(filePath);
        const dataRoot = path.resolve(__dirname, 'data');
        const uploadsRoot = path.resolve(__dirname, 'uploads');
        const allowedPath = [dataRoot, uploadsRoot]
          .some(root => resolved.startsWith(`${root}${path.sep}`));
        if (!allowedPath) return res.status(403).json({ error: 'Asset path is not allowed' });
        await fs.access(resolved);
        if (req.query.download === '1' || req.query.download === 'true') {
          const filename = path.basename(resolved);
          return res.download(resolved, filename);
        }
        return res.sendFile(resolved);
      } catch (_error) {
        return res.status(404).json({ error: 'Asset not found' });
      }
    });

    this.app.put('/api/profile', protect, async (req, res) => {
      try {
        const profile = this.validateProfile(req.body || {});
        return res.json({ success: true, result: await this.db.saveChannelProfile(profile) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.put('/api/operator/strategy', protect, async (req, res) => {
      try {
        const current = await this.db.getChannelStrategy() || {};
        const strategy = this.validateChannelStrategy(req.body || {}, current);
        return res.json({ success: true, result: await this.db.saveChannelStrategy(strategy) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/operator/start', protect, async (req, res) => {
      try {
        if (this.setupRequired || !this.agents.strategy) {
          return res.status(503).json({ success: false, error: 'Finish setup with npm run walkthrough before activating the autonomous operator' });
        }
        if (this.activeJobs.size) {
          return res.status(409).json({ success: false, error: 'Wait for the current generation job to finish before starting an autonomous run' });
        }
        await this.readiness?.assertReady('Autonomous production');
        const current = await this.db.getChannelStrategy() || {};
        const strategy = this.validateChannelStrategy({ ...(req.body || {}), status: 'active' }, current);
        const saved = await this.db.saveChannelStrategy(strategy);
        const run = await this.autonomous.start(saved, { auth: req.googleAuth });
        return res.status(202).json({ success: true, result: run });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/growth/cycle', protect, async (req, res) => {
      try {
        if (!this.agents.growthIntelligence) return res.status(503).json({ error: 'Growth Intelligence agent is not initialized' });
        const result = await this.agents.growthIntelligence.runCycle();
        
        // Automatically start a generation job based on the planned content
        const job = await this.startGenerationJob({
          topic: result.plan.topic,
          style: result.plan.style || 'story',
          length: result.plan.length || 'medium',
          source: 'growth_intelligence'
        });

        return res.json({ success: true, plan: result.plan, job });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/operator/pause', protect, async (req, res) => {
      const strategy = await this.db.getChannelStrategy();
      if (!strategy) return res.status(404).json({ error: 'Channel strategy not found' });
      const active = await this.db.getActiveOperatorRun();
      if (active) await this.autonomous.cancel(active.id);
      const saved = await this.db.saveChannelStrategy({ ...strategy, status: 'paused' });
      return res.json({ success: true, result: saved });
    });

    this.app.post('/api/operator/runs/:runId/cancel', protect, async (req, res) => {
      const run = await this.autonomous.cancel(req.params.runId);
      if (!run) return res.status(404).json({ error: 'Operator run not found' });
      return res.json({ success: true, result: run });
    });

    this.app.put('/api/content/:productionId/provenance', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        if (bundle.review_status === 'approved' || bundle.schedule) {
          return res.status(409).json({ error: 'Provenance is locked after content is approved or scheduled' });
        }
        if (!this.provenance) this.provenance = new ProvenanceService(this.db);
        await this.provenance.review(bundle.id, req.body || {});
        const updated = await this.db.getProductionBundle(bundle.id);
        const profile = await this.db.getChannelProfile() || {};
        const quality = await this.operator.runQualityChecks({
          ...updated,
          scheduledPublishTime: updated.scheduled_publish_time
        }, profile);
        const reviewStatus = quality.passed ? 'needs_review' : 'needs_attention';
        const result = await this.db.saveContentReview(bundle.id, {
          status: reviewStatus,
          editorData: updated.editorData,
          qualityChecks: quality.checks,
          reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
          reviewedAt: null
        });
        return res.json({ success: true, result: this.decorateContentBundle(result) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/operator/runs/:runId/resume', protect, async (req, res) => {
      try {
        if (this.setupRequired || !this.agents.strategy) {
          return res.status(503).json({ success: false, error: 'Finish setup before resuming the autonomous operator' });
        }
        await this.readiness?.assertReady('Autonomous production recovery');
        const strategy = await this.db.getChannelStrategy();
        const run = await this.autonomous.resume(req.params.runId, strategy, { auth: req.googleAuth });
        return res.status(202).json({ success: true, result: run });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/learning/recommendations/:recommendationId/:action', protect, async (req, res) => {
      const { recommendationId, action } = req.params;
      if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Action must be approve or reject' });
      }
      const status = action === 'approve' ? 'approved' : 'rejected';
      const recommendation = await this.db.reviewLearningRecommendation(recommendationId, status);
      if (!recommendation) return res.status(404).json({ error: 'Learning recommendation not found' });
      await this.operator.notify({
        type: 'learning_recommendation_reviewed',
        level: action === 'approve' ? 'success' : 'info',
        title: action === 'approve' ? 'Channel learning approved' : 'Channel learning rejected',
        message: recommendation.title,
        data: { recommendationId, status }
      });
      return res.json({ success: true, result: recommendation });
    });

    this.app.post('/api/content/:productionId/discoverability/run', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ success: false, error: 'Content not found' });
        const profile = await this.db.getChannelProfile() || {};
        const audit = await this.discoverability.auditProduction(bundle, profile, req.body?.platform || 'youtube');
        if (bundle.review_status !== 'approved' && !bundle.schedule) {
          const updated = await this.db.getProductionBundle(bundle.id);
          const quality = await this.operator.runQualityChecks({
            ...updated,
            scheduledPublishTime: updated.scheduled_publish_time
          }, profile);
          await this.db.saveContentReview(bundle.id, {
            status: quality.passed ? 'needs_review' : 'needs_attention',
            editorData: updated.editorData,
            qualityChecks: quality.checks,
            reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
            reviewedAt: null
          });
        }
        const result = await this.db.getProductionBundle(bundle.id);
        return res.json({ success: true, result: this.decorateContentBundle(result), audit });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.patch('/api/content/:productionId/schedule', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'Publishing requires completed setup' });
        const result = await this.agents.publishing.rescheduleContent(req.params.productionId, req.body?.publishTime);
        await this.db.updateProductionStatus(req.params.productionId, 'scheduled');
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/publish-now', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'Publishing requires completed setup' });
        const result = await this.agents.publishing.emergencyPublish(req.params.productionId);
        await this.db.updateProductionStatus(req.params.productionId, result.status);
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.delete('/api/content/:productionId/schedule', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'Publishing requires completed setup' });
        const result = await this.agents.publishing.deleteScheduledContent(req.params.productionId);
        await this.db.updateProductionStatus(req.params.productionId, 'approved');
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.patch('/api/discoverability/findings/:findingId', protect, async (req, res) => {
      try {
        const finding = await this.discoverability.reviewFinding(req.params.findingId, req.body || {});
        const audit = await this.db.getLatestDiscoverabilityAudit(finding.production_id, finding.platform);
        return res.json({ success: true, result: { finding, audit } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/experiments', async (req, res) => {
      try {
        const summary = this.experiments
          ? await this.experiments.getSummary({ auth: req.googleAuth })
          : { experiments: [], candidates: [], activeCount: 0, awaitingDecisionCount: 0 };
        return res.json({ success: true, result: summary });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/experiments', protect, async (req, res) => {
      try {
        if (!this.experiments) return res.status(503).json({ error: 'Finish setup before creating experiments' });
        const experiment = await this.experiments.create(req.body || {});
        return res.status(201).json({ success: true, result: experiment });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/experiments/:experimentId/:action', protect, async (req, res) => {
      try {
        if (!this.experiments) return res.status(503).json({ error: 'Finish setup before controlling experiments' });
        const actions = {
          approve: () => this.experiments.approve(req.params.experimentId, req.body),
          start: () => this.experiments.start(req.params.experimentId, req.body),
          refresh: () => this.experiments.refresh(req.params.experimentId),
          adopt: () => this.experiments.adoptWinner(req.params.experimentId, req.body),
          cancel: () => this.experiments.cancel(req.params.experimentId, req.body)
        };
        if (!actions[req.params.action]) return res.status(400).json({ error: 'Unsupported experiment action' });
        const experiment = await actions[req.params.action]();
        await this.operator.notify({
          type: 'growth_experiment_updated',
          level: ['adopt', 'approve'].includes(req.params.action) ? 'success' : 'info',
          title: `Growth experiment ${req.params.action}`,
          message: experiment.title,
          data: { experimentId: experiment.id, status: experiment.status }
        });
        return res.json({ success: true, result: experiment });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.get('/api/retention/:videoId', async (req, res) => {
      const videoId = String(req.params.videoId || '').trim();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(videoId)) {
        return res.status(400).json({ error: 'A valid YouTube video ID is required' });
      }
      const snapshots = await this.db.listRetentionSnapshots({ videoId, limit: 10 });
      return res.json({ success: true, result: snapshots });
    });

    this.app.post('/api/retention/:videoId/refresh', protect, async (req, res) => {
      try {
        const videoId = String(req.params.videoId || '').trim();
        const measurementWindow = String(req.body?.measurementWindow || 'rolling');
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        if (!['24h', '7d', 'rolling'].includes(measurementWindow)) {
          return res.status(400).json({ error: 'Measurement window must be 24h, 7d, or rolling' });
        }
        if (!this.agents.analytics) {
          return res.status(503).json({ error: 'YouTube Analytics is not initialized' });
        }
        const report = await this.agents.analytics.analyzeVideoPerformance(videoId, { measurementWindow });
        return res.json({
          success: true,
          result: report.retentionSnapshot || null,
          retention: report.retention
        });
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message });
      }
    });

    const ENGAGEMENT_VIDEO_ID = /^[A-Za-z0-9_-]{1,100}$/;

    this.app.get('/api/engagement/:videoId', async (req, res) => {
      try {
        const videoId = String(req.params.videoId || '').trim();
        if (!ENGAGEMENT_VIDEO_ID.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        const [insight, comments, drafts] = await Promise.all([
          this.db.getEngagementInsight(videoId),
          this.db.listAudienceComments({ videoId, limit: 200 }),
          this.db.listReplyDrafts({ videoId, limit: 100 })
        ]);
        return res.json({ success: true, result: { insight, comments, drafts } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/engagement/:videoId/sync', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const videoId = String(req.params.videoId || '').trim();
        if (!ENGAGEMENT_VIDEO_ID.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        const sync = await this.engagement.syncVideoComments(videoId, { ...req.body, auth: req.googleAuth });
        const insight = sync.fetched > 0 || req.body?.analyze === true
          ? await this.engagement.analyzeVideo(videoId)
          : sync.insight;
        return res.status(202).json({ success: true, result: { ...sync, insight } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/engagement/:videoId/draft-replies', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const videoId = String(req.params.videoId || '').trim();
        if (!ENGAGEMENT_VIDEO_ID.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        const result = await this.engagement.draftReplies(videoId, { ...req.body, auth: req.googleAuth });
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.patch('/api/engagement/replies/:draftId', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const result = await this.engagement.updateReplyDraft(req.params.draftId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/engagement/replies/:draftId/approve', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const result = await this.engagement.approveReplyDraft(req.params.draftId, { ...req.body, auth: req.googleAuth });
        // The reply is already live on YouTube; a notification failure must not report an error.
        try {
          await this.operator.notify({
            type: 'audience_reply_posted',
            level: 'success',
            title: 'Audience reply posted',
            message: `A reply was posted on video ${result.videoId}`,
            data: { draftId: result.id, videoId: result.videoId, postedCommentId: result.postedCommentId }
          });
        } catch (notifyError) {
          this.logger.warn(`Posted reply notification failed: ${notifyError.message}`);
        }
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/ideas', protect, async (req, res) => {
      const topic = String(req.body?.topic || '').trim();
      if (!topic || topic.length > 200) return res.status(400).json({ error: 'A topic of 200 characters or less is required' });
      const idea = await this.db.createContentIdea({ ...req.body, topic });
      return res.status(201).json({ success: true, result: idea });
    });

    this.app.patch('/api/ideas/:ideaId', protect, async (req, res) => {
      const idea = await this.db.updateContentIdea(req.params.ideaId, req.body || {});
      if (!idea) return res.status(404).json({ error: 'Idea not found' });
      return res.json({ success: true, result: idea });
    });

    this.app.post('/api/ideas/:ideaId/generate', protect, async (req, res) => {
      const idea = await this.db.updateContentIdea(req.params.ideaId, { status: 'generating' });
      if (!idea) return res.status(404).json({ error: 'Idea not found' });
      const job = await this.startGenerationJob({ topic: idea.topic, style: idea.style, length: req.body?.length || 'medium', source: 'idea' });
      await this.db.updateContentIdea(idea.id, { status: 'generated' });
      return res.status(202).json({ success: true, result: job });
    });

    // ── AUTONOMOUS CHANNEL MANAGER & STORY UNIVERSE API ──────────────
    this.app.get('/api/channel/review', async (_req, res) => {
      try {
        if (!this.agents.channelManager) {
          return res.status(503).json({ error: 'Channel Manager is initializing' });
        }
        const review = await this.agents.channelManager.conductChannelReview();
        return res.json({ success: true, review });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/channel/calendar', async (req, res) => {
      try {
        const days = parseInt(req.query.days || '7', 10);
        if (!this.agents.channelManager) {
          return res.status(503).json({ error: 'Channel Manager is initializing' });
        }
        const calendar = await this.agents.channelManager.planContentCalendar(days);
        return res.json({ success: true, calendar });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/story/universes', async (_req, res) => {
      try {
        const universes = await this.db.listStoryUniverses('active');
        return res.json({ success: true, universes });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/story/plan-episode', protect, async (req, res) => {
      try {
        if (!this.agents.storySeries) {
          return res.status(503).json({ error: 'Story Series Agent is initializing' });
        }
        const { universeId, feedbackInsights } = req.body || {};
        const result = await this.agents.storySeries.planNextEpisode(universeId, feedbackInsights);
        return res.json({ success: true, ...result });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/monetization/report', async (_req, res) => {
      try {
        if (!this.agents.monetization) {
          return res.status(503).json({ error: 'Monetization Agent is initializing' });
        }
        const report = await this.agents.monetization.getLatestReport();
        return res.json({ success: true, report });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/multi-language/status', (_req, res) => {
      if (!this.multiLanguage) {
        return res.status(503).json({ error: 'Multi-Language Service is initializing' });
      }
      return res.json({
        success: true,
        status: this.multiLanguage.getYouTubeMultiAudioStatus()
      });
    });

    // ── DATABASE CROSS-RUN & RENDER CLOUD PERSISTENCE SYNC API ──────
    this.app.get('/api/state/sync', protect, async (_req, res) => {
      try {
        const state = await this.db.exportStateJSON();
        return res.json({ success: true, state });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/state/sync', protect, async (req, res) => {
      try {
        const { state } = req.body || {};
        if (!state) return res.status(400).json({ error: 'State object is required' });
        await this.db.importStateJSON(state);
        return res.json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/automation/:action', protect, async (req, res) => {
      if (!this.scheduler) return res.status(409).json({ error: 'Finish setup before controlling automation' });
      const { action } = req.params;
      if (action === 'pause') {
        await this.scheduler.pauseAutomation();
        await this.db.setSetting('automation_paused', 'true');
      } else if (action === 'resume') {
        await this.scheduler.resumeAutomation();
        await this.db.setSetting('automation_paused', 'false');
      } else {
        return res.status(400).json({ error: 'Action must be pause or resume' });
      }
      return res.json({ success: true, paused: !this.scheduler.isEnabled });
    });

    this.app.put('/api/settings', protect, async (req, res) => {
      const allowed = [
        'approval_required', 'notification_enabled', 'channel_timezone', 'max_daily_posts', 'content_buffer_days',
        'setup_completed_at', 'daily_content_enabled', 'auto_publish_enabled', 'auto_upload', 'auto_public_publishing',
        'video_resolution', 'video_aspect_ratio', 'language', 'video_style', 'target_audience', 'niche'
      ];
      for (const key of allowed) {
        if (req.body?.[key] !== undefined) await this.db.setSetting(key, String(req.body[key]));
      }
      const provider = req.body?.video_provider;
      if (provider !== undefined) {
        const supported = ['slideshow', 'auto', 'seedance', 'minimax_h3', 'google_omni', 'kling', 'wan'];
        if (!supported.includes(provider)) return res.status(400).json({ error: 'Unsupported video provider' });
        await this.db.setSetting('video_provider', provider);
      }
      const mode = req.body?.video_generation_mode;
      if (mode !== undefined) {
        if (!['hybrid', 'slideshow'].includes(mode)) return res.status(400).json({ error: 'Unsupported video generation mode' });
        await this.db.setSetting('video_generation_mode', mode);
      }
      if (req.body?.video_clip_duration !== undefined) {
        const value = Number(req.body.video_clip_duration);
        if (!Number.isInteger(value) || value < 3 || value > 30) return res.status(400).json({ error: 'Clip duration must be between 3 and 30 seconds' });
        await this.db.setSetting('video_clip_duration', String(value));
      }
      if (req.body?.video_max_generated_seconds !== undefined) {
        const value = Number(req.body.video_max_generated_seconds);
        if (!Number.isInteger(value) || value < 0 || value > 600) return res.status(400).json({ error: 'Generated seconds cap must be between 0 and 600' });
        await this.db.setSetting('video_max_generated_seconds', String(value));
      }
      return res.json({ success: true, result: await this.db.getAllSettings() });
    });

    this.app.post('/api/notifications/:notificationId/read', protect, async (req, res) => {
      await this.db.markNotificationRead(req.params.notificationId);
      return res.json({ success: true });
    });
  }

  async startGenerationJob(input = {}) {
    if (this.setupRequired || !this.agents.strategy) {
      const error = new Error('Finish setup with npm run walkthrough before generating content');
      error.status = 503;
      throw error;
    }
    if (['scheduler', 'autonomous_operator'].includes(input.source)) {
      await this.readiness?.assertReady('Automated generation');
    }
    const maxConcurrent = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10));
    if (this.activeJobs.size >= maxConcurrent) {
      const error = new Error(`Generation is busy (${this.activeJobs.size}/${maxConcurrent} active jobs). Try again when the current job finishes.`);
      error.status = 429;
      throw error;
    }

    const validation = this.validateGenerateRequestBody(input);
    if (!validation.valid) {
      const error = new Error(validation.error);
      error.status = validation.status;
      throw error;
    }

    const job = await this.db.createGenerationJob({
      ...validation.value,
      source: input.source || 'manual'
    });

    const work = this.runGenerationJob(job.id, validation.value)
      .catch(error => this.logger.error(`Generation job ${job.id} failed:`, error))
      .finally(() => this.activeJobs.delete(job.id));
    this.activeJobs.set(job.id, work);
    return job;
  }

  async resumeGenerationJob(jobId, options = {}) {
    if (this.setupRequired || !this.agents.strategy) {
      const error = new Error('Finish setup with npm run walkthrough before resuming content generation');
      error.status = 503;
      throw error;
    }
    const job = await this.db.getGenerationJob(jobId);
    if (!job) {
      const error = new Error('Generation job not found');
      error.status = 404;
      throw error;
    }
    if (!['failed', 'interrupted'].includes(job.status)) {
      const error = new Error('Only failed or interrupted generation jobs can be resumed');
      error.status = 409;
      throw error;
    }
    if (this.activeJobs.has(job.id)) {
      const error = new Error('This generation job is already running');
      error.status = 409;
      throw error;
    }
    const maxConcurrent = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10));
    if (this.activeJobs.size >= maxConcurrent) {
      const error = new Error(`Generation is busy (${this.activeJobs.size}/${maxConcurrent} active jobs). Try again when the current job finishes.`);
      error.status = 429;
      throw error;
    }
    if (['scheduler', 'autonomous_operator'].includes(job.source)) {
      await this.readiness?.assertReady('Automated generation recovery');
    }

    const checkpoints = await this.db.listGenerationCheckpoints(job.id);
    const resumeFrom = options.stage || this.recovery.resumePoint(checkpoints);
    if (!GENERATION_STAGES.includes(resumeFrom)) {
      const error = new Error('Resume stage is not supported');
      error.status = 400;
      throw error;
    }
    if (options.stage) await this.recovery.resetFrom(job.id, resumeFrom);
    const input = {
      topic: job.topic,
      style: job.style,
      length: job.length || 'medium',
      strategyContext: job.details?.strategyContext || {}
    };
    const updated = await this.db.updateGenerationJob(job.id, {
      status: 'queued',
      stage: resumeFrom,
      error: null,
      cancelRequested: false,
      completedAt: null,
      details: {
        resumeCount: Number(job.details?.resumeCount || 0) + 1,
        resumeFrom,
        failedStage: null
      }
    });
    const work = this.runGenerationJob(job.id, input)
      .catch(error => this.logger.error(`Resumed generation job ${job.id} failed:`, error))
      .finally(() => this.activeJobs.delete(job.id));
    this.activeJobs.set(job.id, work);
    return updated;
  }

  async waitForGenerationJob(jobId) {
    const work = this.activeJobs.get(jobId);
    if (work) await work;
    const job = await this.db.getGenerationJob(jobId);
    if (!job) throw new Error(`Generation job ${jobId} was not found after it ran`);
    return job;
  }

  async queueScheduledContent(input = {}) {
    const strategy = await this.db.getChannelStrategy();
    if (strategy?.status === 'active') {
      const weeklyOutput = await this.db.getRow(
        `SELECT COUNT(*) AS count FROM generation_jobs
         WHERE source = 'autonomous_operator' AND status = 'completed'
         AND created_at >= datetime('now', '-7 days')`
      );
      const remaining = Math.max(1, strategy.cadence_per_week - Number(weeklyOutput?.count || 0));
      return this.autonomous.start({
        ...strategy,
        videos_per_run: Math.min(strategy.videos_per_run, remaining)
      });
    }
    return this.startGenerationJob(input);
  }

  async runGenerationJob(jobId, input) {
    try {
      await this.db.updateGenerationJob(jobId, { status: 'running', progress: 2, error: null, completedAt: null });
      const result = await this.generateContent(input.topic, input.style, input.length, {
        jobId,
        strategyContext: input.strategyContext
      });
      await this.db.updateGenerationJob(jobId, {
        status: 'completed',
        stage: result.reviewStatus === 'approved' ? 'scheduled' : result.reviewStatus,
        progress: 100,
        productionId: result.contentId,
        title: result.title,
        details: { reviewStatus: result.reviewStatus, qualityScore: result.qualityScore },
        completedAt: new Date().toISOString()
      });
      await this.db.setSetting('last_content_generation', new Date().toISOString());
      return result;
    } catch (error) {
      const cancelled = error.code === 'JOB_CANCELLED';
      const current = await this.db.getGenerationJob(jobId);
      const failedStage = current?.stage || 'starting';
      await this.db.updateGenerationJob(jobId, {
        status: cancelled ? 'cancelled' : 'failed',
        stage: failedStage,
        error: error.message,
        details: { failedStage },
        completedAt: new Date().toISOString()
      });
      await this.operator.notify({
        type: cancelled ? 'generation_cancelled' : 'generation_failure',
        level: cancelled ? 'warning' : 'error',
        title: cancelled ? 'Generation cancelled' : 'Generation failed',
        message: error.message,
        data: { jobId }
      });
      throw error;
    }
  }

  async updateJobStage(jobId, stage, progress, details = {}) {
    if (!jobId) return;
    const job = await this.db.getGenerationJob(jobId);
    if (job?.cancelRequested) {
      const error = new Error(job.details?.cancelReason || 'Generation cancelled by operator');
      error.code = 'JOB_CANCELLED';
      throw error;
    }
    await this.db.updateGenerationJob(jobId, { stage, progress, details });
  }

  async generateContent(topic = null, style = null, length = 'medium', options = {}) {
    this.logger.info('Starting content generation pipeline...');
    const { jobId = null, strategyContext: rawStrategyContext = {} } = options;
    const strategyContext = rawStrategyContext || {};
    const profile = await this.db.getChannelProfile() || {};
    const lengthLabels = { short: '2-4 minutes', medium: '8-12 minutes', long: '15-20 minutes' };

    // Step 1: Strategy
    const strategy = await this.runGenerationStage(jobId, 'strategy', 10, async () => {
      const generated = await this.agents.strategy.generateContentStrategy(topic);
      const contentStyles = new Set(['tutorial', 'explainer', 'list', 'review', 'story']);
      const requestedStyle = style || profile.default_style || null;
      if (requestedStyle && contentStyles.has(requestedStyle.toLowerCase())) {
        generated.contentType = requestedStyle.charAt(0).toUpperCase() + requestedStyle.slice(1).toLowerCase();
      }
      generated.requestedStyle = requestedStyle;
      generated.requestedLengthKey = length;
      generated.requestedLength = lengthLabels[length] || lengthLabels.medium;
      generated.angle = strategyContext.angle || generated.angle;
      generated.planRationale = strategyContext.rationale || null;
      generated.targetAudience = strategyContext.audience || profile.target_audience || generated.targetAudience;
      generated.brandVoice = profile.brand_voice || null;
      generated.channelGoal = strategyContext.objective || profile.goal || null;
      generated.channelValueProposition = strategyContext.valueProposition || null;
      generated.channelConstraints = strategyContext.constraints || null;
      generated.contentPillar = strategyContext.pillar || null;
      generated.callToAction = profile.call_to_action || null;
      generated.researchSources = Array.isArray(strategyContext.researchSources)
        ? strategyContext.researchSources
        : [];
      return generated;
    });
    this.logger.info(`Strategy generated: ${strategy.topic}`);

    // Step 2: Script Writing
    const script = await this.runGenerationStage(
      jobId,
      'script',
      25,
      () => this.agents.scriptWriter.generateScript(strategy)
    );
    this.logger.info(`Script generated: ${script.title}`);

    // Step 3: Thumbnail Design
    const thumbnail = await this.runGenerationStage(
      jobId,
      'thumbnail',
      40,
      () => this.agents.thumbnailDesigner.generateThumbnail(script)
    );
    this.logger.info('Thumbnail generated');

    // Step 4: SEO Optimization
    const seoData = await this.runGenerationStage(
      jobId,
      'seo',
      52,
      () => this.agents.seoOptimizer.optimize(script, strategy)
    );
    this.logger.info('SEO optimization complete');

    // Step 5: Production Management
    const productionData = await this.runGenerationStage(
      jobId,
      'production',
      62,
      () => this.agents.production.processContent({ strategy, script, thumbnail, seo: seoData, jobId })
    );
    this.logger.info('Production processing complete');

    // Re-persist reused production artifacts in case a restart happened between checkpointing and persistence.
    const contentId = await this.db.saveProductionData(productionData);
    await this.db.saveProductionSnapshot(productionData);
    if (!this.provenance) this.provenance = new ProvenanceService(this.db);
    productionData.provenance = await this.provenance.initialize(contentId, productionData);
    productionData.discoverability = this.discoverability
      ? await this.discoverability.auditProduction(productionData, profile, 'youtube')
      : null;
    this.logger.info(`Content saved with ID: ${contentId}`);

    // Step 6: Quality and approval gate
    return this.runGenerationStage(jobId, 'quality_review', 90, async () => {
      const approvalRequired = await this.db.getSetting('approval_required') !== 'false';
      const packagingExperiment = approvalRequired
        ? await this.preparePackagingExperiment(thumbnail, productionData, seoData, script)
        : null;
      const quality = await this.operator.runQualityChecks(productionData, profile);
      const reviewStatus = quality.passed
        ? (approvalRequired ? 'needs_review' : 'approved')
        : 'needs_attention';
      await this.db.saveContentReview(contentId, {
        status: reviewStatus,
        qualityChecks: quality.checks,
        editorData: packagingExperiment ? {
          packagingExperiment,
          selectedTitleVariant: 0,
          selectedThumbnailVariant: 0
        } : {},
        reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
        reviewedAt: approvalRequired ? null : new Date().toISOString()
      });

      let scheduleEntry = null;
      if (reviewStatus === 'approved') {
        scheduleEntry = await this.agents.publishing.scheduleContent(productionData);
        await this.db.updateProductionStatus(contentId, scheduleEntry ? 'scheduled' : productionData.status);
        
        // Immediate Auto-Upload
        const autoUpload = await this.db.getSetting('auto_upload') !== 'false';
        if (autoUpload && scheduleEntry && this.agents.publishing) {
          this.logger.info(`Auto-upload enabled. Triggering immediate publishing for: ${contentId}`);
          this.agents.publishing.publishContent(contentId).catch(err => {
            this.logger.error(`Auto-upload failed for ${contentId}:`, err);
          });
        }
      } else {
        await this.db.updateProductionStatus(contentId, reviewStatus);
        await this.operator.notify({
          type: 'review_required',
          level: quality.passed ? 'info' : 'warning',
          title: quality.passed ? 'Content ready for review' : 'Content needs attention',
          message: `${script.title} ${quality.passed ? 'is ready for approval' : 'failed one or more quality checks'}`,
          data: { contentId, qualityScore: quality.score }
        });
      }

      return {
        contentId,
        title: script.title,
        status: productionData.status,
        reviewStatus,
        qualityScore: quality.score,
        scheduledFor: scheduleEntry ? scheduleEntry.publishTime : null
      };
    });
  }

  async runGenerationStage(jobId, stage, progress, producer) {
    if (!jobId) {
      await this.updateJobStage(jobId, stage, progress);
      return producer();
    }
    if (!this.recovery) {
      this.recovery = new GenerationRecoveryService(this.db, {
        logger: this.logger,
        updateJobStage: (...args) => this.updateJobStage(...args)
      });
    }
    return this.recovery.run(jobId, stage, progress, producer);
  }

  validateEditorData(input = {}, existing = {}) {
    const output = { ...existing };
    if (input.title !== undefined) {
      const title = String(input.title).trim();
      if (!title || title.length > 100) throw new Error('Title must be between 1 and 100 characters');
      output.title = title;
    }
    if (input.description !== undefined) {
      const description = String(input.description).trim();
      if (description.length > 5000) throw new Error('Description must be 5,000 characters or less');
      output.description = description;
    }
    if (input.tags !== undefined) {
      const tags = Array.isArray(input.tags)
        ? input.tags
        : String(input.tags).split(',');
      output.tags = tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 30);
    }
    if (input.publishTime !== undefined) {
      const date = new Date(input.publishTime);
      if (Number.isNaN(date.getTime())) throw new Error('Publish time must be a valid date');
      output.publishTime = date.toISOString();
    }
    if (input.privacyStatus !== undefined) {
      if (!['private', 'unlisted', 'public'].includes(input.privacyStatus)) throw new Error('Invalid privacy status');
      output.privacyStatus = input.privacyStatus;
    }
    if (input.factChecked !== undefined) output.factChecked = input.factChecked === true;
    if (input.rightsConfirmed !== undefined) output.rightsConfirmed = input.rightsConfirmed === true;
    const experiment = output.packagingExperiment;
    if (input.selectedTitleVariant !== undefined) {
      const selected = Number(input.selectedTitleVariant);
      if (!Number.isInteger(selected) || !experiment?.titleVariants?.[selected]) {
        throw new Error('Selected title variant is invalid');
      }
      output.selectedTitleVariant = selected;
    }
    if (input.selectedThumbnailVariant !== undefined) {
      const selected = Number(input.selectedThumbnailVariant);
      if (!Number.isInteger(selected) || !experiment?.thumbnailVariants?.[selected]) {
        throw new Error('Selected thumbnail variant is invalid');
      }
      output.selectedThumbnailVariant = selected;
    }
    return output;
  }

  buildTitleExperimentVariants(title) {
    const control = String(title || '').trim().slice(0, 100);
    const withoutPunctuation = control.replace(/[.!?]+$/, '');
    return [
      { label: 'Control', title: control },
      { label: 'Step-by-step', title: `${withoutPunctuation}: Step-by-Step`.slice(0, 100) },
      { label: 'Curiosity', title: `${withoutPunctuation}: What Most People Miss`.slice(0, 100) }
    ];
  }

  async preparePackagingExperiment(thumbnail, productionData, seoData, script) {
    const approved = await this.db.listLearningRecommendations({ status: 'approved', limit: 25 });
    const recommendation = approved.find(item => item.proposedChange?.experiment === 'title_thumbnail_variant');
    if (!recommendation) return null;
    try {
      const generated = await this.agents.thumbnailDesigner.generateABVariants(thumbnail.concept);
      return {
        sourceRecommendationId: recommendation.id,
        hypothesis: recommendation.title,
        status: 'draft',
        titleVariants: this.buildTitleExperimentVariants(seoData.title || script.title),
        thumbnailVariants: [
          { label: 'Control', path: productionData.assets?.thumbnail?.path, concept: thumbnail.concept },
          ...generated
        ],
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      this.logger.warn(`Packaging experiment preparation failed without blocking production: ${error.message}`);
      return null;
    }
  }

  validateProfile(input) {
    const textFields = ['channelName', 'goal', 'targetAudience', 'brandVoice', 'defaultStyle', 'callToAction', 'visualStyle', 'timezone'];
    const result = {};
    for (const field of textFields) {
      if (input[field] !== undefined) {
        const value = String(input[field]).trim();
        if (value.length > 500) throw new Error(`${field} is too long`);
        result[field] = value;
      }
    }
    if (input.bannedTopics !== undefined) {
      const topics = Array.isArray(input.bannedTopics) ? input.bannedTopics : String(input.bannedTopics).split(',');
      result.bannedTopics = topics.map(topic => String(topic).trim()).filter(Boolean).slice(0, 50);
    }
    return result;
  }

  decorateContentBundle(bundle) {
    const experiment = bundle.editorData?.packagingExperiment;
    const sceneLabels = new Map((bundle.scenes || []).map(scene => [scene.id, scene.label]));
    return {
      ...bundle,
      scenes: (bundle.scenes || []).map(scene => this.scenes
        ? this.scenes.decorateScene(scene, bundle.id)
        : scene),
      shorts: (bundle.shorts || []).map(clip => ({
        ...clip,
        sourceSceneLabels: clip.sourceSceneIds.map(id => sceneLabels.get(id)).filter(Boolean),
        assetUrls: {
          video: clip.outputPath ? `/api/content/${bundle.id}/shorts/${clip.id}/asset/video` : null,
          captions: clip.captionsPath ? `/api/content/${bundle.id}/shorts/${clip.id}/asset/captions` : null
        }
      })),
      assetUrls: {
        video: bundle.assets?.finalVideo?.path && !bundle.assets?.finalVideo?.simulated ? `/api/content/${bundle.id}/asset/video` : null,
        thumbnail: bundle.assets?.thumbnail?.path && !bundle.assets?.thumbnail?.simulated ? `/api/content/${bundle.id}/asset/thumbnail` : null,
        experimentThumbnails: (experiment?.thumbnailVariants || []).map((_variant, index) =>
          `/api/content/${bundle.id}/asset/experiment-thumbnail-${index}`
        ),
        audio: bundle.assets?.audio?.path && !bundle.assets?.audio?.simulated ? `/api/content/${bundle.id}/asset/audio` : null,
        captions: bundle.assets?.captions?.path ? `/api/content/${bundle.id}/asset/captions` : null,
        script: bundle.assets?.script?.originalPath ? `/api/content/${bundle.id}/asset/script` : null
      }
    };
  }

  async refreshContentReview(productionId, reviewNotes) {
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) return null;
    const profile = await this.db.getChannelProfile() || {};
    const quality = await this.operator.runQualityChecks({
      ...bundle,
      scheduledPublishTime: bundle.scheduled_publish_time
    }, profile);
    const status = quality.passed ? 'needs_review' : 'needs_attention';
    return this.db.saveContentReview(productionId, {
      status,
      editorData: { ...(bundle.editorData || {}), factChecked: false, rightsConfirmed: false },
      qualityChecks: quality.checks,
      reviewNotes: reviewNotes || (quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`),
      reviewedAt: null
    });
  }

  async approveContent(productionId, input) {
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) {
      const error = new Error('Content not found');
      error.status = 404;
      throw error;
    }
    if (bundle.schedule?.status === 'published') {
      const error = new Error('Content is already published');
      error.status = 409;
      throw error;
    }

    const editorData = this.validateEditorData(input, bundle.editorData);
    const packagingExperiment = editorData.packagingExperiment;
    const thumbnailVariant = packagingExperiment?.thumbnailVariants?.[editorData.selectedThumbnailVariant];
    const titleVariant = packagingExperiment?.titleVariants?.[editorData.selectedTitleVariant];
    if (titleVariant && input.title === undefined) editorData.title = titleVariant.title;
    if (!editorData.factChecked || !editorData.rightsConfirmed) {
      const error = new Error('Confirm the factual review and media rights checks before approval');
      error.status = 409;
      throw error;
    }
    const productionData = {
      id: bundle.id,
      status: bundle.status,
      strategy: bundle.strategy,
      script: { ...bundle.script, title: editorData.title || bundle.script.title },
      thumbnail: bundle.thumbnail,
      seo: {
        ...bundle.seo,
        title: editorData.title || bundle.seo.title,
        description: editorData.description || bundle.seo.description,
        tags: editorData.tags || bundle.seo.tags
      },
      assets: thumbnailVariant
        ? { ...bundle.assets, thumbnail: { ...bundle.assets.thumbnail, path: thumbnailVariant.path } }
        : bundle.assets,
      timeline: bundle.timeline,
      scheduledPublishTime: editorData.publishTime || input.publishTime || bundle.scheduled_publish_time,
      priority: bundle.priority,
      estimatedDuration: bundle.estimated_duration,
      privacyStatus: editorData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
      provenance: bundle.provenance,
      containsSyntheticMedia: bundle.provenance?.containsSyntheticMedia === true,
      scenes: bundle.scenes || []
    };
    const profile = await this.db.getChannelProfile() || {};
    const quality = await this.operator.runQualityChecks(productionData, profile);
    if (!quality.passed) {
      await this.db.saveContentReview(bundle.id, {
        status: 'needs_attention', editorData, qualityChecks: quality.checks,
        reviewNotes: `Blocking checks failed: ${quality.blockingFailures.join(', ')}`
      });
      const error = new Error('Content still has blocking quality failures');
      error.status = 409;
      error.quality = quality;
      throw error;
    }

    let scheduleEntry = bundle.schedule;
    if (!scheduleEntry) {
      scheduleEntry = await this.agents.publishing.scheduleContent(productionData);
    } else if (scheduleEntry.status !== 'published') {
      scheduleEntry.title = productionData.script.title;
      scheduleEntry.publishTime = productionData.scheduledPublishTime;
      scheduleEntry.status = 'scheduled';
      scheduleEntry.metadata = {
        ...scheduleEntry.metadata,
        seo: productionData.seo,
        thumbnail: productionData.assets.thumbnail,
        video: productionData.assets.finalVideo,
        audio: productionData.assets.audio,
        captions: productionData.assets.captions,
        privacyStatus: editorData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
        containsSyntheticMedia: productionData.containsSyntheticMedia
      };
      await this.db.updateScheduleEntry(scheduleEntry);
      await this.agents.publishing.loadPublishQueue();
    }
    if (!scheduleEntry) {
      const error = new Error('A real MP4 is required before content can be approved for scheduling');
      error.status = 409;
      throw error;
    }

    await this.db.saveContentReview(bundle.id, {
      status: 'approved', editorData, qualityChecks: quality.checks,
      reviewNotes: input.reviewNotes || 'Approved by operator', reviewedAt: new Date().toISOString()
    });
    await this.db.updateProductionStatus(bundle.id, 'scheduled');
    
    // Immediate Auto-Upload after manual approval
    const autoUpload = await this.db.getSetting('auto_upload') !== 'false';
    if (autoUpload && scheduleEntry && this.agents.publishing) {
      this.logger.info(`Auto-upload enabled. Triggering immediate publishing after approval for: ${bundle.id}`);
      this.agents.publishing.publishContent(bundle.id).catch(err => {
        this.logger.error(`Auto-upload failed for ${bundle.id}:`, err);
      });
    }

    await this.operator.notify({
      type: 'content_approved', level: 'success', title: 'Content approved',
      message: `${productionData.script.title} is scheduled for ${scheduleEntry.publishTime}`,
      data: { productionId, publishTime: scheduleEntry.publishTime }
    });
    return { productionId, reviewStatus: 'approved', qualityScore: quality.score, schedule: scheduleEntry };
  }

  async start() {
    const PORT = parseInt(process.env.PORT, 10) || 3000;
    const HOST = process.env.HOST || '0.0.0.0';

    // Configure API routes immediately so /health endpoint is live before heavy async init
    this.setupAPI();

    return new Promise((resolve, reject) => {
      let server;
      try {
        server = this.app.listen(PORT, HOST, () => {
          console.log(chalk.green(`\n✅ YouTube Automation Agent listening immediately on ${HOST}:${PORT}`));
          if (!isLoopbackHost(HOST) && !process.env.API_KEY) {
            console.log(chalk.yellow(`⚠️  HOST=${HOST} exposes the dashboard to your network without API_KEY. Set API_KEY in .env to protect generation, approval, and publishing routes.`));
          }
          console.log(chalk.gray('─'.repeat(50)));
          console.log(chalk.white('📊 Dashboard: ') + chalk.cyan(`http://localhost:${PORT}`));
          console.log(chalk.white('🔧 API Health: ') + chalk.cyan(`http://localhost:${PORT}/health`));
          console.log(chalk.white('📅 Schedule: ') + chalk.cyan(`http://localhost:${PORT}/schedule`));
          console.log(chalk.white('📈 Analytics: ') + chalk.cyan(`http://localhost:${PORT}/analytics`));
          console.log(chalk.gray('─'.repeat(50)));

          // Run heavy initialization asynchronously in background after server starts listening
          this.initPromise = this.initialize().catch(err => {
            this.logger.error('[Startup] Background initialization encountered unhandled error:', err);
            this.startupState = 'failed';
            this.startupError = err.message || String(err);
          });

          resolve(server);
        });

        if (server && typeof server.on === 'function') {
          server.on('error', (err) => {
            console.error(chalk.red.bold(`\n❌ Server failed to bind or listen on ${HOST}:${PORT}:`));
            console.error(chalk.red(err.stack || err));
            reject(err);
          });
        }

        this.server = server;
      } catch (listenErr) {
        console.error(chalk.red.bold(`\n❌ Exception while starting server on ${HOST}:${PORT}:`));
        console.error(chalk.red(listenErr.stack || listenErr));
        return reject(listenErr);
      }

      // Graceful shutdown handling
      let isShuttingDown = false;
      const shutdown = async (signal) => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log(chalk.yellow(`\n🛑 Received ${signal}, starting graceful shutdown...`));

        const forceTimeout = setTimeout(() => {
          console.error(chalk.red('⚠️  Graceful shutdown timed out, force exiting.'));
          process.exit(1);
        }, 10000);
        if (forceTimeout.unref) forceTimeout.unref();

        const closeServer = () => new Promise((res) => {
          if (server && typeof server.close === 'function') {
            server.close((err) => {
              if (err) console.error(chalk.red('Error closing HTTP server:'), err);
              else console.log(chalk.green('✓ HTTP server closed'));
              res();
            });
          } else {
            res();
          }
        });

        try {
          await closeServer();

          if (this.scheduler?.stopAutomation) {
            await this.scheduler.stopAutomation();
            console.log(chalk.green('✓ Automation scheduler stopped'));
          }

          if (this.db?.close) {
            await this.db.close();
            console.log(chalk.green('✓ Database connection closed'));
          }
        } catch (err) {
          console.error(chalk.red('Error during shutdown cleanup:'), err);
        } finally {
          clearTimeout(forceTimeout);
          process.exit(0);
        }
      };

      process.once('SIGTERM', () => shutdown('SIGTERM'));
      process.once('SIGINT', () => shutdown('SIGINT'));
    });
  }
}

// Global crash diagnostics
process.on('uncaughtException', (err) => {
  console.error(chalk.red.bold('\n💥 UNCAUGHT EXCEPTION:'));
  console.error(chalk.red(err.stack || err));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(chalk.red.bold('\n💥 UNHANDLED PROMISE REJECTION:'));
  console.error(chalk.red(reason?.stack || reason));
  process.exit(1);
});

// Start the agent
if (require.main === module) {
  const agent = new YouTubeAutomationAgent();
  agent.start().catch(error => {
    console.error(chalk.red.bold('\n❌ Fatal startup error:'));
    console.error(chalk.red(error.stack || error));
    process.exit(1);
  });
}

module.exports = { YouTubeAutomationAgent };
