const crypto = require('crypto');

/**
 * Verifies the Shopify App Proxy signature.
 *
 * @param {Object} query - The query parameters of the request (e.g. req.query).
 * @param {string} apiSecret - The Shopify App Client Secret (Shared Secret).
 * @returns {boolean} True if the signature is valid, false otherwise.
 */
function verifyProxySignature(query, apiSecret = process.env.SHOPIFY_API_SECRET) {
  if (!query || typeof query !== 'object') {
    return false;
  }

  const { signature, ...params } = query;

  if (!signature || typeof signature !== 'string') {
    return false;
  }

  if (!apiSecret || typeof apiSecret !== 'string') {
    return false;
  }

  // 1. Sort query parameters lexicographically by key
  const sortedKeys = Object.keys(params).sort();

  // 2. Format query parameters as key=value and join them
  const message = sortedKeys
    .map((key) => {
      const val = params[key];
      // Handle potential arrays (though query parameters are typically strings)
      if (Array.isArray(val)) {
        return `${key}=${val.join(',')}`;
      }
      return `${key}=${val}`;
    })
    .join('');

  // 3. Compute HMAC-SHA256
  const computedSignature = crypto
    .createHmac('sha256', apiSecret)
    .update(message, 'utf-8')
    .digest('hex');

  // 4. Secure timing-safe comparison to prevent timing attacks
  try {
    const a = Buffer.from(computedSignature, 'hex');
    const b = Buffer.from(signature, 'hex');

    if (a.length !== b.length) {
      return false;
    }

    return crypto.timingSafeEqual(a, b);
  } catch (err) {
    return false;
  }
}

module.exports = { verifyProxySignature };
