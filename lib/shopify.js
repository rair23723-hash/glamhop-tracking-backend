const axios = require('axios');

const SHOPIFY_SHOP_DOMAIN    = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_ACCESS_TOKEN   = process.env.SHOPIFY_ACCESS_TOKEN;   // Custom App: static token from Admin → App → API credentials
const SHOPIFY_CLIENT_ID      = process.env.SHOPIFY_CLIENT_ID;      // kept for reference / proxy signature verification
const SHOPIFY_CLIENT_SECRET  = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET; // proxy sig verification

const TOKEN_EXPIRY_MS = 23 * 60 * 60 * 1000; // 23 hours

let tokenCache = { token: null, fetchedAt: null };

function isTokenValid() {
    if (!tokenCache.token || !tokenCache.fetchedAt) return false;
    return Date.now() - tokenCache.fetchedAt < TOKEN_EXPIRY_MS;
}

/**
 * Get a valid Shopify Admin API token.
 *
 * Priority:
 *   1. SHOPIFY_ACCESS_TOKEN — static token from a Custom App (Admin → Develop apps → install)
 *   2. client_credentials grant — uses SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET/SHOPIFY_API_SECRET
 *      Valid for Partner apps OR Custom Apps that are installed on the store.
 *
 * Token is cached in-memory for 23 hours (Vercel warm instance).
 */
async function getAccessToken() {
    // Prefer static token if set
    const staticToken = process.env.SHOPIFY_ACCESS_TOKEN;
    if (staticToken) return staticToken;

    // Use cached token if still valid
    if (isTokenValid()) return tokenCache.token;

    // OAuth client_credentials flow
    const domain       = process.env.SHOPIFY_SHOP_DOMAIN;
    const clientId     = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;

    if (!domain || !clientId || !clientSecret) {
        throw new Error(
            '[shopify] Missing credentials. Need either SHOPIFY_ACCESS_TOKEN, ' +
            'or all three of: SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET/SHOPIFY_API_SECRET'
        );
    }

    console.log(`[shopify] Requesting access token via client_credentials for ${domain}`);
    console.log(`[shopify] client_id prefix: ${clientId.slice(0, 6)}...`);

    try {
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);

        const response = await axios.post(
            `https://${domain}/admin/oauth/access_token`,
            params.toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        );

        const token = response.data?.access_token;
        if (!token) throw new Error('No access_token in OAuth response');

        tokenCache = { token, fetchedAt: Date.now() };
        console.log('[shopify] ✅ Access token obtained via client_credentials');
        return token;

    } catch (err) {
        const status  = err?.response?.status;
        const body    = err?.response?.data;
        const message = (typeof body === 'string' ? body : body?.error_description) || err.message;
        console.error(`[shopify] ❌ client_credentials failed (HTTP ${status}):`);
        console.error('[shopify]    Raw response:', JSON.stringify(body));
        throw new Error(`Shopify token fetch failed (${status}): ${message}`);
    }
}


/**
 * Look up an order by order number and customer email.
 */
async function getOrderByNumberAndEmail(orderNumber, email) {
    const cleanNumber = orderNumber.replace(/^#/, '').trim();
    const token = await getAccessToken();

    try {
        const response = await axios.get(
            `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2024-07/orders.json`,
            {
                headers: {
                    'X-Shopify-Access-Token': token,
                    'Content-Type': 'application/json',
                },
                params: {
                    name: `#${cleanNumber}`,
                    status: 'any',
                    fields: 'id,name,email,fulfillment_status,fulfillments,line_items,created_at,financial_status',
                },
                timeout: 10000,
            }
        );

        const orders = response.data.orders;
        if (!orders || orders.length === 0) return null;

        const matched = orders.find(
            (o) => o.email && o.email.toLowerCase() === email.toLowerCase().trim()
        );

        // ── DIAGNOSTIC: print full raw Shopify order before any extraction ──
        if (matched) {
            console.log('[shopify] ✅ Raw Shopify order JSON (before AWB extraction):');
            console.log(JSON.stringify(matched, null, 2));
        } else {
            console.log('[shopify] ❌ No order matched for email:', email);
        }

        return matched || null;

    } catch (err) {
        if (err?.response?.status === 401) {
            console.error('[shopify] 401 Unauthorized — SHOPIFY_ACCESS_TOKEN is invalid or lacks Orders read scope.');
            console.error('[shopify] Go to Shopify Admin → Apps → Develop apps → your app → API credentials → reveal token.');
        }
        console.error('[shopify] getOrderByNumberAndEmail error:', err?.response?.data || err.message);
        throw new Error('Failed to fetch order from Shopify');
    }
}

/**
 * Extract AWB numbers from order fulfillments.
 */
function extractAWBFromOrder(order) {
    console.log('[shopify] order.fulfillments raw array:',
        JSON.stringify(order.fulfillments || [], null, 2));

    if (!order.fulfillments || order.fulfillments.length === 0) {
        console.log('[shopify] ⚠️  No fulfillments on order — flow stops here (Not Yet Shipped).');
        return [];
    }

    const result = order.fulfillments
        .filter((f) => f.tracking_number)
        .map((f) => ({
            awb: f.tracking_number,
            courier: f.tracking_company || 'Shiprocket',
            fulfillment_id: f.id,
            status: f.shipment_status || f.status,
            created_at: f.created_at,
        }));

    if (result.length === 0) {
        console.log('[shopify] ⚠️  Fulfillments exist but ALL have null tracking_number — Shiprocket will NOT be called.');
    } else {
        console.log('[shopify] ✅ Extracted fulfillments with AWB:');
        console.log(JSON.stringify(result, null, 2));
    }

    return result;
}

module.exports = { getOrderByNumberAndEmail, extractAWBFromOrder };
