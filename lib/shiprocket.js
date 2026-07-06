const axios = require('axios');

let tokenCache = {
  token: null,
  expiresAt: 0,
};

/**
 * Log in to Shiprocket and cache the authorization token.
 * Shiprocket tokens are valid for 10 days (240 hours). We cache for 9 days.
 * 
 * @returns {Promise<string|null>} Bearer token or null if authentication fails
 */
async function getShiprocketToken() {
  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;

  if (!email || !password) {
    console.warn('[shiprocket] Missing SHIPROCKET_EMAIL or SHIPROCKET_PASSWORD env vars. Live tracking disabled.');
    return null;
  }

  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now) {
    return tokenCache.token;
  }

  try {
    const response = await axios.post('https://apiv2.shiprocket.in/v1/external/auth/login', {
      email,
      password,
    });

    const token = response.data.token;
    if (token) {
      tokenCache = {
        token,
        expiresAt: now + 9 * 24 * 60 * 60 * 1000, // Cache for 9 days
      };
      return token;
    }
    return null;
  } catch (err) {
    console.error('[shiprocket] Authentication failed:', err?.response?.data || err.message);
    return null;
  }
}

/**
 * Fetch tracking details from Shiprocket using the AWB tracking number.
 * 
 * @param {string} awbCode - Air Waybill tracking code
 * @returns {Promise<object|null>} Shiprocket tracking response object
 */
async function getTrackingDetails(awbCode) {
  const token = await getShiprocketToken();
  if (!token) {
    return null;
  }

  try {
    const response = await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awbCode}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return response.data;
  } catch (err) {
    console.error('[shiprocket] Failed to fetch tracking details:', err?.response?.data || err.message);
    return null;
  }
}

module.exports = { getTrackingDetails };
