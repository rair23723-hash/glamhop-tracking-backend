/**
 * evidence.js — Full flow evidence for order #1003
 * Uses ONLY Node.js built-ins. Zero npm packages.
 *
 * Load credentials first:
 *   vercel env pull --environment=production .env.production
 *   node scratch/evidence.js
 *
 * OR set vars manually then run:
 *   $env:SHOPIFY_SHOP_DOMAIN="your-store.myshopify.com"
 *   $env:SHOPIFY_CLIENT_ID="..."
 *   $env:SHOPIFY_CLIENT_SECRET="..."
 *   $env:SHIPROCKET_EMAIL="..."
 *   $env:SHIPROCKET_PASSWORD="..."
 *   node scratch/evidence.js
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Load env files (priority: .env.production > .env.local > .env) ─────────
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
    return true;
}

const root = path.join(__dirname, '..');
['.env.production', '.env.local', '.env'].forEach(f => {
    const full = path.join(root, f);
    const loaded = loadEnvFile(full);
    if (loaded) console.log('[env] loaded:', full);
    else console.log('[env] not found:', full);
});

// ── RAW VALUE DUMP (exactly as requested) ─────────────────────────────────
console.log('\n── RAW process.env values (immediately after file loading) ──');
console.log('process.cwd()                 :', process.cwd());
console.log('SHOPIFY_SHOP_DOMAIN           :', JSON.stringify(process.env.SHOPIFY_SHOP_DOMAIN));
console.log('SHOPIFY_CLIENT_ID             :', JSON.stringify(process.env.SHOPIFY_CLIENT_ID));
console.log('SHOPIFY_CLIENT_SECRET         :', JSON.stringify(process.env.SHOPIFY_CLIENT_SECRET));
console.log('SHOPIFY_API_SECRET            :', JSON.stringify(process.env.SHOPIFY_API_SECRET));
console.log('SHOPIFY_ACCESS_TOKEN          :', JSON.stringify(process.env.SHOPIFY_ACCESS_TOKEN));
console.log('SHIPROCKET_EMAIL              :', JSON.stringify(process.env.SHIPROCKET_EMAIL));
console.log('SHIPROCKET_PASSWORD           :', JSON.stringify(process.env.SHIPROCKET_PASSWORD));
console.log('\n── All SHOPIFY_* and SHIPROCKET_* keys in process.env ──');
const relevantKeys = Object.keys(process.env).filter(k =>
    k.startsWith('SHOPIFY') || k.startsWith('SHIPROCKET')
);
if (relevantKeys.length === 0) {
    console.log('(none found)');
} else {
    relevantKeys.forEach(k => {
        const v = process.env[k];
        const display = v === '' ? '(empty string "")'
                      : v === undefined ? '(undefined)'
                      : `"${v.slice(0, 20)}${v.length > 20 ? '...' : ''}"`;
        console.log(`  ${k}: ${display}`);
    });
}
console.log('────────────────────────────────────────────────────────────');



// ── HTTPS helper — logs URL, status, full body ────────────────────────────
function request(method, hostname, urlPath, headers, body) {
    return new Promise((resolve, reject) => {
        const bodyStr = body ? JSON.stringify(body) : undefined;
        const opts = {
            hostname,
            path: urlPath,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
                ...headers,
            },
        };

        // Mask auth header in log
        const logHeaders = { ...opts.headers };
        if (logHeaders['Authorization']) logHeaders['Authorization'] = 'Bearer ***MASKED***';
        if (logHeaders['X-Shopify-Access-Token']) logHeaders['X-Shopify-Access-Token'] = '***MASKED***';

        console.log(`\n  → ${method} https://${hostname}${urlPath}`);

        const req = https.request(opts, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

function sep(title) {
    console.log('\n' + '═'.repeat(60));
    console.log(' ' + title);
    console.log('═'.repeat(60));
}

function printJSON(label, obj) {
    console.log(`\n${label}:`);
    console.log(JSON.stringify(obj, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────
async function run() {
    const shopifyDomain   = process.env.SHOPIFY_SHOP_DOMAIN;
    const shopifyClientId = process.env.SHOPIFY_CLIENT_ID;
    const shopifySecret   = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;
    const shopifyToken    = process.env.SHOPIFY_ACCESS_TOKEN;
    const srEmail         = process.env.SHIPROCKET_EMAIL;
    const srPassword      = process.env.SHIPROCKET_PASSWORD;

    function status(val) {
        if (val === undefined) return '❌ undefined (key not in any env file)';
        if (val === '')        return '❌ EMPTY STRING — key exists but value is blank (Vercel redacted it)';
        return `✅ set (${val.slice(0, 20)}${val.length > 20 ? '...' : ''})`;
    }

    sep('0. ENVIRONMENT CHECK');
    console.log('SHOPIFY_SHOP_DOMAIN  :', status(shopifyDomain));
    console.log('SHOPIFY_CLIENT_ID    :', status(shopifyClientId));
    console.log('SHOPIFY_CLIENT_SECRET:', status(process.env.SHOPIFY_CLIENT_SECRET));
    console.log('SHOPIFY_API_SECRET   :', status(process.env.SHOPIFY_API_SECRET));
    console.log('SHOPIFY_ACCESS_TOKEN :', status(shopifyToken));
    console.log('SHIPROCKET_EMAIL     :', status(srEmail));
    console.log('SHIPROCKET_PASSWORD  :', status(srPassword));

    if (!shopifyDomain) {
        if (shopifyDomain === '') {
            console.error('\n❌ SHOPIFY_SHOP_DOMAIN key exists but value is EMPTY.');
            console.error('   Vercel CLI redacts encrypted secrets when pulling locally.');
            console.error('   You must set the values manually in PowerShell:');
            console.error('   $env:SHOPIFY_SHOP_DOMAIN="your-store.myshopify.com"');
            console.error('   $env:SHOPIFY_CLIENT_ID="..."');
            console.error('   $env:SHOPIFY_CLIENT_SECRET="..."');
            console.error('   $env:SHIPROCKET_EMAIL="..."');
            console.error('   $env:SHIPROCKET_PASSWORD="..."');
            console.error('   node scratch/evidence.js');
        } else {
            console.error('\n❌ SHOPIFY_SHOP_DOMAIN is not in any env file and not set in shell.');
        }
        process.exit(1);
    }


    // ── STEP 1: Shopify auth ──────────────────────────────────────────────
    sep('1. SHOPIFY AUTHENTICATION');
    let shopToken = shopifyToken;

    if (!shopToken) {
        if (!shopifyClientId || !shopifySecret) {
            console.error('❌ Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET');
            process.exit(1);
        }
        const body = `grant_type=client_credentials&client_id=${encodeURIComponent(shopifyClientId)}&client_secret=${encodeURIComponent(shopifySecret)}`;
        const tokenRes = await (new Promise((resolve, reject) => {
            const opts = {
                hostname: shopifyDomain,
                path: '/admin/oauth/access_token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                },
            };
            console.log(`  → POST https://${shopifyDomain}/admin/oauth/access_token`);
            const req = https.request(opts, (res) => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => {
                    let parsed;
                    try { parsed = JSON.parse(data); } catch(_) { parsed = data; }
                    resolve({ status: res.statusCode, body: parsed });
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        }));

        console.log('  HTTP Status:', tokenRes.status);
        if (tokenRes.status !== 200 || !tokenRes.body?.access_token) {
            console.error('❌ Shopify token fetch failed');
            printJSON('Response body', tokenRes.body);
            process.exit(1);
        }
        shopToken = tokenRes.body.access_token;
        console.log('  ✅ Access token obtained');
    } else {
        console.log('  Using SHOPIFY_ACCESS_TOKEN directly');
    }

    // ── STEP 2: Shopify order lookup ──────────────────────────────────────
    sep('2. SHOPIFY ORDER LOOKUP — name=#1003 status=any');
    const orderRes = await request(
        'GET', shopifyDomain,
        '/admin/api/2024-07/orders.json?name=%231003&status=any',
        { 'X-Shopify-Access-Token': shopToken }
    );

    console.log('  HTTP Status:', orderRes.status);

    if (orderRes.status !== 200) {
        console.error('❌ Order lookup failed');
        printJSON('Response body', orderRes.body);
        process.exit(1);
    }

    const orders = orderRes.body?.orders || [];
    console.log(`  Orders returned: ${orders.length}`);

    if (orders.length === 0) {
        console.error('\n❌ No orders found with name=#1003');
        console.error('   Possible causes:');
        console.error('   1. Wrong SHOPIFY_SHOP_DOMAIN');
        console.error('   2. Credentials lack orders read scope');
        console.error('   3. Order number format issue (try without #)');
        process.exit(1);
    }

    sep('2a. RAW SHOPIFY ORDER JSON');
    printJSON('Full orders[] array', orders);

    const order = orders[0];
    sep('2b. EXTRACTED FULFILLMENT FIELDS');
    console.log('  order.name              :', order.name);
    console.log('  order.email             :', order.email);
    console.log('  order.fulfillment_status:', order.fulfillment_status);
    console.log('  order.fulfillments count:', (order.fulfillments || []).length);

    const fulfillments = order.fulfillments || [];
    if (fulfillments.length === 0) {
        console.log('\n  ⚠️  order.fulfillments[] is EMPTY in Shopify response');
        console.log('     This means Shopify has NO record of any shipment.');
        console.log('     Order was likely shipped via Shiprocket dashboard only.');
    } else {
        fulfillments.forEach((f, i) => {
            console.log(`\n  fulfillments[${i}]:`);
            console.log('    id              :', f.id);
            console.log('    status          :', f.status);
            console.log('    shipment_status :', f.shipment_status);
            console.log('    tracking_number :', f.tracking_number === null ? 'null ← ⚠️ NO AWB' : f.tracking_number);
            console.log('    tracking_company:', f.tracking_company || '(null)');
            console.log('    tracking_urls   :', JSON.stringify(f.tracking_urls || []));
        });
    }

    // Check if any fulfillment has a tracking number
    const withAWB = fulfillments.filter(f => f.tracking_number);
    if (withAWB.length > 0) {
        console.log('\n  ✅ AWB found in Shopify fulfillments — no Shiprocket fallback needed');
        console.log('     AWB           :', withAWB[0].tracking_number);
        console.log('     Carrier       :', withAWB[0].tracking_company);
    } else {
        console.log('\n  → No AWB in Shopify. Proceeding to Shiprocket fallback...');
    }

    // ── STEP 3: Shiprocket auth ───────────────────────────────────────────
    sep('3. SHIPROCKET AUTHENTICATION');
    if (!srEmail || !srPassword) {
        console.error('❌ SHIPROCKET_EMAIL or SHIPROCKET_PASSWORD missing — cannot query Shiprocket');
        process.exit(1);
    }

    const srAuthRes = await request(
        'POST',
        'apiv2.shiprocket.in',
        '/v1/external/auth/login',
        {},
        { email: srEmail, password: srPassword }
    );

    console.log('  HTTP Status:', srAuthRes.status);
    if (srAuthRes.status !== 200 || !srAuthRes.body?.token) {
        console.error('❌ Shiprocket authentication failed');
        printJSON('Response body', srAuthRes.body);
        process.exit(1);
    }
    const srToken = srAuthRes.body.token;
    console.log('  ✅ Shiprocket token obtained');

    // ── STEP 4: Shiprocket /orders?search=1003 ────────────────────────────
    sep('4. SHIPROCKET ORDERS SEARCH — GET /orders?search=1003&per_page=10');
    const srOrdersRes = await request(
        'GET',
        'apiv2.shiprocket.in',
        '/v1/external/orders?search=1003&per_page=10',
        { Authorization: `Bearer ${srToken}` }
    );

    console.log('  HTTP Status:', srOrdersRes.status);
    printJSON('Complete raw Shiprocket /orders response', srOrdersRes.body);

    const srOrders = srOrdersRes.body?.data || [];
    console.log(`\n  Orders in Shiprocket result: ${srOrders.length}`);

    sep('4a. SHIPROCKET ORDER FIELDS (for each result)');
    if (srOrders.length === 0) {
        console.log('  ❌ No orders returned from Shiprocket for search=1003');
        console.log('  Searched value :', '1003');
        console.log('  Endpoint URL   :', 'https://apiv2.shiprocket.in/v1/external/orders?search=1003&per_page=10');
        console.log('  HTTP Status    :', srOrdersRes.status);
        console.log('  Response body  : (printed above)');
    } else {
        srOrders.forEach((o, i) => {
            console.log(`\n  srOrders[${i}]:`);
            console.log('    order_id         :', o.id);
            console.log('    channel_order_id :', o.channel_order_id);
            console.log('    awb_code         :', o.awb_code || '(null) ← ⚠️ NO AWB');
            console.log('    shipment_id      :', o.shipment_id);
            console.log('    courier_name     :', o.courier_name);
            console.log('    status           :', o.status);
        });
    }

    // ── STEP 5: AWB tracking lookup ───────────────────────────────────────
    const awb = srOrders.find(o =>
        String(o.channel_order_id).replace(/^#/, '') === '1003' ||
        String(o.id) === '1003'
    )?.awb_code;

    if (!awb) {
        console.log('\n  ❌ No AWB found for order #1003 in Shiprocket orders search');
        console.log('  The Shiprocket /orders?search=1003 endpoint did not return a matching order with an awb_code.');
        console.log('  Possible causes:');
        console.log('    1. channel_order_id in Shiprocket does not match "1003"');
        console.log('    2. AWB was added to AfterShip manually, not via Shiprocket');
        console.log('    3. The order uses a different identifier in Shiprocket');
        console.log('\n  channel_order_ids found:', srOrders.map(o => o.channel_order_id));
    } else {
        sep(`5. SHIPROCKET TRACKING — GET /courier/track/awb/${awb}`);
        const trackRes = await request(
            'GET',
            'apiv2.shiprocket.in',
            `/v1/external/courier/track/awb/${awb}`,
            { Authorization: `Bearer ${srToken}` }
        );
        console.log('  HTTP Status:', trackRes.status);
        printJSON('Complete Shiprocket tracking response', trackRes.body);
    }

    // Write all evidence to a file for reference
    const outPath = path.join(__dirname, 'evidence_1003.json');
    fs.writeFileSync(outPath, JSON.stringify({
        shopify_orders: orderRes.body,
        shiprocket_orders: srOrdersRes.body,
    }, null, 2));
    console.log(`\n✅ Evidence written to: ${outPath}`);
}

run().catch(err => {
    console.error('\nFatal error:', err.message);
    process.exit(1);
});
