const axios = require('axios');

const SHIPROCKET_BASE_URL = 'https://apiv2.shiprocket.in/v1/external';
const TOKEN_EXPIRY_MS = 23 * 60 * 60 * 1000; // 23 hours (Shiprocket tokens last 24hr)
const REQUEST_TIMEOUT_MS = 10000; // 10 seconds
const MAX_RETRIES = 2;

/**
 * In-memory token cache.
 * Vercel serverless functions share state within a warm instance.
 * Token is re-fetched on cold starts or expiry — this is expected and safe.
 */
let tokenCache = {
  token: null,
  fetchedAt: null,
};

/**
 * Check if the cached token is still valid.
 */
function isTokenValid() {
  if (!tokenCache.token || !tokenCache.fetchedAt) return false;
  return Date.now() - tokenCache.fetchedAt < TOKEN_EXPIRY_MS;
}

/**
 * Authenticate with Shiprocket and cache the JWT token.
 * Called automatically when token is missing or expired.
 *
 * @returns {string} JWT token
 */
async function authenticate() {
  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;

  if (!email || !password) {
    throw new Error('[shiprocket] SHIPROCKET_EMAIL or SHIPROCKET_PASSWORD env var is missing');
  }

  try {
    const response = await axios.post(
      `${SHIPROCKET_BASE_URL}/auth/login`,
      { email, password },
      { timeout: REQUEST_TIMEOUT_MS }
    );

    const token = response.data?.token;

    if (!token) {
      throw new Error('[shiprocket] Authentication succeeded but no token returned');
    }

    tokenCache = { token, fetchedAt: Date.now() };
    console.log('[shiprocket] Token refreshed successfully');
    return token;

  } catch (err) {
    const status = err?.response?.status;
    const message = err?.response?.data?.message || err.message;
    console.error(`[shiprocket] Authentication failed (${status}):`, message);
    throw new Error(`Shiprocket authentication failed: ${message}`);
  }
}

/**
 * Get a valid token — from cache or by re-authenticating.
 *
 * @returns {string} JWT token
 */
async function getToken() {
  if (isTokenValid()) return tokenCache.token;
  return await authenticate();
}

/**
 * Make an authenticated GET request to Shiprocket API.
 * Retries on 401 (token expired mid-session) and transient errors.
 *
 * @param {string} endpoint - API path (e.g. '/courier/track/awb/123456')
 * @param {number} attempt - internal retry counter
 * @returns {object} response data
 */
async function shiprocketGet(endpoint, attempt = 1) {
  const token = await getToken();

  try {
    const fullUrl = `${SHIPROCKET_BASE_URL}${endpoint}`;
    console.log('[shiprocket] ➡️  Sending GET request:');
    console.log(`[shiprocket]    URL     : ${fullUrl}`);
    console.log(`[shiprocket]    Headers : Authorization: Bearer ***MASKED***`);

    const response = await axios.get(fullUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    });

    console.log('[shiprocket] ✅ Raw Shiprocket response:');
    console.log(JSON.stringify(response.data, null, 2));

    return response.data;

  } catch (err) {
    const status = err?.response?.status;

    // Token expired mid-session — force re-auth and retry once
    if (status === 401 && attempt <= MAX_RETRIES) {
      console.warn(`[shiprocket] 401 on attempt ${attempt} — forcing token refresh`);
      tokenCache = { token: null, fetchedAt: null };
      return shiprocketGet(endpoint, attempt + 1);
    }

    // Transient server errors — retry
    if ((status === 500 || status === 503 || err.code === 'ECONNABORTED') && attempt <= MAX_RETRIES) {
      console.warn(`[shiprocket] Transient error (${status || err.code}) on attempt ${attempt} — retrying`);
      await new Promise((r) => setTimeout(r, 1000 * attempt)); // exponential backoff
      return shiprocketGet(endpoint, attempt + 1);
    }

    const message = err?.response?.data?.message || err.message;
    console.error(`[shiprocket] ❌ GET ${endpoint} FAILED`);
    console.error(`[shiprocket]    HTTP Status   : ${status}`);
    console.error(`[shiprocket]    Error message : ${message}`);
    console.error(`[shiprocket]    Full response body:`);
    console.error(JSON.stringify(err?.response?.data || '(no response body)', null, 2));
    throw new Error(`Shiprocket API error: ${message}`);
  }
}

/**
 * Fetch tracking details for a given AWB number.
 * Normalizes the Shiprocket response into a clean, consistent format.
 *
 * @param {string} awb - Air Waybill number from Shopify fulfillment
 * @returns {object} normalized tracking object
 */
async function getTrackingByAWB(awb) {
  if (!awb) throw new Error('AWB number is required');

  const data = await shiprocketGet(`/courier/track/awb/${awb}`);

  // Shiprocket wraps tracking data inside tracking_data
  const trackingData = data?.tracking_data;

  if (!trackingData) {
    throw new Error('No tracking data returned from Shiprocket');
  }

  const shipmentTrack = trackingData.shipment_track?.[0] || {};
  const activities = trackingData.shipment_track_activities || [];

  // Normalize events into a clean timeline array (most recent first)
  const events = activities.map((activity) => ({
    status: activity['sr-status-label'] || activity.activity || 'Update',
    location: activity.location || '',
    date: activity.date || '',
    description: activity.activity || '',
  }));

  return {
    courier: shipmentTrack.courier_name || 'Shiprocket',
    awb: shipmentTrack.awb_code || awb,
    current_status: shipmentTrack['current-status'] || trackingData.track_url ? 'In Transit' : 'Pending',
    tracking_url: trackingData.track_url || `https://shiprocket.co/tracking/${awb}`,
    estimated_delivery: shipmentTrack.etd || null,
    events,
  };
}

module.exports = { getTrackingByAWB };
