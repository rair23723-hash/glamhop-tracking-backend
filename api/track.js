const { verifyProxySignature } = require('../lib/verifyProxy');
const { getOrderByNumberAndEmail, extractAWBFromOrder } = require('../lib/shopify');
const { getTrackingByAWB } = require('../lib/shiprocket');

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
  console.log('[track] === AUDIT INCOMING REQUEST ===');
  console.log(`[track] req.url: "${req.url}"`);
  console.log(`[track] req.query:`, JSON.stringify(req.query));
  console.log(`[track] req.headers:`, JSON.stringify(req.headers));

  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // ── Security: Verify this request came from Shopify App Proxy ──
  if (!verifyProxySignature(req.query)) {
    console.warn('[track] Invalid proxy signature — request rejected');
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }

  // ── Input validation ──
  const { order_number, email } = req.query;

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

  try {
    // ── Step 1: Look up order in Shopify Admin API ──
    console.log(`[track] Looking up order ${order_number} for ${email}`);
    const order = await getOrderByNumberAndEmail(order_number, email);

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'No order found with this order number and email combination. Please check your details and try again.',
      });
    }

    // ── Step 2: Extract AWB from fulfillments ──
    const fulfillments = extractAWBFromOrder(order);

    if (!fulfillments || fulfillments.length === 0) {
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

    // Use the most recent fulfillment (last in array = most recent)
    const latestFulfillment = fulfillments[fulfillments.length - 1];
    const awb = latestFulfillment.awb;

    console.log(`[track] Found AWB: ${awb} via ${latestFulfillment.courier}`);

    // ── Step 3: Fetch tracking from Shiprocket ──
    let trackingData;
    try {
      trackingData = await getTrackingByAWB(awb);
    } catch (shiprocketErr) {
      console.error('[track] Shiprocket tracking failed:', shiprocketErr.message);

      // Return order info even if Shiprocket fails — better than a blank error
      return res.status(200).json({
        success: true,
        order: {
          number: order.name,
          status: latestFulfillment.status || 'Fulfilled',
          financial_status: order.financial_status,
        },
        tracking: {
          courier: latestFulfillment.courier,
          awb,
          tracking_url: null,
          events: [],
        },
        message: 'Tracking details are temporarily unavailable. Please try again in a few minutes.',
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
        events: trackingData.events,
      },
    });

  } catch (err) {
    console.error('[track] Unhandled error:', err.message);

    // Do not expose internal error details to the client
    return res.status(500).json({
      success: false,
      error: 'Something went wrong on our end. Please try again in a few minutes.',
    });
  }
};
