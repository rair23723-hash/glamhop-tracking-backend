/**
 * fetch_order_1003.js
 * Fetches raw Shopify order #1003 using ONLY Node.js built-ins.
 * No npm packages required. Run: node scratch/fetch_order_1003.js
 *
 * Requires these env vars (set in .env or via shell export):
 *   SHOPIFY_SHOP_DOMAIN
 *   SHOPIFY_CLIENT_ID
 *   SHOPIFY_CLIENT_SECRET  (or SHOPIFY_API_SECRET)
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Load .env files manually (no external package) ────────────────────────────
// Priority order: .env.local → .env  (later files do NOT override earlier ones)
function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key   = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) process.env[key] = value;
    }
    console.log('[env] Loaded:', filePath);
    return true;
}

function loadEnv() {
    const root = path.join(__dirname, '..');
    // Check these files in priority order
    const candidates = ['.env.local', '.env'];
    let loaded = false;
    for (const name of candidates) {
        if (loadEnvFile(path.join(root, name))) loaded = true;
    }
    if (!loaded) {
        console.log('[env] No .env or .env.local file found — relying on shell environment variables');
    }
}

// ── Promisified HTTPS helper ──────────────────────────────────────────────────
function httpsRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch (_) {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
    loadEnv();

    const domain = process.env.SHOPIFY_SHOP_DOMAIN;
    const clientId     = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;
    const adminToken   = process.env.SHOPIFY_ACCESS_TOKEN; // optional: direct token fallback

    console.log('\n══ Environment ══════════════════════════════════════');
    console.log('SHOPIFY_SHOP_DOMAIN  :', domain     || '(missing)');
    console.log('SHOPIFY_CLIENT_ID    :', clientId   || '(missing)');
    console.log('SHOPIFY_CLIENT_SECRET:', clientSecret ? '***set***' : '(missing)');
    console.log('SHOPIFY_ACCESS_TOKEN :', adminToken  ? '***set***' : '(not set)');
    console.log('═════════════════════════════════════════════════════\n');

    if (!domain) {
        console.error('❌ SHOPIFY_SHOP_DOMAIN is not set. Cannot continue.');
        process.exit(1);
    }

    let token = adminToken;

    // ── Step 1: Get access token (skip if direct token provided) ─────────────
    if (!token) {
        if (!clientId || !clientSecret) {
            console.error('❌ Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET. Cannot authenticate.');
            process.exit(1);
        }

        console.log('Step 1: Authenticating with Shopify (client_credentials)...');
        const body = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;

        const authResult = await httpsRequest({
            hostname: domain,
            path    : '/admin/oauth/access_token',
            method  : 'POST',
            headers : {
                'Content-Type'  : 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
        }, body);

        if (authResult.status !== 200 || !authResult.body?.access_token) {
            console.error('❌ Token fetch failed. HTTP', authResult.status);
            console.error('   Response:', JSON.stringify(authResult.body, null, 2));
            process.exit(1);
        }

        token = authResult.body.access_token;
        console.log('✅ Access token obtained\n');
    } else {
        console.log('Step 1: Using SHOPIFY_ACCESS_TOKEN directly (skipping OAuth)\n');
    }

    // ── Step 2: Fetch order by name ────────────────────────────────────────────
    console.log('Step 2: Fetching orders with name=#1003 (status=any) ...');
    const qs = 'name=%231003&status=any&limit=10';
    const orderResult = await httpsRequest({
        hostname: domain,
        path    : `/admin/api/2024-07/orders.json?${qs}`,
        method  : 'GET',
        headers : {
            'X-Shopify-Access-Token': token,
            'Content-Type'          : 'application/json',
        },
    });

    console.log('   HTTP Status:', orderResult.status);

    if (orderResult.status !== 200) {
        console.error('❌ Order fetch failed. HTTP', orderResult.status);
        console.error('   Response:', JSON.stringify(orderResult.body, null, 2));
        process.exit(1);
    }

    const orders = orderResult.body?.orders || [];
    console.log(`   Orders returned: ${orders.length}\n`);

    // ── Step 3: Write raw JSON to file ────────────────────────────────────────
    const outPath = path.join(__dirname, 'order_1003_raw.json');
    fs.writeFileSync(outPath, JSON.stringify(orderResult.body, null, 2), 'utf8');
    console.log(`✅ Raw Shopify response written to: ${outPath}`);

    // ── Step 4: Print analysis ─────────────────────────────────────────────────
    console.log('\n══ Analysis ══════════════════════════════════════════');
    if (orders.length === 0) {
        console.log('⚠️  No orders found with name=#1003');
        console.log('   Possible causes:');
        console.log('   1. Order number format mismatch (Shopify stores as #1003 but API needs exact match)');
        console.log('   2. Wrong SHOPIFY_SHOP_DOMAIN');
        console.log('   3. API credentials do not have orders read scope');
    } else {
        orders.forEach((o, i) => {
            console.log(`\n── Order [${i}] ──────────────────────────────────────`);
            console.log('  id               :', o.id);
            console.log('  name             :', o.name);
            console.log('  email            :', o.email);
            console.log('  fulfillment_status:', o.fulfillment_status);
            console.log('  financial_status  :', o.financial_status);
            const fCount = o.fulfillments ? o.fulfillments.length : 0;
            console.log('  fulfillments[]    :', fCount, fCount === 0 ? '← ⚠️  EMPTY' : '');
            if (o.fulfillments && o.fulfillments.length > 0) {
                o.fulfillments.forEach((f, fi) => {
                    console.log(`    [${fi}] id              :`, f.id);
                    console.log(`    [${fi}] status          :`, f.status);
                    console.log(`    [${fi}] tracking_number :`, f.tracking_number || '(null) ← ⚠️  NO AWB');
                    console.log(`    [${fi}] tracking_company:`, f.tracking_company || '(null)');
                    console.log(`    [${fi}] shipment_status :`, f.shipment_status || '(null)');
                });
            }
        });
    }
    console.log('\n═════════════════════════════════════════════════════');
}

run().catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
