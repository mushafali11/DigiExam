// Saves a backup of the database into the "backups" folder.
// Run from the backend folder:   npm run db:backup
// Keeps the newest 10 backups (change with BACKUP_KEEP in .env).

const fs = require('fs');
const path = require('path');
const { BACKUP_DIR, timestamp, dumpTo } = require('./backupTools');

const KEEP = Number(process.env.BACKUP_KEEP) || 10;

async function main() {
    const file = path.join(BACKUP_DIR, `digiexam-${timestamp()}.sql`);
    await dumpTo(file);

    const kb = Math.max(1, Math.round(fs.statSync(file).size / 1024));
    console.log(`Backup saved: ${path.relative(process.cwd(), file)} (${kb} KB)`);

    // Delete the oldest automatic backups, keeping the newest KEEP.
    // (Safety copies made by a restore are never deleted automatically.)
    const automatic = fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => /^digiexam-\d{8}-\d{6}\.sql$/.test(f))
        .sort()
        .reverse();
    for (const old of automatic.slice(KEEP)) {
        fs.unlinkSync(path.join(BACKUP_DIR, old));
        console.log(`Removed old backup: ${old}`);
    }
}

main().catch((err) => {
    console.error('Backup failed:', err.message);
    process.exit(1);
});