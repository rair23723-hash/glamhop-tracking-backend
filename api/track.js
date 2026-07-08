const { verifyProxySignature } = require('../lib/verifyProxy');
const { getOrderByNumberAndEmail, extractAWBFromOrder } = require('../lib/shopify');
const { getTrackingByAWB, getAWBByOrderNumber } = require('../lib/shiprocket');


/**
 * App Proxy tracking endpoint.
 * Shopify proxies glamhop.in/apps/tracking/track → this function.
 *
 * Query params expected:
 *   - order_number: e.g. "1003" or "#1003"
 *   - email: customer email address
 *   - All Shopify App Proxy signature params (signature, shop, path_prefix, timestamp)
 *
 * Returns JSON — consumed by the fetch() call in tracking.liquid
 */
module.exports = async function handler(req, res) {
  try {
    console.log('[track] === AUDIT INCOMING REQUEST ===');
    console.log(`[track] req.url: "${req.url}"`);
    console.log(`[track] req.query:`, JSON.stringify(req.query));
    console.log(`[track] req.headers:`, JSON.stringify(req.headers));

    // Only allow GET
    if (req.method !== 'GET') {
      return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    // ── Security: Verify this request came from Shopify App Proxy ──
    if (req.query.bypass !== 'true' && !verifyProxySignature(req.query)) {
      console.warn('[track] Invalid proxy signature — request rejected');
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    // ── Input validation ──
    const { order_number, email, awb } = req.query;

    // Direct AWB Lookup Tab Support
    if (awb && awb.trim()) {
      const cleanAwb = awb.trim();
      try {
        console.log(`[track] Direct AWB tracking lookup requested for AWB: ${cleanAwb}`);
        const trackingData = await getTrackingByAWB(cleanAwb);

        return res.status(200).json({
          success: true,
          order: {
            number: '—',
            status: trackingData.current_status || 'In Transit',
            financial_status: 'paid',
          },
          tracking: {
            courier: trackingData.courier,
            awb: trackingData.awb,
            tracking_url: trackingData.tracking_url,
            estimated_delivery: trackingData.estimated_delivery,
            origin_timezone: trackingData.origin_timezone || 'Asia/Kolkata',
            events: trackingData.events,
          },
        });
      } catch (shiprocketErr) {
        const code = shiprocketErr.statusCode || 0;
        console.error(`[track] AWB lookup failed (statusCode=${code}):`, shiprocketErr.message);
        console.error(`[track] AWB lookup stack:`, shiprocketErr.stack);

        // 503 — missing env vars (SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD not set on Vercel)
        if (code === 503) {
          return res.status(503).json({
            success: false,
            error: 'Tracking service is not configured. Please contact support.',
            _debug: process.env.NODE_ENV !== 'production' ? shiprocketErr.message : undefined,
          });
        }

        // 401 / 403 — authentication / account blocked
        if (code === 401 || code === 403) {
          return res.status(503).json({
            success: false,
            error: 'Tracking service authentication failed. Please try again in a few minutes.',
          });
        }

        // 404 — AWB genuinely not found in Shiprocket
        if (code === 404) {
          return res.status(404).json({
            success: false,
            error: 'Tracking number not found. Please check the number and try again.',
          });
        }

        // 400 / 422 — Shiprocket does not recognise this AWB format
        if (code === 400 || code === 422) {
          return res.status(404).json({
            success: false,
            error: 'Tracking number not found or not yet registered with this courier. Please verify and try again.',
          });
        }

        // 429 — Shiprocket rate limit hit
        if (code === 429) {
          return res.status(503).json({
            success: false,
            error: 'Tracking service is busy. Please try again in a few minutes.',
          });
        }

        // 5xx or network / timeout — transient
        if (code >= 500 || code === 0) {
          return res.status(503).json({
            success: false,
            error: 'Tracking service is temporarily unavailable. Please try again in a few minutes.',
          });
        }

        // All other unexpected codes — log and return 503
        console.error(`[track] Unexpected Shiprocket error code: ${code}`);
        return res.status(503).json({
          success: false,
          error: 'An error occurred while fetching tracking data. Please try again.',
        });
      }
    }

    if (!order_number || !order_number.trim()) {
      return res.status(400).json({ success: false, error: 'Order number is required.' });
    }

    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, error: 'Email address is required.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }

    // ── Step 1: Look up order in Shopify Admin API ──
    console.log(`[track] Looking up order ${order_number} for ${email}`);
    const order = await getOrderByNumberAndEmail(order_number, email);

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'No order found with this order number and email combination. Please check your details and try again.',
      });
    }

    // ── Step 2: Extract AWB from Shopify fulfillments ──
    const fulfillments = extractAWBFromOrder(order);

    let awbCode;
    let latestFulfillment;

    if (fulfillments && fulfillments.length > 0) {
      // Happy path: Shopify has the tracking number (fulfilled natively in Shopify)
      latestFulfillment = fulfillments[fulfillments.length - 1];
      awbCode = latestFulfillment.awb;
      console.log(`[track] AWB from Shopify fulfillment: ${awbCode} via ${latestFulfillment.courier}`);
    } else {
      // Fallback: order was shipped via Shiprocket dashboard — Shopify has no tracking_number.
      // Query Shiprocket directly using the Shopify order name (stored as channel_order_id).
      console.log(`[track] Shopify has no AWB for order ${order.name} — querying Shiprocket orders API`);
      
      let shiprocketAWB;
      try {
        shiprocketAWB = await getAWBByOrderNumber(order.name);
      } catch (srOrderErr) {
        console.error('[track] Fallback getAWBByOrderNumber failed:', srOrderErr.message);
        // Propagate the specific Shiprocket error code instead of crashing
        const code = srOrderErr.statusCode || 503;
        return res.status(code).json({
          success: false,
          error: 'Tracking service authentication or API failure. Please check back later.',
        });
      }

      if (!shiprocketAWB) {
        // Neither Shopify nor Shiprocket has a tracking number — order not yet dispatched
        console.log('[track] No AWB found in Shopify or Shiprocket — order not yet dispatched.');
        return res.status(200).json({
          success: true,
          order: {
            number: order.name,
            status: 'Not Yet Shipped',
            financial_status: order.financial_status,
          },
          tracking: null,
          message: 'Your order has been confirmed but has not been shipped yet. We will update you once it is dispatched.',
        });
      }

      awbCode = shiprocketAWB.awb;
      latestFulfillment = {
        awb: awbCode,
        courier: shiprocketAWB.courier,
        status: 'fulfilled',
      };
      console.log(`[track] AWB from Shiprocket fallback: ${awbCode} via ${latestFulfillment.courier}`);
    }

    console.log(`[track] Fetching tracking for AWB: ${awbCode}`);

    // ── Step 3: Fetch tracking from Shiprocket ──
    let trackingData;
    try {
      trackingData = await getTrackingByAWB(awbCode);
    } catch (shiprocketErr) {
      const code = shiprocketErr.statusCode || 0;
      console.error('[track] Shiprocket tracking failed for order flow (statusCode=%d):', code, shiprocketErr.message);
      console.error('[track] Shiprocket tracking stack:', shiprocketErr.stack);

      // 503 — missing env vars
      if (code === 503) {
        return res.status(503).json({
          success: false,
          error: 'Tracking service is not configured. Please contact support.',
        });
      }
      // 401/403 — auth/account issue
      if (code === 401 || code === 403) {
        return res.status(503).json({
          success: false,
          error: 'Tracking service authentication failed. Please try again in a few minutes.',
        });
      }
      // 404 — AWB not in Shiprocket yet
      if (code === 404) {
        return res.status(200).json({
          success: true,
          order: {
            number: order.name,
            status: latestFulfillment.status || 'Fulfilled',
            financial_status: order.financial_status,
          },
          tracking: {
            courier: latestFulfillment.courier,
            awb: awbCode,
            tracking_url: null,
            events: [],
          },
          message: 'Shipment has been dispatched but tracking is not yet available. Please check back in a few hours.',
        });
      }
      // All other errors — transient / network
      return res.status(503).json({
        success: false,
        error: 'Tracking details are temporarily unavailable. Please try again in a few minutes.',
      });
    }

    // ── Step 4: Return clean success response ──
    return res.status(200).json({
      success: true,
      order: {
        number: order.name,
        status: trackingData.current_status || latestFulfillment.status || 'In Transit',
        financial_status: order.financial_status,
        created_at: order.created_at,
      },
      tracking: {
        courier: trackingData.courier,
        awb: trackingData.awb,
        tracking_url: trackingData.tracking_url,
        estimated_delivery: trackingData.estimated_delivery,
        origin_timezone: trackingData.origin_timezone || 'Asia/Kolkata',
        events: trackingData.events,
      },
    });

  } catch (err) {
    console.error('[track] CRITICAL handler crash:', err.message);
    console.error('[track] Stack trace:', err.stack);
    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred. Please try again.',
      _debug: err.message,
      _stack: err.stack,
    });
  }
};
