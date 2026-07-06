const fs = require('fs');
const path = require('path');
const { verifyProxySignature } = require('../lib/verifyProxy');

/**
 * App Proxy root endpoint.
 * Shopify proxies glamhop.in/apps/tracking → this function.
 * Returns a Liquid template string which Shopify renders inside the Fabric theme.
 *
 * Content-Type must be application/liquid for Shopify to render it as Liquid.
 */
module.exports = async function handler(req, res) {
    // Only allow GET requests
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Verify this request came from Shopify App Proxy
    if (!verifyProxySignature(req.query)) {
        console.warn('[index] Invalid proxy signature — request rejected');
        return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
        const templatePath = path.join(process.cwd(), 'templates', 'tracking.liquid');
        const liquidTemplate = fs.readFileSync(templatePath, 'utf8');

        // Shopify renders this as Liquid inside the active theme (Fabric)
        res.setHeader('Content-Type', 'application/liquid');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).send(liquidTemplate);
    } catch (err) {
        console.error('[index] Failed to read tracking template:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

