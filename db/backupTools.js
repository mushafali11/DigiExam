// Shared helpers for db/backup.js and db/restore.js.
// They call PostgreSQL's own tools (pg_dump and psql), so these must be on your PATH
// (they are in the same "bin" folder as psql).

require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');

const connection = {
    host: process.env.DB_HOST || 'localhost',
    port: String(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    database: process.env.DB_NAME || 'digiexam',
};

function pad(n) {
    return String(n).padStart(2, '0');
}

// 20261124-153045
function timestamp() {
    const d = new Date();
    return (
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
        `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    );
}

// Runs a command (no shell, so nothing can be injected) and waits for it to finish
function runTool(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD || '' },
        });
        let errors = '';
        child.stderr.on('data', (chunk) => {
            errors += chunk;
        });
        child.on('error', (err) => {
            if (err.code === 'ENOENT') {
                reject(new Error(
                    `${command} was not found. Add the "bin" folder of PostgreSQL to your PATH (the folder that contains psql).`
                ));
            } else {
                reject(err);
            }
        });
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${command} failed (exit code ${code}): ${errors.trim()}`));
        });
    });
}

// Saves the whole database as a plain SQL file that recreates every table with its data
async function dumpTo(file) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    try {
        await runTool('pg_dump', [
            '-w', '-h', connection.host, '-p', connection.port, '-U', connection.user,
            '-d', connection.database,
            '--clean', '--if-exists', '--no-owner', '--no-privileges',
            '-f', file,
        ]);
    } catch (err) {
        fs.rmSync(file, { force: true }); // do not leave a half-written file behind
        throw err;
    }
}

// All backup files, newest first
function listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => /^digiexam-.*\.sql$/.test(f))
        .map((f) => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time)
        .map((f) => f.name);
}

module.exports = { BACKUP_DIR, connection, timestamp, runTool, dumpTo, listBackups };