const axios = require('axios');

const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;

const TOKEN_EXPIRY_MS = 23 * 60 * 60 * 1000; // 23 hours (token lasts 24hr)

/**
 * In-memory token cache — same pattern as shiprocket.js
 * Safe for Vercel serverless warm instances.
 */
let tokenCache = {
    token: null,
    fetchedAt: null,
};

function isTokenValid() {
    if (!tokenCache.token || !tokenCache.fetchedAt) return false;
    return Date.now() - tokenCache.fetchedAt < TOKEN_EXPIRY_MS;
}

/**
 * Generate a new Admin API access token using Client Credentials Grant.
 * This is the correct auth method for Dev Dashboard custom apps (post-2026).
 *
 * Docs: https://shopify.dev/docs/apps/build/authentication-authorization
 */
async function generateAccessToken() {
    if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
        throw new Error('[shopify] SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET env var is missing');
    }

    try {
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', SHOPIFY_CLIENT_ID);
        params.append('client_secret', SHOPIFY_CLIENT_SECRET);

        const response = await axios.post(
            `https://${SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`,
            params.toString(),
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10000,
            }
        );

        const token = response.data?.access_token;
        if (!token) throw new Error('No access_token in response');

        tokenCache = { token, fetchedAt: Date.now() };
        console.log('[shopify] Access token refreshed successfully');
        return token;

    } catch (err) {
        const message = err?.response?.data?.error_description || err.message;
        console.error('[shopify] Token generation failed:', message);
        throw new Error(`Shopify token generation failed: ${message}`);
    }
}

/**
 * Get a valid Admin API token — from cache or by generating a new one.
 */
async function getAccessToken() {
    if (isTokenValid()) return tokenCache.token;
    return await generateAccessToken();
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

        return matched || null;

    } catch (err) {
        // If 401 — token may have expired mid-session, clear cache and retry once
        if (err?.response?.status === 401) {
            console.warn('[shopify] 401 on order lookup — clearing token cache');
            tokenCache = { token: null, fetchedAt: null };
            const freshToken = await getAccessToken();

            const retry = await axios.get(
                `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2024-07/orders.json`,
                {
                    headers: { 'X-Shopify-Access-Token': freshToken },
                    params: {
                        name: `#${cleanNumber}`,
                        status: 'any',
                        fields: 'id,name,email,fulfillment_status,fulfillments,line_items,created_at,financial_status',
                    },
                    timeout: 10000,
                }
            );
            const orders = retry.data.orders;
            if (!orders || orders.length === 0) return null;
            return orders.find(
                (o) => o.email && o.email.toLowerCase() === email.toLowerCase().trim()
            ) || null;
        }

        console.error('[shopify] getOrderByNumberAndEmail error:', err?.response?.data || err.message);
        throw new Error('Failed to fetch order from Shopify');
    }
}

/**
 * Extract AWB numbers from order fulfillments.
 */
function extractAWBFromOrder(order) {
    if (!order.fulfillments || order.fulfillments.length === 0) return [];

    return order.fulfillments
        .filter((f) => f.tracking_number)
        .map((f) => ({
            awb: f.tracking_number,
            courier: f.tracking_company || 'Shiprocket',
            fulfillment_id: f.id,
            status: f.shipment_status || f.status,
            created_at: f.created_at,
        }));
}

module.exports = { getOrderByNumberAndEmail, extractAWBFromOrder };
