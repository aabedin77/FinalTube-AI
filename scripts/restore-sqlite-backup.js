const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { Logger } = require('../utils/logger');
const logger = new Logger('RestoreBackupScript');

const TARGET_DB_PATH = path.join(__dirname, '..', 'data', 'youtube_automation.db');

async function restoreSqliteBackup(backupFilePath) {
  if (!backupFilePath) {
    logger.error('No backup file path specified.');
    console.log('\nUsage: node scripts/restore-sqlite-backup.js <path_to_backup.db>');
    process.exit(1);
  }

  const absoluteBackupPath = path.resolve(backupFilePath);
  logger.info(`Restoring SQLite database from backup: ${absoluteBackupPath}`);

  if (!fsSync.existsSync(absoluteBackupPath)) {
    logger.error(`Specified backup file does not exist: ${absoluteBackupPath}`);
    process.exit(1);
  }

  // Create safety copy of current target before overwriting
  if (fsSync.existsSync(TARGET_DB_PATH)) {
    const safetyCopy = `${TARGET_DB_PATH}.pre_restore_safety_${Date.now()}.db`;
    await fs.copyFile(TARGET_DB_PATH, safetyCopy);
    logger.info(`Safety copy of active database saved to: ${safetyCopy}`);
  }

  await fs.copyFile(absoluteBackupPath, TARGET_DB_PATH);
  logger.success(`Database successfully restored from ${absoluteBackupPath} to ${TARGET_DB_PATH}`);
}

if (require.main === module) {
  const backupFile = process.argv[2];
  restoreSqliteBackup(backupFile).catch(err => {
    logger.error('Restore failed:', err);
    process.exit(1);
  });
}

module.exports = { restoreSqliteBackup };
