const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
    ssl: { rejectUnauthorized: false }
});

async function ensureTableExists(headers, targetTable) {
    const columns = headers
        .filter(h => h && h.trim() !== '')
        .map(h => `"${h.trim()}" TEXT`)
        .join(', ');

    const query = `CREATE TABLE IF NOT EXISTS "DataWarehouse".${targetTable} (
        ${columns}
    );`;
    await pool.query(query);
    console.log(`[db] Table "DataWarehouse".${targetTable} ensured.`);
}

async function saveStreamToDatabase(stream, targetTable = 'chumbak_ebo_sales', parserOptions = {}) {
    const csv = require('csv-parser');
    const BATCH_SIZE = 100;
    let buffer = [];
    let headers = null;
    let insertedCount = 0;
    let firstRowProcessed = false;

    const flushBuffer = async (targetBuffer, targetHeaders) => {
        if (targetBuffer.length === 0) return;

        try {
            const columns = targetHeaders.map(h => `"${h}"`).join(', ');
            const values = [];
            const placeholders = [];

            targetBuffer.forEach((row, rowIndex) => {
                const rowPlaceholders = targetHeaders.map((_, colIndex) => {
                    values.push(row[colIndex]);
                    return `$${rowIndex * targetHeaders.length + colIndex + 1}`;
                });
                placeholders.push(`(${rowPlaceholders.join(', ')})`);
            });

            const query = `INSERT INTO "DataWarehouse".${targetTable} (${columns}) VALUES ${placeholders.join(', ')}`;
            await pool.query(query, values);
            insertedCount += targetBuffer.length;
        } catch (err) {
            console.warn(`⚠️ Bulk insert failed: ${err.message}. Retrying row-by-row...`);
            const columns = targetHeaders.map(h => `"${h}"`).join(', ');
            for (const row of targetBuffer) {
                try {
                    const placeholders = targetHeaders.map((_, i) => `$${i + 1}`).join(', ');
                    const query = `INSERT INTO "DataWarehouse".${targetTable} (${columns}) VALUES (${placeholders})`;
                    await pool.query(query, row);
                    insertedCount++;
                } catch (rowErr) {
                    console.error(`❌ Row failed: ${rowErr.message} | Data: ${JSON.stringify(row).substring(0, 100)}...`);
                }
            }
        }
    };

    try {
        const streamReader = stream.pipe(csv(parserOptions));

        for await (const data of streamReader) {
            // Process headers once
            if (!headers) {
                const h = Object.keys(data);
                headers = h.filter(x => x && x.trim() !== '');
                await ensureTableExists(headers, targetTable);
            }

            // First row hook for debugging
            if (!firstRowProcessed && parserOptions.onFirstRow) {
                parserOptions.onFirstRow(data);
                firstRowProcessed = true;
            }

            if (headers.includes('BillDate') && (!data['BillDate'] || data['BillDate'].trim() === '')) continue;

            const rowValues = headers.map(h => {
                let val = data[h];
                if (typeof val === 'string') {
                    val = val.trim();
                    if (val.startsWith('"') && val.endsWith('"')) {
                        val = val.substring(1, val.length - 1);
                    }
                    if (h === 'EANCode' && val.startsWith("'")) val = val.substring(1);
                    if (h === 'BillDate' && /^\d{2}\/\d{2}\/\d{4}$/.test(val)) {
                        const [dd, mm, yyyy] = val.split('/');
                        val = `${yyyy}-${mm}-${dd}`;
                    }
                }
                return val;
            });
            buffer.push(rowValues);

            if (buffer.length >= BATCH_SIZE) {
                await flushBuffer(buffer, headers);
                buffer = [];
            }
        }

        // Final flush
        if (buffer.length > 0) {
            await flushBuffer(buffer, headers);
        }

        return { inserted: insertedCount };
    } catch (err) {
        throw err;
    }
}

async function deleteDateFromTable(dateStr, targetTable = 'chumbak_ebo_sales') {
    try {
        const column = targetTable.includes('stock') ? 'Date' : 'BillDate';
        const query = `DELETE FROM "DataWarehouse".${targetTable} WHERE "${column}" = $1`;
        const res = await pool.query(query, [dateStr]);
        console.log(`[db] Target date ${dateStr} cleared from ${targetTable}: ${res.rowCount} rows removed.`);
    } catch (err) {
        console.error('[db-delete-error]', err.message);
    }
}

async function closePool() {
    await pool.end();
}

module.exports = {
    saveStreamToDatabase,
    deleteDateFromTable,
    closePool
};
