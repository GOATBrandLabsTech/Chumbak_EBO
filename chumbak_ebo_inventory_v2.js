const puppeteer = require('puppeteer');
const chromium = require('chromium');
const fetch = require('node-fetch');
const { saveStreamToDatabase, closePool } = require('./chumbak_db_utils');
const { Readable } = require('stream');
require('dotenv').config();

function getChumbakTimestamp() {
  const d = new Date();
  const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12; hours = hours ? hours : 12;
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${date} ${hours}:${minutes}:${seconds} ${ampm}`;
}

async function runInventorySyncV2() {
    const loginUrl = "https://chumbak.eshopaid.com/shopaid/authpages/Login.aspx";
    const username = "sharavana";
    const password = process.env.CHUMBAK_PASSWORD;

    if (!password) {
        console.error("❌ CHUMBAK_PASSWORD not found in .env");
        return;
    }

    console.log("-----------------------------------------");
    console.log("📦 Chumbak EBO Inventory Automation V2");
    console.log("-----------------------------------------");

    const browser = await puppeteer.launch({
        headless: true,
        executablePath: chromium.path,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu'
        ]
    });
    const page = await browser.newPage();

    // Handle the "User is active in another device" alert
    page.on('dialog', async dialog => {
        console.log(`💬 Alert found: ${dialog.message()}`);
        await dialog.accept();
        console.log("✅ Alert accepted (Other device toast)");
    });

    try {
        console.log("🚀 Navigating to login page...");
        await page.goto(loginUrl, { waitUntil: 'networkidle2' });

        console.log("⌨️ Entering credentials...");
        await page.waitForSelector('#txtUserName');
        await page.type('#txtUserName', username);
        await page.type('#txtPassword', password);

        console.log("🖱️ Clicking Login...");

        // Try #btnLogin first, then #btnProceed if it's a multi-step login
        const loginBtn = await page.$('#btnLogin');
        if (loginBtn) {
            await page.click('#btnLogin');
            console.log("✅ Clicked #btnLogin");
        } else {
            await page.click('#btnProceed');
            console.log("✅ Clicked #btnProceed (LoginBtn not found)");
        }

        // Wait for possible multi-device dialog or navigation
        try {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 });
        } catch (e) {
            console.log("Note: No immediate navigation, checking for #btnProceed or alerts...");
        }

        // Check if we are at store selection or have a second "Proceed" button
        const proceedBtn = await page.$('#btnProceed');
        if (proceedBtn && await proceedBtn.isIntersectingViewport()) {
            console.log("🖱️ Clicking #btnProceed (Store selection or confirmation)...");
            await page.click('#btnProceed');
            await page.waitForNavigation({ waitUntil: 'networkidle2' });
        }

        console.log("⏳ Waiting 5 seconds as requested...");
        await new Promise(resolve => setTimeout(resolve, 5000));

        console.log("📂 Navigating through menu: Reports...");
        await page.click('#ctl00_IDASPxMenu_DXI3_T'); // Reports tab

        await new Promise(resolve => setTimeout(resolve, 3000));

        // Find the main frame
        console.log("🔍 Looking for 'main' frame...");
        const mainFrame = page.frames().find(f => f.name() === 'main');
        if (!mainFrame) {
            throw new Error("Could not find 'main' frame for report navigation.");
        }

        console.log("📂 Clicking 'Stock Report >>' inside iframe...");
        await mainFrame.waitForSelector('#Menu24', { timeout: 10000 });
        await mainFrame.click('#Menu24');

        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log("📂 Clicking 'LocationWise' inside iframe...");
        await mainFrame.waitForSelector('a[href*="StkReportLocationwise.aspx"]', { timeout: 10000 });
        await mainFrame.click('a[href*="StkReportLocationwise.aspx"]');

        console.log("⏳ Waiting for report page to load (may navigate to new subdomain)...");
        // Note: LocationWise might open in a new frame or redirect the main frame.
        // Let's wait for the new page structure.
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Now we might be on chumbakreport.eshopaid.com
        // We might need to find the frame again or use page if it redirected Top
        let reportTarget = page;
        const reportFrame = page.frames().find(f => f.url().includes('StkReportLocationwise.aspx'));
        if (reportFrame) reportTarget = reportFrame;

        console.log("✅ Selecting filters: All Zones & All Products...");
        await reportTarget.waitForSelector('#chkAllZones', { timeout: 15000 });

        const zoneChecked = await reportTarget.$eval('#chkAllZones', el => el.checked);
        if (!zoneChecked) await reportTarget.click('#chkAllZones');

        const prodChecked = await reportTarget.$eval('#chkAllProducts', el => el.checked);
        if (!prodChecked) await reportTarget.click('#chkAllProducts');
        
        console.log("📊 Selecting 'Detail' view...");
        await reportTarget.select('#ddlOption', '1');

        console.log("🖱️ Clicking 'Show Data' to ensure report is generated...");
        const showBtn = await reportTarget.$('input[value*="Show"]');
        if (showBtn) await showBtn.click();
        await new Promise(resolve => setTimeout(resolve, 8000));

        console.log("📥 Setting up download interception...");
        const fs = require('fs');
        const path = require('path');
        const downloadPath = path.resolve(__dirname, 'downloads');
        if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath);
        
        // Clear previous downloads
        fs.readdirSync(downloadPath).forEach(file => fs.unlinkSync(path.join(downloadPath, file)));

        // Set download behavior
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadPath
        });

        console.log("🖱️ Clicking 'Download CSV' button...");
        const downloadBtn = await reportTarget.$('input[value*="Download"]') || 
                           await reportTarget.$('input[value*="CSV"]') ||
                           await reportTarget.$('#btnExport');

        if (!downloadBtn) throw new Error("Could not find download button.");
        await downloadBtn.click();

        console.log("⏳ Watching for file in downloads folder...");
        let fileName = null;
        let attempts = 0;
        while (attempts < 60) {
            const files = fs.readdirSync(downloadPath);
            const csvFile = files.find(f => f.toLowerCase().endsWith('.csv') && !f.endsWith('.crdownload'));
            if (csvFile) {
                fileName = csvFile;
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }

        if (fileName) {
            const fullPath = path.join(downloadPath, fileName);
            console.log(`✅ File downloaded: ${fileName} (${fs.statSync(fullPath).size} bytes)`);
            const text = fs.readFileSync(fullPath, 'utf8');
            
            const tableName = "chumbak_ebo_inventory";
            console.log(`🚀 Pushing data to table "DataWarehouse".${tableName}...`);
            
            const { Pool } = require('pg');
            const pool = new Pool({
                user: process.env.DB_USER, host: process.env.DB_HOST,
                database: process.env.DB_NAME, password: process.env.DB_PASSWORD,
                port: process.env.DB_PORT || 5432,
                ssl: { rejectUnauthorized: false }
            });
            console.log(`🧹 Truncating ${tableName}...`);
            await pool.query(`TRUNCATE TABLE "DataWarehouse".${tableName}`);
            await pool.end();

            const lines = text.split('\n');
            const headerIndex = lines.findIndex(l => l.includes('ItemCode') || l.includes('ProductCode') || l.includes('Barcode'));
            const cleanText = headerIndex !== -1 ? lines.slice(headerIndex).join('\n') : text;

            const stream = Readable.from([cleanText]);
            const { inserted } = await saveStreamToDatabase(stream, tableName, { quote: '' });
            console.log(`🎉 Success! Captured ${inserted} stock records.`);
            
            // Cleanup
            fs.unlinkSync(fullPath);
        } else {
            console.error("❌ Failed: Download timed out or button click failed.");
            await page.screenshot({ path: 'v2_download_fail.png' });
        }

    } catch (err) {
        console.error(`💥 Error in execution: ${err.message}`);
        await page.screenshot({ path: 'v2_error_screenshot.png' });
        console.log("📸 Screenshot saved to v2_error_screenshot.png");
    } finally {
        await browser.close();
        await closePool();
    }
}

runInventorySyncV2();
