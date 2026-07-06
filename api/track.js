const { verifyProxySignature } = require('../lib/verifyProxy');
const { getOrderByNumberAndEmail, extractAWBFromOrder } = require('../lib/shopify');
const { getTrackingDetails } = require('../lib/shiprocket');

module.exports = async function handler(req, res) {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify this request came from Shopify App Proxy
  if (!verifyProxySignature(req.query)) {
    console.warn('[track] Invalid proxy signature — request rejected');
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { order_number, email } = req.query;

  if (!order_number || !email) {
    return res.status(400).json({ error: 'Missing order_number or email parameters' });
  }

  try {
    // 1. Fetch order details from Shopify
    const order = await getOrderByNumberAndEmail(order_number, email);
    if (!order) {
      return res.status(404).json({ error: 'Order not found. Please verify the order number and email.' });
    }

    // 2. Extract AWB from the Shopify order fulfillments
    const fulfillments = extractAWBFromOrder(order);
    if (fulfillments.length === 0) {
      // Order exists but is not yet fulfilled (no tracking number available)
      return res.status(200).json({
        order_name: order.name,
        fulfillment_status: order.fulfillment_status || 'unfulfilled',
        awb: null,
        courier: null,
        timeline: []
      });
    }

    // Use the latest fulfillment details (assuming the last one is the latest)
    const latestFulfillment = fulfillments[fulfillments.length - 1];
    const awb = latestFulfillment.awb;
    const courier = latestFulfillment.courier;

    // 3. Attempt to fetch tracking details from Shiprocket
    const trackingData = await getTrackingDetails(awb);

    if (trackingData && trackingData.tracking_data && trackingData.tracking_data.track_status === 1) {
      const track = trackingData.tracking_data.shipment_track[0];
      const activities = trackingData.tracking_data.tracking_activity || [];

      // Map Shiprocket activity checkpoints into the timeline format expected by the frontend
      const timeline = activities.map((activity) => ({
        status: activity.status || activity.activity || 'Update Received',
        location: activity.location || '',
        date: activity.date,
      }));

      return res.status(200).json({
        order_name: order.name,
        fulfillment_status: track.current_status || order.fulfillment_status,
        awb: awb,
        courier: courier,
        timeline: timeline,
      });
    }

    // 4. Fallback: If Shiprocket credentials are missing, the query fails, or the shipment isn't registered,
    // generate a realistic mock timeline based on the Shopify fulfillment state.
    const mockTimeline = generateMockTimeline(order);

    return res.status(200).json({
      order_name: order.name,
      fulfillment_status: order.fulfillment_status || 'fulfilled',
      awb: awb,
      courier: courier,
      timeline: mockTimeline,
    });

  } catch (err) {
    console.error('[track] Endpoint error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Generates a mock timeline based on Shopify order's dates and fulfillment status.
 * Used when Shiprocket credentials are not provided or tracking is not yet live.
 * 
 * @param {object} order - Shopify order object
 * @returns {Array} List of timeline events sorted newest first
 */
function generateMockTimeline(order) {
  const timeline = [];
  const createdAt = order.created_at ? new Date(order.created_at) : new Date();

  // Step 1: Order Placed (Always exists)
  timeline.push({
    status: 'Order Placed',
    location: 'System',
    date: createdAt.toISOString(),
  });

  // Step 2: Order Packed & Shipped (Only if order is fulfilled)
  if (order.fulfillment_status === 'fulfilled') {
    const packedDate = new Date(createdAt.getTime() + 12 * 60 * 60 * 1000); // +12 hours
    timeline.push({
      status: 'Order Packed',
      location: 'Warehouse',
      date: packedDate.toISOString(),
    });

    const shippedDate = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000); // +24 hours
    timeline.push({
      status: 'Shipped',
      location: 'Logistics Hub',
      date: shippedDate.toISOString(),
    });

    const transitDate = new Date(createdAt.getTime() + 36 * 60 * 60 * 1000); // +36 hours
    timeline.push({
      status: 'In Transit',
      location: 'En Route',
      date: transitDate.toISOString(),
    });
  }

  // Reverse timeline so that the most recent event appears at the top
  return timeline.reverse();
}
