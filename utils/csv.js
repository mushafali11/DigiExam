// Small CSV helpers (no extra packages needed)

// Turns CSV text into rows of text cells.
// Handles quotes, commas and line breaks inside quotes, and the BOM that Excel adds.
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

    for (; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += c;
            }
        } else if (c === '"' && field === '') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(field);
            field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field);
            field = '';
            rows.push(row);
            row = [];
        } else {
            field += c;
        }
    }

    if (inQuotes) throw new Error('A quoted value is never closed (a closing double quote is missing)');
    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

// Makes one value safe for a CSV file.
// Text starting with = + - @ gets a leading ' so Excel never runs it as a formula.
function csvCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return String(value);
    let s = String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

function toCsv(rows) {
    return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// Sends a CSV file download (with a BOM so Excel shows non-English names correctly)
function sendCsv(res, filename, csvText) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csvText);
}

module.exports = { parseCsv, toCsv, csvCell, sendCsv };