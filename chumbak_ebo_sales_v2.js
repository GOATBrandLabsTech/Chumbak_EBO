require('dotenv').config({
    path: '/home/ubuntu/project/Chumbak_EBO/.env',
    override: true
});

const puppeteer = require('puppeteer');
const chromium = require('chromium');
const fetch = require('node-fetch');
const { saveStreamToDatabase, closePool, deleteDateFromTable } = require('./chumbak_db_utils');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');

async function runSalesSyncV2() {
    const loginUrl = "https://chumbak.eshopaid.com/shopaid/authpages/Login.aspx";
    const username = "sharavana";
    const password = process.env.CHUMBAK_PASSWORD;

    if (!password) {
        console.error("❌ CHUMBAK_PASSWORD not found in .env");
        return;
    }

    console.log("-----------------------------------------");
    console.log("📈 Chumbak EBO Sales Automation V2");
    console.log("-----------------------------------------");

    const browser = await puppeteer.launch({
        headless: true,
        executablePath: chromium.path,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    // Handle alerts
    page.on('dialog', async dialog => {
        await dialog.accept();
    });

    try {
        console.log("🚀 Navigating to login page...");
        await page.goto(loginUrl, { waitUntil: 'networkidle2' });

        console.log("⌨️ Entering credentials...");
        await page.waitForSelector('#txtUserName');
        await page.type('#txtUserName', username);
        await page.type('#txtPassword', password);

        console.log("🖱️ Clicking Login...");
        const loginBtn = await page.$('#btnLogin') || await page.$('#btnProceed');
        await loginBtn.click();

        try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }); } catch (e) { }

        const proceedBtn = await page.$('#btnProceed');
        if (proceedBtn) {
            console.log("🖱️ Clicking #btnProceed (Store selection)...");
            await proceedBtn.click();
            await page.waitForNavigation({ waitUntil: 'networkidle2' });
        }

        console.log("⏳ Waiting 5 seconds post-login as requested...");
        await new Promise(r => setTimeout(r, 5000));

        console.log("📂 Navigating to Sales Report...");
        // Use evaluate to find and click the Reports tab at the top
        await page.evaluate(() => {
            const tabs = Array.from(document.querySelectorAll('li.dxm-item, .dxm-item span'));
            const reportsTab = tabs.find(el => el.textContent.includes('Reports'));
            if (reportsTab) reportsTab.click();
        });
        await new Promise(r => setTimeout(r, 5000));

        const mainFrame = page.frames().find(f => f.name() === 'main');
        if (!mainFrame) throw new Error("Main frame not found");

        console.log("📂 Looking for Sales Report link/icon...");
        // Find and click the sub-menu or icon
        await mainFrame.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a, span, div.icon-text'));
            const salesReportSub = links.find(el => el.textContent.includes('Sales Reports') && el.textContent.includes('>>'));
            if (salesReportSub) salesReportSub.click();
        });
        await new Promise(r => setTimeout(r, 2000));

        const clicked = await mainFrame.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a, span, .icon-text, div'));
            const salesReportLink = links.find(el =>
                (el.textContent.trim() === 'Sales Report' || el.id === 'Menu1') &&
                el.offsetParent !== null
            );
            if (salesReportLink) {
                salesReportLink.click();
                return true;
            }
            return false;
        });

        if (!clicked) throw new Error("Could not click 'Sales Report' link");
        console.log("✅ Clicked Sales Report");
        await new Promise(r => setTimeout(r, 5000));

        let reportTarget = page;
        const reportFrame = page.frames().find(f => f.url().includes('SalesReport.aspx'));
        if (reportFrame) reportTarget = reportFrame;

        console.log("📅 Setting filter: Yesterday's date...");
        const d = new Date();
        d.setDate(d.getDate() - 1);
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const yyyy = d.getFullYear();
        const yesterday = `${dd}/${mm}/${yyyy}`;
        const dbDate = `${dd}/${mm}/${yyyy}`; // For clearing from DB

        // Surgical clear: only remove data for yesterday to protect history
        await deleteDateFromTable(dbDate, 'chumbak_ebo_sales');

        // Inject date directly into inputs
        await reportTarget.evaluate((yest) => {
            const from = document.getElementById('DEFromDate');
            const to = document.getElementById('DEToDate');
            if (from) from.value = yest;
            if (to) to.value = yest;
        }, yesterday);

        console.log("✅ Enabling 'All Zones' filter...");
        await reportTarget.evaluate(() => {
            const zoneBtn = document.getElementById('chkAllZones') ||
                document.getElementById('chkAllZone') ||
                Array.from(document.querySelectorAll('input[type=\"checkbox\"]')).find(cb => {
                    const label = cb.nextElementSibling || cb.parentElement;
                    return label && label.textContent.includes('Zone');
                });
            if (zoneBtn && !zoneBtn.checked) zoneBtn.click();
        });
        await new Promise(r => setTimeout(r, 2000));

        console.log("📊 Selecting 'Details' view in 'Report Type'...");
        await reportTarget.evaluate(() => {
            const selects = Array.from(document.querySelectorAll('select'));
            const typeSel = selects.find(s => s.parentElement.textContent.includes('Report Type') || s.id.includes('ddl'));
            if (typeSel) {
                const detailOpt = Array.from(typeSel.options).find(o => o.textContent.includes('Details') || o.textContent.includes('Detail'));
                if (detailOpt) typeSel.value = detailOpt.value;
                typeSel.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        await new Promise(r => setTimeout(r, 2000));

        console.log("🖱️ Clicking 'Load Report' first to prime...");
        await reportTarget.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('input, button'));
            const loadBtn = btns.find(b => b.value === 'Load Report' || b.textContent.includes('Load'));
            if (loadBtn) loadBtn.click();
        });
        await new Promise(r => setTimeout(r, 10000));

        console.log("📥 Setting up global download interception...");
        const downloadPath = path.resolve(__dirname, 'downloads_sales');
        if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath);
        fs.readdirSync(downloadPath).forEach(f => fs.unlinkSync(path.join(downloadPath, f)));

        // Intercept downloads on the main page AND any new tabs it opens
        const setupDownloader = async (targetPage) => {
            const client = await targetPage.target().createCDPSession();
            await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadPath });
        };
        await setupDownloader(page);
        browser.on('targetcreated', async (target) => {
            if (target.type() === 'page') {
                const newPage = await target.page();
                await setupDownloader(newPage);
            }
        });

        console.log("📥 Triggering download via 'Download' button...");
        const clickedDownload = await reportTarget.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('input, button'));
            const downBtn = btns.find(b => b.value === 'Download' || (b.textContent && b.textContent.includes('Download')));
            if (downBtn) {
                downBtn.click();
                return true;
            }
            return false;
        });

        if (!clickedDownload) throw new Error("Download button not found");
        console.log("🖱️ Clicked Download button");

        console.log("⏳ Waiting for file (up to 120s)...");
        let fileName = null;
        let attempts = 0;
        while (attempts < 120) {
            const files = fs.readdirSync(downloadPath);
            fileName = files.find(f => f.endsWith('.csv') && !f.endsWith('.crdownload'));
            if (fileName) break;
            await new Promise(r => setTimeout(r, 1000));
            attempts++;
        }

        if (fileName) {
            const fullPath = path.join(downloadPath, fileName);
            const text = fs.readFileSync(fullPath, 'utf8');
            console.log(`✅ File captured: ${fileName} (${fs.statSync(fullPath).size} bytes)`);

            const lines = text.split('\n');
            // Dynamically find the header row by searching for specific column names
            const headerIndex = lines.findIndex(l => l.includes('RegionName,StoreName') || l.includes('BillDate,BillNumber'));

            if (headerIndex !== -1) {
                const headerLine = lines[headerIndex];
                console.log(`📋 HEADER DETECTED (Line ${headerIndex + 1}): ${headerLine.substring(0, 100)}...`);

                const cleanText = lines.slice(headerIndex).join('\n');
                const stream = Readable.from([cleanText]);
                console.log(`🚀 Starting database push for ${fileName}...`);

                const { inserted } = await saveStreamToDatabase(stream, 'chumbak_ebo_sales', { quote: '' });
                console.log(`🎉 Success! Synced ${inserted} rows to "chumbak_ebo_sales".`);

                // Cleanup on success
                if (inserted > 400) {
                    fs.unlinkSync(fullPath);
                    if (fs.existsSync('captured_sales.csv')) fs.unlinkSync('captured_sales.csv');
                    console.log("✅ File processed and cleaned up.");
                } else {
                    console.warn(`⚠️ Only synced ${inserted} rows. Keeping file at ${fullPath}`);
                }
            } else {
                console.error("❌ Could not find valid header row in CSV!");
                console.log("First 20 lines of CSV for debug:", lines.slice(0, 20).join('\n'));
            }

            if (fs.existsSync('captured_sales.csv')) fs.unlinkSync('captured_sales.csv');
        } else {
            console.error("❌ Download timed out");
            await page.screenshot({ path: 'sales_v2_fail.png' });
        }

    } catch (err) {
        console.error(`💥 Error: ${err.message}`);
        await page.screenshot({ path: 'sales_v2_error.png' });
    } finally {
        await browser.close();
        await closePool();
    }
}

runSalesSyncV2();
