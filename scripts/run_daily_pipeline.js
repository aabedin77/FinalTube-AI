const path = require('path');
const fs = require('fs').promises;
require('dotenv').config();

const { Database } = require('../database/db');
const { CredentialManager } = require('../utils/credential-manager');
const { Logger } = require('../utils/logger');
const { inspectMediaFile } = require('../utils/ffmpeg');
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('../agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('../agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('../agents/production-management-agent');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');

const logger = new Logger('DailyPipeline');

/**
 * Returns current date string formatted in Asia/Kolkata (IST) timezone (YYYY-MM-DD)
 */
function getKolkataDateString(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Retry helper for transient API calls
async function withRetry(fn, retries = 3, delayMs = 3000, description = 'Operation') {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      logger.warn(`${description} failed (Attempt ${attempt}/${retries}): ${err.message}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delayMs * attempt));
      }
    }
  }
  throw lastError;
}

// GitHub Step Summary helper
async function writeGitHubSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
    } catch (_e) {}
  }
}

/**
 * Queries YouTube Data API to check whether a video was already published today (Asia/Kolkata date)
 */
async function checkYouTubeDuplicateToday(publishingAgent) {
  try {
    const youtube = publishingAgent.getYouTubeClient ? publishingAgent.getYouTubeClient() : null;
    if (!youtube) return { alreadyUploaded: false };

    const todayKolkata = getKolkataDateString();
    
    // Search mine videos
    const response = await youtube.search.list({
      part: 'snippet',
      forMine: true,
      type: 'video',
      maxResults: 25,
      order: 'date'
    });

    const items = response.data?.items || [];
    for (const item of items) {
      const publishedAtRaw = item.snippet?.publishedAt;
      if (!publishedAtRaw) continue;
      
      const itemKolkataDate = getKolkataDateString(new Date(publishedAtRaw));
      if (itemKolkataDate === todayKolkata) {
        return {
          alreadyUploaded: true,
          videoTitle: item.snippet?.title || 'Today Video',
          videoId: item.id?.videoId,
          publishedAt: publishedAtRaw,
          kolkataDate: itemKolkataDate
        };
      }
    }
  } catch (err) {
    logger.warn(`Could not query YouTube channel upload history: ${err.message}`);
  }
  return { alreadyUploaded: false };
}

async function runDailyPipeline() {
  const todayKolkataStr = getKolkataDateString();
  const dailyJobId = `imaginex_daily_${todayKolkataStr}`;

  console.log('====================================================');
  console.log('🚀 IMAGINEX AUTONOMOUS DAILY YOUTUBE PIPELINE');
  console.log(`📅 Target Date (Asia/Kolkata): ${todayKolkataStr} | Job ID: ${dailyJobId}`);
  console.log('⏰ Target Schedule: 06:00 AM Asia/Kolkata');
  console.log('====================================================\n');

  const startTime = Date.now();
  const db = new Database();
  await db.initialize();

  const credentials = new CredentialManager();
  await credentials.initialize();

  // Ensure ImagineX channel profile and settings are pre-seeded on fresh runner VM
  let profile = await db.getChannelProfile();
  if (!profile || !profile.channel_name) {
    await db.saveChannelProfile({
      channelName: 'ImagineX',
      visualStyle: 'Cinematic 2D illustrations in 1080p 16:9',
      brandVoice: 'Informative, engaging, and cinematic in Hindi',
      goal: 'Engage Indian audience with hypothetical What-If scenarios'
    });
    profile = await db.getChannelProfile();
  }

  let strategyRecord = await db.getChannelStrategy();
  if (!strategyRecord) {
    await db.saveChannelStrategy({
      objective: 'Grow ImagineX YouTube channel using AI automation',
      audience: 'Indian audience & WHAT IF fans in Hindi',
      contentPillars: ['Science', 'Space', 'Apocalypse', 'Humanity', 'Alternate Reality'],
      status: 'active'
    });
  }

  await db.setSetting('setup_completed_at', new Date().toISOString());
  await db.setSetting('daily_content_enabled', 'true');
  await db.setSetting('auto_publish_enabled', 'true');
  await db.setSetting('auto_public_publishing', 'true');
  await db.setSetting('video_resolution', '1080p');

  const privacyStatus = process.env.DEFAULT_PRIVACY_STATUS || 'public';
  const channelName = profile?.channel_name || 'ImagineX';

  logger.info(`Channel: ${channelName}`);
  logger.info(`Publishing Mode: ${privacyStatus.toUpperCase()}`);
  logger.info(`Timezone: Asia/Kolkata (IST)`);

  // Initialize Agents
  const strategyAgent = new ContentStrategyAgent(db, credentials);
  const scriptWriterAgent = new ScriptWriterAgent(db, credentials);
  const thumbnailDesignerAgent = new ThumbnailDesignerAgent(db, credentials);
  const seoOptimizerAgent = new SEOOptimizerAgent(db, credentials);
  const productionAgent = new ProductionManagementAgent(db, credentials);
  const publishingAgent = new PublishingSchedulingAgent(db, credentials);

  await Promise.all([
    strategyAgent.initialize(),
    scriptWriterAgent.initialize(),
    thumbnailDesignerAgent.initialize(),
    seoOptimizerAgent.initialize(),
    productionAgent.initialize(),
    publishingAgent.initialize()
  ]);

  // DUPLICATE UPLOAD PRE-CHECK against YouTube API
  if (credentials.hasPublishingCapability()) {
    logger.info('Checking YouTube channel upload history for today (Asia/Kolkata)...');
    const dupCheck = await checkYouTubeTodayUploads(publishingAgent);
    if (dupCheck.alreadyUploaded) {
      const msg = `Today's video ("${dupCheck.videoTitle}") was already published to ImagineX YouTube channel on ${dupCheck.kolkataDate} (Video ID: ${dupCheck.videoId}).`;
      logger.success(msg);
      await writeGitHubSummary(`### ⏭ Skip Duplicate Upload\n\n${msg}\n\n- **Video ID**: \`${dupCheck.videoId}\`\n- **Published At**: \`${dupCheck.publishedAt}\``);
      console.log('====================================================');
      console.log('🎉 PIPELINE COMPLETED: TODAY VIDEO ALREADY PUBLISHED');
      console.log('====================================================\n');
      process.exit(0);
    }
  }

  const report = {
    jobId: dailyJobId,
    channel: channelName,
    privacyStatus,
    timestamp: new Date().toISOString(),
    stages: {}
  };

  try {
    // STAGE 1: Strategy Research & Topic Selection
    logger.info('\n[1/6] Researching & selecting Hindi What-If topic...');
    const strategy = await withRetry(
      () => strategyAgent.generateContentStrategy(),
      3, 3000, 'Content Strategy Research'
    );
    logger.success(`Topic Selected: "${strategy.topic}" (Pillar: ${strategy.contentPillar || 'Science'})`);
    report.stages.strategy = { status: 'SUCCESS', topic: strategy.topic };

    // STAGE 2: 8-12 Minute Hindi Scriptwriting
    logger.info('\n[2/6] Writing engaging Hindi script...');
    const script = await withRetry(
      () => scriptWriterAgent.generateScript(strategy),
      3, 3000, 'Script Writing'
    );
    logger.success(`Script Created: "${script.title}" (${script.mainContent?.sections?.length || 0} sections)`);
    report.stages.script = { status: 'SUCCESS', title: script.title, duration: script.duration };

    // STAGE 3: Thumbnail Design
    logger.info('\n[3/6] Generating custom thumbnail prompt...');
    const thumbnail = await thumbnailDesignerAgent.generateThumbnail(script);
    logger.success(`Thumbnail Prompt Ready: "${thumbnail.title || script.title}"`);
    report.stages.thumbnail = { status: 'SUCCESS', title: thumbnail.title };

    // STAGE 4: SEO Metadata Optimization
    logger.info('\n[4/6] Optimizing SEO metadata (Title, Description, Tags, Hashtags)...');
    const seo = await seoOptimizerAgent.optimize(script, strategy);
    logger.success(`SEO Optimized: Title="${seo.title}" (${seo.tags?.length || 0} tags)`);
    report.stages.seo = { status: 'SUCCESS', title: seo.title };

    // STAGE 5: Full 1080p 16:9 Video Production
    logger.info('\n[5/6] Generating 2D illustrations, Hindi narration & FFmpeg 1080p MP4 rendering...');
    const productionData = await productionAgent.processContent({
      strategy,
      script,
      thumbnail,
      seo,
      jobId: dailyJobId
    });

    const mp4Path = productionData.assets?.finalVideo?.path || 
                    productionData.assets?.videoPath || 
                    productionData.assets?.video || 
                    (typeof productionData.videoFile === 'string' ? productionData.videoFile : null);

    // STRICT MEDIA QUALITY VALIDATION
    if (productionData.status === 'simulated' || !mp4Path || String(mp4Path).endsWith('.json')) {
      throw new Error(`Video production produced simulated/placeholder output. Ensure GEMINI_API_KEY is configured.`);
    }

    const inspection = await inspectMediaFile(mp4Path);
    if (!inspection.valid) {
      throw new Error(`Strict Quality Validation Failed: ${inspection.error}`);
    }

    logger.success(`Video Render Verified: ${mp4Path} (${inspection.sizeMb} MB | Resolution: ${inspection.width}x${inspection.height})`);
    report.stages.production = {
      status: 'SUCCESS',
      mp4Path,
      fileSizeMb: inspection.sizeMb,
      durationSec: inspection.duration,
      resolution: `${inspection.width}x${inspection.height}`
    };

    // STAGE 6: Direct YouTube Upload & Visibility Setup
    logger.info('\n[6/6] Uploading to ImagineX YouTube channel & applying PUBLIC visibility...');
    await publishingAgent.scheduleContent(productionData);
    
    let youtubeId = null;
    let youtubeUrl = null;

    if (credentials.hasPublishingCapability() && productionData.status !== 'simulated') {
      const publishResult = await publishingAgent.publishContent(productionData.id, {
        publishNow: true,
        privacyStatus
      });
      youtubeId = publishResult.youtubeId || publishResult.id;
      youtubeUrl = publishResult.youtubeUrl || (youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : null);
      logger.success(`YouTube Upload Verified! Video ID: ${youtubeId} | URL: ${youtubeUrl}`);
      report.stages.publishing = { status: 'SUCCESS', youtubeId, youtubeUrl };
    } else {
      logger.warn('YouTube direct publishing offline or pending OAuth token authorization.');
      report.stages.publishing = { status: 'QUEUED_LOCAL', note: 'Connect YouTube OAuth in GitHub secrets to auto-upload.' };
    }

    // Write GitHub Step Summary
    const totalTimeSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const summaryMd = `
### 🎬 ImagineX Daily YouTube Pipeline - Success Report

- **Target Date (Asia/Kolkata)**: \`${todayKolkataStr}\`
- **Job ID**: \`${dailyJobId}\`
- **Duration**: \`${totalTimeSec}s\`
- **Topic**: ${strategy.topic}
- **Video Resolution**: \`${inspection.width}x${inspection.height}\`
- **File Size**: \`${inspection.sizeMb} MB\`
- **Visibility**: \`${privacyStatus.toUpperCase()}\`
${youtubeUrl ? `- **YouTube URL**: [${youtubeUrl}](${youtubeUrl})` : `- **Local File**: \`${mp4Path}\``}
`;
    await writeGitHubSummary(summaryMd);

    console.log('\n====================================================');
    console.log('🎉 IMAGINEX DAILY PIPELINE COMPLETED SUCCESSFULLY!');
    console.log(`⏱ Total Duration: ${totalTimeSec} seconds`);
    console.log(`📹 Topic: ${strategy.topic}`);
    if (youtubeUrl) {
      console.log(`🔗 YouTube URL: ${youtubeUrl}`);
      console.log(`🌐 Visibility: ${privacyStatus.toUpperCase()}`);
    } else {
      console.log(`📁 Rendered MP4 File: ${mp4Path}`);
    }
    console.log('====================================================\n');

    process.exit(0);

  } catch (error) {
    logger.error('CRITICAL PIPELINE FAILURE:', error);
    const summaryMd = `
### ❌ ImagineX Daily YouTube Pipeline - Failure Report

- **Target Date (Asia/Kolkata)**: \`${todayKolkataStr}\`
- **Job ID**: \`${dailyJobId}\`
- **Error**: \`${error.message}\`

\`\`\`json
${JSON.stringify(report, null, 2)}
\`\`\`
`;
    await writeGitHubSummary(summaryMd);

    console.log('\n====================================================');
    console.log('❌ PIPELINE FAILED - FAILURE REPORT');
    console.log(`Error: ${error.message}`);
    console.log(JSON.stringify(report, null, 2));
    console.log('====================================================\n');
    process.exit(1);
  }
}

runDailyPipeline().catch(err => {
  console.error('Unhandled fatal error in runDailyPipeline:', err);
  process.exit(1);
});
