const axios = require('axios');

const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
    console.error('[shopify] Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ACCESS_TOKEN env vars');
}

const shopifyClient = axios.create({
    baseURL: `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2024-07`,
    headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
    },
});

/**
 * Look up an order by order number and customer email.
 * Returns the order object including fulfillments and tracking info.
 *
 * @param {string} orderNumber - e.g. "1001" or "#1001"
 * @param {string} email - customer email address
 * @returns {object|null} - order object or null if not found
 */
async function getOrderByNumberAndEmail(orderNumber, email) {
    // Strip leading # if present
    const cleanNumber = orderNumber.replace(/^#/, '').trim();

    try {
        const response = await shopifyClient.get('/orders.json', {
            params: {
                name: `#${cleanNumber}`,
                status: 'any',
                fields: 'id,name,email,fulfillment_status,fulfillments,line_items,created_at,financial_status',
            },
        });

        const orders = response.data.orders;

        if (!orders || orders.length === 0) {
            return null;
        }

        // Match email case-insensitively for security
        const matched = orders.find(
            (o) => o.email && o.email.toLowerCase() === email.toLowerCase().trim()
        );

        return matched || null;
    } catch (err) {
        console.error('[shopify] getOrderByNumberAndEmail error:', err?.response?.data || err.message);
        throw new Error('Failed to fetch order from Shopify');
    }
}

/**
 * Extract AWB (tracking) numbers from an order's fulfillments.
 * Returns an array of { awb, courier, fulfillment_id, status } objects.
 *
 * @param {object} order - Shopify order object
 * @returns {Array}
 */
function extractAWBFromOrder(order) {
    if (!order.fulfillments || order.fulfillments.length === 0) {
        return [];
    }

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

