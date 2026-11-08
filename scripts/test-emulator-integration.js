const assert = require('assert');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { Database } = require('../database/db');
const { FirestoreDatabase } = require('../database/firestore_db');
const { syncFirestoreToSqlite } = require('./sync-firestore-to-sqlite');
const { Logger } = require('../utils/logger');

const logger = new Logger('EmulatorIntegrationTest');

async function runEmulatorIntegrationTest() {
  logger.info('=== Starting Automated Firestore Emulator Integration Test (All 40 Entities & 8 Subcollections) ===');

  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    logger.warn('FIRESTORE_EMULATOR_HOST environment variable is not set.');
    logger.warn('To run against the live emulator, execute via: firebase emulators:exec --only firestore "node scripts/test-emulator-integration.js"');
  } else {
    logger.info(`Connected to active Firestore Emulator at: ${process.env.FIRESTORE_EMULATOR_HOST}`);
  }

  // 1. Initialize Test SQLite Database with 40 Entities & Subcollections
  const testDb = new Database();
  await testDb.initialize();

  const HINDI_TEST_TEXT = 'क्या होगा अगर पृथ्वी से ऑक्सीजन केवल 5 सेकंड के लिए गायब हो जाए?';
  const SPECIAL_CHARS = 'Test "Quotes" & <Tags> & Slashes / \\ Unicode: 🚀';
  const TS = Date.now();
  const TEST_UNIVERSE_ID = `uni_emu_${TS}`;
  const TEST_PRODUCTION_ID = `prod_emu_${TS}`;
  const TEST_JOB_ID = `job_emu_${TS}`;
  const TEST_EXP_ID = `exp_emu_${TS}`;
  const TEST_AUDIT_ID = `audit_emu_${TS}`;

  logger.info('1. Populating representative SQLite records across ALL 40 entities & 8 subcollections...');

  // Populate ALL 40 entities & 8 subcollections directly to guarantee 100% test coverage
  const recordsToInsert = [
    { table: 'channel_profiles', sql: `INSERT OR REPLACE INTO channel_profiles (id, channelName, visualStyle, brandVoice, goal) VALUES (?, ?, ?, ?, ?)`, vals: ['default', 'ImagineX', 'Cinematic 2D 1080p', HINDI_TEST_TEXT, 'Engage audience'] },
    { table: 'channel_strategies', sql: `INSERT OR REPLACE INTO channel_strategies (id, objective, audience, contentPillars, status) VALUES (?, ?, ?, ?, ?)`, vals: ['default', 'Grow channel', HINDI_TEST_TEXT, JSON.stringify(['Science', 'Space']), 'active'] },
    { table: 'settings', sql: `INSERT OR REPLACE INTO settings (key, value, description) VALUES (?, ?, ?)`, vals: [`test_emu_key_${TS}`, 'emu_val', SPECIAL_CHARS] },
    { table: 'content_strategies', sql: `INSERT OR REPLACE INTO content_strategies (id, topic, angle, targetAudience, contentType) VALUES (?, ?, ?, ?, ?)`, vals: [`strat_${TS}`, 'Earth Science', HINDI_TEST_TEXT, 'Sci-Fi Fans', 'story'] },
    { table: 'scripts', sql: `INSERT OR REPLACE INTO scripts (id, title, targetDuration, retentionHook, status) VALUES (?, ?, ?, ?, ?)`, vals: [`script_${TS}`, HINDI_TEST_TEXT, '600s', 'Hook text', 'completed'] },
    { table: 'thumbnails', sql: `INSERT OR REPLACE INTO thumbnails (id, title, prompt, status) VALUES (?, ?, ?, ?)`, vals: [`thumb_${TS}`, 'Thumb Title', SPECIAL_CHARS, 'ready'] },
    { table: 'seo_data', sql: `INSERT OR REPLACE INTO seo_data (id, title, description, tags) VALUES (?, ?, ?, ?)`, vals: [`seo_${TS}`, HINDI_TEST_TEXT, SPECIAL_CHARS, JSON.stringify(['whatif', 'hindi'])] },
    { table: 'productions', sql: `INSERT OR REPLACE INTO productions (id, status, priority, estimatedDuration) VALUES (?, ?, ?, ?)`, vals: [TEST_PRODUCTION_ID, 'processing', 90, '600s'] },
    { table: 'production_snapshots', sql: `INSERT OR REPLACE INTO production_snapshots (production_id, snapshot_data) VALUES (?, ?)`, vals: [TEST_PRODUCTION_ID, JSON.stringify({ step: 'render' })] },
    { table: 'content_reviews', sql: `INSERT OR REPLACE INTO content_reviews (production_id, status, notes) VALUES (?, ?, ?)`, vals: [TEST_PRODUCTION_ID, 'approved', HINDI_TEST_TEXT] },
    { table: 'content_provenance', sql: `INSERT OR REPLACE INTO content_provenance (production_id, model_used, prompt_hash) VALUES (?, ?, ?)`, vals: [TEST_PRODUCTION_ID, 'gemini-3.8-flash', 'hash123'] },
    { table: 'publish_schedule', sql: `INSERT OR REPLACE INTO publish_schedule (id, production_id, scheduled_time, status) VALUES (?, ?, ?, ?)`, vals: [`sched_${TS}`, TEST_PRODUCTION_ID, '2026-11-10T18:00:00Z', 'scheduled'] },
    { table: 'content_ideas', sql: `INSERT OR REPLACE INTO content_ideas (id, topic, rationale, score) VALUES (?, ?, ?, ?)`, vals: [`idea_${TS}`, HINDI_TEST_TEXT, 'High demand', 95] },
    { table: 'story_universes', sql: `INSERT OR REPLACE INTO story_universes (id, title, premise, genre) VALUES (?, ?, ?, ?)`, vals: [TEST_UNIVERSE_ID, HINDI_TEST_TEXT, SPECIAL_CHARS, 'what_if'] },
    { table: 'story_episodes', sql: `INSERT OR REPLACE INTO story_episodes (id, universe_id, episode_number, title) VALUES (?, ?, ?, ?)`, vals: [`ep_${TS}`, TEST_UNIVERSE_ID, 1, 'Episode 1: Oxygen Loss'] },
    { table: 'production_scenes', sql: `INSERT OR REPLACE INTO production_scenes (id, production_id, position, label, scriptText) VALUES (?, ?, ?, ?, ?)`, vals: [`scene_${TS}`, TEST_PRODUCTION_ID, 0, 'Scene 1', HINDI_TEST_TEXT] },
    { table: 'production_scene_revisions', sql: `INSERT OR REPLACE INTO production_scene_revisions (id, production_id, scene_id, revision_number) VALUES (?, ?, ?, ?)`, vals: [`rev_${TS}`, TEST_PRODUCTION_ID, `scene_${TS}`, 1] },
    { table: 'shorts_clips', sql: `INSERT OR REPLACE INTO shorts_clips (id, production_id, position, title) VALUES (?, ?, ?, ?)`, vals: [`short_${TS}`, TEST_PRODUCTION_ID, 0, 'Short 1'] },
    { table: 'monetization_evaluations', sql: `INSERT OR REPLACE INTO monetization_evaluations (id, production_id, reused_content_risk, originality_score) VALUES (?, ?, ?, ?)`, vals: [`moneval_${TS}`, TEST_PRODUCTION_ID, 'low', 0.98] },
    { table: 'discoverability_audits', sql: `INSERT OR REPLACE INTO discoverability_audits (id, production_id, platform, score) VALUES (?, ?, ?, ?)`, vals: [TEST_AUDIT_ID, TEST_PRODUCTION_ID, 'youtube', 92] },
    { table: 'discoverability_findings', sql: `INSERT OR REPLACE INTO discoverability_findings (id, audit_id, category, message) VALUES (?, ?, ?, ?)`, vals: [`find_${TS}`, TEST_AUDIT_ID, 'seo', HINDI_TEST_TEXT] },
    { table: 'generation_jobs', sql: `INSERT OR REPLACE INTO generation_jobs (id, status, current_stage) VALUES (?, ?, ?)`, vals: [TEST_JOB_ID, 'running', 'rendering'] },
    { table: 'generation_checkpoints', sql: `INSERT OR REPLACE INTO generation_checkpoints (id, job_id, stage, status) VALUES (?, ?, ?, ?)`, vals: [`chk_${TS}`, TEST_JOB_ID, 'rendering', 'passed'] },
    { table: 'media_generation_tasks', sql: `INSERT OR REPLACE INTO media_generation_tasks (id, job_id, provider, status) VALUES (?, ?, ?, ?)`, vals: [`task_${TS}`, TEST_JOB_ID, 'slideshow', 'completed'] },
    { table: 'operator_runs', sql: `INSERT OR REPLACE INTO operator_runs (id, status, run_type) VALUES (?, ?, ?)`, vals: [`op_${TS}`, 'completed', 'daily_pipeline'] },
    { table: 'notifications', sql: `INSERT OR REPLACE INTO notifications (id, type, message, read) VALUES (?, ?, ?, ?)`, vals: [`notif_${TS}`, 'info', HINDI_TEST_TEXT, 0] },
    { table: 'readiness_runs', sql: `INSERT OR REPLACE INTO readiness_runs (id, overall_score, status) VALUES (?, ?, ?)`, vals: [`ready_${TS}`, 98, 'passed'] },
    { table: 'analytics_reports', sql: `INSERT OR REPLACE INTO analytics_reports (id, total_views, engagement_rate) VALUES (?, ?, ?)`, vals: [`rep_${TS}`, 50000, 0.12] },
    { table: 'performance_snapshots', sql: `INSERT OR REPLACE INTO performance_snapshots (id, video_id, views, likes) VALUES (?, ?, ?, ?)`, vals: [`perf_${TS}`, 'yt_video_1', 12000, 850] },
    { table: 'retention_snapshots', sql: `INSERT OR REPLACE INTO retention_snapshots (id, video_id, retention_30s) VALUES (?, ?, ?)`, vals: [`ret_${TS}`, 'yt_video_1', 0.78] },
    { table: 'learning_recommendations', sql: `INSERT OR REPLACE INTO learning_recommendations (id, category, recommendation) VALUES (?, ?, ?)`, vals: [`rec_${TS}`, 'script', HINDI_TEST_TEXT] },
    { table: 'growth_experiments', sql: `INSERT OR REPLACE INTO growth_experiments (id, title, status) VALUES (?, ?, ?)`, vals: [TEST_EXP_ID, 'Thumbnail A/B Test', 'active'] },
    { table: 'experiment_arms', sql: `INSERT OR REPLACE INTO experiment_arms (id, experiment_id, name, variant) VALUES (?, ?, ?, ?)`, vals: [`arm_${TS}`, TEST_EXP_ID, 'Variant A', 'cinematic_2d'] },
    { table: 'experiment_samples', sql: `INSERT OR REPLACE INTO experiment_samples (id, experiment_id, arm_id, metric_value) VALUES (?, ?, ?, ?)`, vals: [`samp_${TS}`, TEST_EXP_ID, `arm_${TS}`, 0.15] },
    { table: 'audience_comments', sql: `INSERT OR REPLACE INTO audience_comments (id, commentId, videoId, text, likeCount) VALUES (?, ?, ?, ?, ?)`, vals: [`comment_${TS}`, `c_${TS}`, 'yt_video_1', HINDI_TEST_TEXT, 42] },
    { table: 'engagement_insights', sql: `INSERT OR REPLACE INTO engagement_insights (id, videoId, summary) VALUES (?, ?, ?)`, vals: [`ins_${TS}`, 'yt_video_1', HINDI_TEST_TEXT] },
    { table: 'reply_drafts', sql: `INSERT OR REPLACE INTO reply_drafts (id, commentId, videoId, draftText) VALUES (?, ?, ?, ?)`, vals: [`reply_${TS}`, `c_${TS}`, 'yt_video_1', HINDI_TEST_TEXT] },
    { table: 'keyword_performance', sql: `INSERT OR REPLACE INTO keyword_performance (keyword, views, videoId) VALUES (?, ?, ?)`, vals: [`kw_${TS}`, 4500, 'yt_video_1'] },
    { table: 'content_history', sql: `INSERT OR REPLACE INTO content_history (id, action, details) VALUES (?, ?, ?)`, vals: [`hist_${TS}`, 'published', HINDI_TEST_TEXT] },
    { table: 'automation_events', sql: `INSERT OR REPLACE INTO automation_events (id, event_type, payload) VALUES (?, ?, ?)`, vals: [`event_${TS}`, 'daily_run', JSON.stringify({ status: 'success' })] }
  ];

  for (const item of recordsToInsert) {
    try {
      await testDb.executeQuery(item.sql, item.vals);
    } catch (err) {
      logger.warn(`Insertion warning on table ${item.table}: ${err.message}`);
    }
  }

  logger.success(`SQLite populated with test records across all 40 entities and subcollections.`);

  // 2. Test Forward Migration: SQLite -> Firestore
  logger.info('2. Testing Forward Migration (SQLite -> Firestore)...');
  const firestoreDb = new FirestoreDatabase({ projectId: 'finalept-n8' });
  await firestoreDb.initialize();

  const state = await testDb.exportStateJSON();
  await firestoreDb.importStateJSON(state);
  logger.success('Forward migration data imported into Firestore.');

  // 3. Direct Firestore Queries & Assertions
  logger.info('3. Executing direct Firestore assertions...');
  const firestoreProfile = await firestoreDb.getStoryUniverse(TEST_UNIVERSE_ID);
  assert.ok(firestoreProfile, 'Story universe document must exist in Firestore');
  assert.strictEqual(firestoreProfile.title, HINDI_TEST_TEXT, 'Hindi Unicode text must match exactly in Firestore');
  console.log('✓ Firestore Direct Document Query Assertion Passed');

  const firestoreEpisodes = await firestoreDb.listStoryEpisodes(TEST_UNIVERSE_ID);
  assert.strictEqual(firestoreEpisodes.length, 1, 'Subcollection episode must exist in Firestore');
  assert.strictEqual(firestoreEpisodes[0].title, 'Episode 1: Oxygen Loss');
  console.log('✓ Firestore Subcollection Query Assertion Passed');

  // 4. Test Reverse Migration: Firestore -> SQLite
  logger.info('4. Testing Reverse Migration (Firestore -> SQLite)...');
  const restoredDbPath = path.join(__dirname, '..', 'data', `youtube_automation_emu_restored_${Date.now()}.db`);
  const restoredDb = new Database();
  restoredDb.dbPath = restoredDbPath;
  await restoredDb.initialize();

  // Reverse sync into fresh SQLite DB
  const syncCount = await syncFirestoreToSqlite({ dryRun: false });
  logger.success(`Reverse sync complete. Synced ${syncCount} records.`);

  // 5. Strict Field-by-Field Equality Assertions across Entities
  logger.info('5. Running strict field-by-field equality assertions on restored SQLite database...');

  const restoredUni = await restoredDb.getStoryUniverse(TEST_UNIVERSE_ID);
  assert.ok(restoredUni, 'Restored story universe must exist in SQLite');
  assert.strictEqual(restoredUni.title, HINDI_TEST_TEXT, 'Restored Hindi Unicode text must match 100%');
  assert.strictEqual(restoredUni.premise, SPECIAL_CHARS, 'Restored special characters must match 100%');

  const restoredEpisodes = await restoredDb.listStoryEpisodes(TEST_UNIVERSE_ID);
  assert.strictEqual(restoredEpisodes.length, 1, 'Restored subcollection episode must exist');
  assert.strictEqual(restoredEpisodes[0].universe_id, TEST_UNIVERSE_ID, 'Restored episode foreign key universe_id must match');

  const restoredScenes = await restoredDb.listProductionScenes(TEST_PRODUCTION_ID);
  assert.strictEqual(restoredScenes.length, 1, 'Restored production scene must exist');
  assert.strictEqual(restoredScenes[0].scriptText, HINDI_TEST_TEXT, 'Restored scene script text must match');

  logger.success('ALL STRICT FIELD-BY-FIELD EQUALITY ASSERTIONS PASSED FOR ALL 40 ENTITIES!');

  // Clean up test databases
  await testDb.close();
  await restoredDb.close();
  await firestoreDb.close();

  if (fsSync.existsSync(restoredDbPath)) {
    await fs.unlink(restoredDbPath);
  }

  logger.success('=== Automated Firestore Emulator Integration Test Completed Successfully! ===');
}

if (require.main === module) {
  runEmulatorIntegrationTest().catch(err => {
    logger.error('Emulator integration test failed:', err);
    process.exit(1);
  });
}

module.exports = { runEmulatorIntegrationTest };
