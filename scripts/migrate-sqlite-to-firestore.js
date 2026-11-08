const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { Database } = require('../database/db');
const { FirestoreDatabase } = require('../database/firestore_db');
const { Logger } = require('../utils/logger');

const logger = new Logger('MigrationScript');

const CHECKPOINT_FILE = path.join(__dirname, '..', 'data', '.firestore_migration_checkpoint.json');
const BACKUP_PATH = path.join(__dirname, '..', 'data', `youtube_automation_pre_firestore_backup_${Date.now()}.db`);

async function createSqliteBackup(sourceDbPath) {
  try {
    if (!fsSync.existsSync(sourceDbPath)) {
      logger.info(`Source DB ${sourceDbPath} does not exist yet. No backup needed.`);
      return null;
    }
    await fs.copyFile(sourceDbPath, BACKUP_PATH);
    logger.success(`Durable SQLite backup saved to: ${BACKUP_PATH}`);
    return BACKUP_PATH;
  } catch (err) {
    logger.error('Failed to create SQLite safety backup:', err);
    throw err;
  }
}

async function loadCheckpoint() {
  try {
    if (fsSync.existsSync(CHECKPOINT_FILE)) {
      const data = await fs.readFile(CHECKPOINT_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (_e) {
    // Checkpoint load fallback
  }
  return { completedTables: [], lastRun: null };
}

async function saveCheckpoint(checkpoint) {
  try {
    await fs.writeFile(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2), 'utf8');
  } catch (err) {
    logger.warn(`Could not save checkpoint: ${err.message}`);
  }
}

async function migrateSqliteToFirestore(options = {}) {
  const isDryRun = options.dryRun || process.argv.includes('--dry-run');
  logger.info(`=== Starting SQLite to Firestore Migration (Dry Run: ${isDryRun}) ===`);

  const sourceDb = new Database();
  await sourceDb.initialize();

  // 1. Create durable SQLite backup
  await createSqliteBackup(sourceDb.dbPath);

  // 2. Load checkpoint
  const checkpoint = await loadCheckpoint();
  logger.info(`Loaded checkpoint: ${checkpoint.completedTables.length} tables previously migrated.`);

  // 3. Connect to Firestore
  const firestoreDb = new FirestoreDatabase({
    projectId: options.projectId || process.env.FIREBASE_PROJECT_ID || 'finalept-n8'
  });
  await firestoreDb.initialize();

  // 4. Export all SQLite state
  const state = await sourceDb.exportStateJSON();
  const tables = Object.keys(state);

  let totalMigrated = 0;
  const verificationReport = {};

  for (const table of tables) {
    if (checkpoint.completedTables.includes(table)) {
      logger.info(`Skipping already migrated table: ${table}`);
      continue;
    }

    const rows = state[table] || [];
    logger.info(`Processing table "${table}" (${rows.length} rows)...`);

    if (isDryRun) {
      logger.info(`[DRY RUN] Would write ${rows.length} documents to collection "${table}"`);
      verificationReport[table] = { sqliteCount: rows.length, firestoreCount: rows.length, verified: true };
      continue;
    }

    // Write in batches of up to 400 (under Firestore 500 limit)
    const BATCH_SIZE = 400;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batchRows = rows.slice(i, i + BATCH_SIZE);
      const batch = firestoreDb.db.batch();

      for (const row of batchRows) {
        const pk = table === 'settings' ? 'key' : 'id';
        const docId = String(row[pk] || firestoreDb.generateId(table));
        const docRef = firestoreDb.db.collection(table).doc(docId);
        batch.set(docRef, { ...row, migrated_at: new Date().toISOString() }, { merge: true });
      }

      await batch.commit();
      totalMigrated += batchRows.length;
    }

    // Verification check
    const snap = await firestoreDb.db.collection(table).get();
    const firestoreCount = snap.size;
    const verified = firestoreCount >= rows.length;

    verificationReport[table] = {
      sqliteCount: rows.length,
      firestoreCount,
      verified
    };

    if (verified) {
      checkpoint.completedTables.push(table);
      checkpoint.lastRun = new Date().toISOString();
      await saveCheckpoint(checkpoint);
      logger.success(`Table "${table}" verified! (${firestoreCount} docs in Firestore)`);
    } else {
      logger.warn(`Verification mismatch on "${table}": SQLite has ${rows.length}, Firestore has ${firestoreCount}`);
    }
  }

  logger.info('\n=== Migration & Verification Summary ===');
  console.table(verificationReport);

  await sourceDb.close();
  await firestoreDb.close();

  logger.success(`Migration routine completed. Total documents processed: ${totalMigrated}`);
  return { verificationReport, totalMigrated, backupPath: BACKUP_PATH };
}

if (require.main === module) {
  migrateSqliteToFirestore({ dryRun: process.argv.includes('--dry-run') })
    .then(() => process.exit(0))
    .catch(err => {
      logger.error('Migration failed:', err);
      process.exit(1);
    });
}

module.exports = { migrateSqliteToFirestore, createSqliteBackup, loadCheckpoint };
