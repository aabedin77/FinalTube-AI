const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { Database } = require('../database/db');
const { FirestoreDatabase } = require('../database/firestore_db');
const { Logger } = require('../utils/logger');
const logger = new Logger('RollbackSyncScript');

const LOCK_FILE = path.join(__dirname, '..', 'data', '.rollback.lock');
const CHECKPOINT_FILE = path.join(__dirname, '..', 'data', '.rollback_checkpoint.json');
const BACKUP_PATH = path.join(__dirname, '..', 'data', `youtube_automation_pre_rollback_backup_${Date.now()}.db`);

async function acquireProcessLock() {
  if (fsSync.existsSync(LOCK_FILE)) {
    const pid = fsSync.readFileSync(LOCK_FILE, 'utf8').trim();
    throw new Error(`Reverse migration lock active (PID: ${pid}). Ensure application server is stopped before running rollback.`);
  }
  await fs.writeFile(LOCK_FILE, String(process.pid), 'utf8');
}

async function releaseProcessLock() {
  try {
    if (fsSync.existsSync(LOCK_FILE)) {
      await fs.unlink(LOCK_FILE);
    }
  } catch (_e) {
    // Cleanup lock error
  }
}

async function loadCheckpoint() {
  try {
    if (fsSync.existsSync(CHECKPOINT_FILE)) {
      const data = await fs.readFile(CHECKPOINT_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (_e) {
    // Fallback on missing or corrupted checkpoint
  }
  return { completedEntities: [], lastRun: null };
}

async function saveCheckpoint(checkpoint) {
  try {
    await fs.writeFile(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2), 'utf8');
  } catch (err) {
    logger.warn(`Could not save rollback checkpoint: ${err.message}`);
  }
}

async function syncFirestoreToSqlite(options = {}) {
  const isDryRun = options.dryRun || process.argv.includes('--dry-run');
  logger.info(`=== Starting Safe Firestore -> SQLite Reverse Migration (Dry Run: ${isDryRun}) ===`);

  await acquireProcessLock();

  try {
    const targetSqlite = options.targetDb || new Database();
    if (!targetSqlite.isInitialized) {
      await targetSqlite.initialize();
    }

    // 1. Create durable SQLite backup prior to rollback sync
    if (fsSync.existsSync(targetSqlite.dbPath)) {
      await fs.copyFile(targetSqlite.dbPath, BACKUP_PATH);
      logger.success(`Durable pre-rollback SQLite backup created at: ${BACKUP_PATH}`);
    }

    const checkpoint = await loadCheckpoint();
    logger.info(`Loaded checkpoint: ${checkpoint.completedEntities.length} entities previously synced.`);

    const sourceFirestore = options.sourceFirestore || new FirestoreDatabase({
      projectId: options.projectId || process.env.FIREBASE_PROJECT_ID || 'finalept-n8'
    });
    
    if (!sourceFirestore.isInitialized) {
      await sourceFirestore.initialize();
    }

    // Mapping of 40 SQL tables & subcollections
    const MAPPINGS = [
      { name: 'channel_profiles', pk: 'id', isSub: false },
      { name: 'channel_strategies', pk: 'id', isSub: false },
      { name: 'settings', pk: 'key', isSub: false },
      { name: 'content_strategies', pk: 'id', isSub: false },
      { name: 'scripts', pk: 'id', isSub: false },
      { name: 'thumbnails', pk: 'id', isSub: false },
      { name: 'seo_data', pk: 'id', isSub: false },
      { name: 'productions', pk: 'id', isSub: false },
      { name: 'production_snapshots', pk: 'production_id', isSub: false },
      { name: 'content_reviews', pk: 'production_id', isSub: false },
      { name: 'content_provenance', pk: 'production_id', isSub: false },
      { name: 'publish_schedule', pk: 'id', isSub: false },
      { name: 'content_ideas', pk: 'id', isSub: false },
      { name: 'story_universes', pk: 'id', isSub: false },
      { name: 'story_episodes', pk: 'id', isSub: true, collectionGroup: 'episodes' },
      { name: 'production_scenes', pk: 'id', isSub: true, collectionGroup: 'scenes' },
      { name: 'production_scene_revisions', pk: 'id', isSub: true, collectionGroup: 'scene_revisions' },
      { name: 'shorts_clips', pk: 'id', isSub: true, collectionGroup: 'shorts' },
      { name: 'monetization_evaluations', pk: 'id', isSub: false },
      { name: 'discoverability_audits', pk: 'id', isSub: false },
      { name: 'discoverability_findings', pk: 'id', isSub: true, collectionGroup: 'findings' },
      { name: 'generation_jobs', pk: 'id', isSub: false },
      { name: 'generation_checkpoints', pk: 'job_id', isSub: true, collectionGroup: 'checkpoints' },
      { name: 'media_generation_tasks', pk: 'id', isSub: false },
      { name: 'operator_runs', pk: 'id', isSub: false },
      { name: 'notifications', pk: 'id', isSub: false },
      { name: 'readiness_runs', pk: 'id', isSub: false },
      { name: 'analytics_reports', pk: 'id', isSub: false },
      { name: 'performance_snapshots', pk: 'id', isSub: false },
      { name: 'retention_snapshots', pk: 'id', isSub: false },
      { name: 'learning_recommendations', pk: 'id', isSub: false },
      { name: 'growth_experiments', pk: 'id', isSub: false },
      { name: 'experiment_arms', pk: 'id', isSub: true, collectionGroup: 'arms' },
      { name: 'experiment_samples', pk: 'id', isSub: true, collectionGroup: 'samples' },
      { name: 'audience_comments', pk: 'id', isSub: false },
      { name: 'engagement_insights', pk: 'id', isSub: false },
      { name: 'reply_drafts', pk: 'id', isSub: false },
      { name: 'keyword_performance', pk: 'keyword', isSub: false },
      { name: 'content_history', pk: 'id', isSub: false },
      { name: 'automation_events', pk: 'id', isSub: false }
    ];

    let totalSyncedDocs = 0;
    const report = {};

    for (const mapping of MAPPINGS) {
      const entityName = mapping.name;
      if (checkpoint.completedEntities.includes(entityName)) {
        logger.info(`Skipping already completed entity: ${entityName}`);
        continue;
      }

      logger.info(`Fetching documents for entity "${entityName}" (Subcollection: ${mapping.isSub})...`);

      let docs = [];
      try {
        if (mapping.isSub) {
          const snap = await sourceFirestore.db.collectionGroup(mapping.collectionGroup).get();
          docs = snap.docs.map(d => d.data());
        } else {
          const snap = await sourceFirestore.db.collection(entityName).get();
          docs = snap.docs.map(d => d.data());
        }
      } catch (err) {
        logger.warn(`Could not fetch Firestore documents for ${entityName}: ${err.message}`);
        docs = [];
      }

      logger.info(`Found ${docs.length} Firestore documents for "${entityName}".`);

      if (isDryRun) {
        report[entityName] = { firestoreCount: docs.length, synced: docs.length, status: 'dry-run' };
        continue;
      }

      let syncedForEntity = 0;
      for (const row of docs) {
        if (!row || typeof row !== 'object') continue;

        const keys = Object.keys(row).filter(k => /^[a-zA-Z0-9_]+$/.test(k) && k !== 'migrated_at');
        if (!keys.length) continue;

        const cols = keys.join(', ');
        const placeholders = keys.map(() => '?').join(', ');
        const vals = keys.map(k => {
          const val = row[k];
          if (val === undefined || val === null) return null;
          if (typeof val === 'object') return JSON.stringify(val);
          return val;
        });

        try {
          await targetSqlite.executeQuery(
            `INSERT OR REPLACE INTO ${entityName} (${cols}) VALUES (${placeholders})`,
            vals
          );
          syncedForEntity++;
          totalSyncedDocs++;
        } catch (insertErr) {
          logger.warn(`Insert error on ${entityName} (${row[mapping.pk] || 'unknown'}): ${insertErr.message}`);
        }
      }

      report[entityName] = { firestoreCount: docs.length, synced: syncedForEntity, status: 'success' };

      checkpoint.completedEntities.push(entityName);
      checkpoint.lastRun = new Date().toISOString();
      await saveCheckpoint(checkpoint);
    }

    logger.info('\n=== Rollback Reverse Sync Execution Report ===');
    console.table(report);

    await sourceFirestore.close();
    await targetSqlite.close();

    logger.success(`Reverse migration complete. Total documents synced back to SQLite: ${totalSyncedDocs}`);
    return { report, totalSyncedDocs, backupPath: BACKUP_PATH };
  } finally {
    await releaseProcessLock();
  }
}

if (require.main === module) {
  syncFirestoreToSqlite({ dryRun: process.argv.includes('--dry-run') })
    .then(() => process.exit(0))
    .catch(err => {
      logger.error('Reverse migration failed:', err);
      process.exit(1);
    });
}

module.exports = { syncFirestoreToSqlite, acquireProcessLock, releaseProcessLock };
