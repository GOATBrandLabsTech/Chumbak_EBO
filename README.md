# Chumbak EBO Sales Ingestor

This folder contains the automated pipeline for ingesting Chumbak eShopaid sales data into the `DataWarehouse.chumbak_ebo_sales` table.

## Deployment Instructions

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **EC2/Linux Setup** (Run if deploying on a fresh AWS instance):
   ```bash
   npm run setup-linux
   ```
   *This installs the necessary shared libraries for Chromium to run on Ubuntu/Debian.*

3. **Setup Environment**:
   - Copy `.env.example` to `.env`.
   - Fill in your PostgreSQL/RDS credentials.

3. **Session Management**:
   - Currently, the authentication is handled via a hardcoded cookie in `chumbak_ebo_sales.js` (Line 17).
   - If the sync fails to capture data, update the `ASP.NET_SessionId` with a fresh value from a logged-in browser portal session.

4. **Features**:
   - **T-1 Daily Sync**: Configured to sync yesterday's data by default.
   - **Zero-Drop Ingestion**: Captures all 238 columns from the portal CSV.
   - **Idempotency**: Automatically clears the target date in the DB before re-inserting to prevent duplicates.

5. **Execution**:
   ```bash
   npm start
   ```
