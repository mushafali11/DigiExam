// Restores the database from a backup file. THIS REPLACES ALL CURRENT DATA.
//   npm run db:restore                    shows the available backups
//   npm run db:restore -- latest          restores the newest backup
//   npm run db:restore -- <file name>     restores that file from the backups folder
//   add --yes to skip the question
// Before it replaces anything it saves a safety copy of the current data.
// The restore runs as one transaction: if anything goes wrong, nothing is changed.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const pool = require('./pool');
const { BACKUP_DIR, connection, timestamp, runTool, dumpTo, listBackups } = require('./backupTools');

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const target = args.find((a) => !a.startsWith('--'));

function ask(question) {
    if (flags.includes('--yes')) return Promise.resolve(true);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim() === 'YES');
        });
    });
}

function resolveFile(name) {
    if (name === 'latest') {
        const all = listBackups();
        return all.length > 0 ? path.join(BACKUP_DIR, all[0]) : null;
    }
    if (fs.existsSync(name)) return path.resolve(name);
    const inFolder = path.join(BACKUP_DIR, name);
    return fs.existsSync(inFolder) ? inFolder : null;
}

async function main() {
    if (process.env.NODE_ENV === 'production') {
        console.log('Refusing to run: NODE_ENV is production.');
        process.exit(1);
    }

    if (!target) {
        const all = listBackups();
        if (all.length === 0) {
            console.log('There are no backups yet. Create one with: npm run db:backup');
        } else {
            console.log('Available backups (newest first):');
            for (const f of all) {
                const kb = Math.max(1, Math.round(fs.statSync(path.join(BACKUP_DIR, f)).size / 1024));
                console.log(`  ${f}  (${kb} KB)`);
            }
            console.log('\nRestore one with: npm run db:restore -- <file name>   (or "latest")');
        }
        await pool.end();
        return;
    }

    const file = resolveFile(target);
    if (!file) {
        console.log(`Backup not found: ${target}`);
        await pool.end();
        process.exit(1);
    }

    const ok = await ask(
        `\nThis will REPLACE ALL DATA in the database "${connection.database}" with the contents of\n` +
        `${path.basename(file)}.\nA safety copy of the current data is saved first.\nType YES to continue: `
    );
    if (!ok) {
        console.log('Cancelled. Nothing was changed.');
        await pool.end();
        return;
    }

    const safety = path.join(BACKUP_DIR, `digiexam-before-restore-${timestamp()}.sql`);
    await dumpTo(safety);
    console.log(`Safety copy saved: ${path.relative(process.cwd(), safety)}`);

    await runTool('psql', [
        '-w', '-q', '-h', connection.host, '-p', connection.port, '-U', connection.user,
        '-d', connection.database, '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', file,
    ]);

    const counts = (
        await pool.query(
            `SELECT (SELECT COUNT(*) FROM users)::int AS users,
              (SELECT COUNT(*) FROM courses)::int AS courses,
              (SELECT COUNT(*) FROM questions)::int AS questions,
              (SELECT COUNT(*) FROM exams)::int AS exams,
              (SELECT COUNT(*) FROM attempts)::int AS attempts`
        )
    ).rows[0];
    console.log(
        `\nRestored from ${path.basename(file)}: ${counts.users} users, ${counts.courses} courses, ` +
        `${counts.questions} questions, ${counts.exams} exams, ${counts.attempts} attempts.`
    );
    await pool.end();
}

main().catch(async (err) => {
    console.error('\nRestore failed (nothing was changed):', err.message);
    await pool.end().catch(() => { });
    process.exit(1);
});