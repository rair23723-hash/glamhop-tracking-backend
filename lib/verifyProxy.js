const crypto = require('crypto');

/**
 * Verifies the Shopify App Proxy signature.
 * Follows the official Shopify App Proxy signature verification specification.
 *
 * @param {Object} query - The query parameters of the request (e.g. req.query).
 * @param {string} [apiSecret] - The Shopify App Client Secret (Shared Secret).
 * @returns {boolean} True if the signature is valid, false otherwise.
 */
function verifyProxySignature(query, apiSecret) {
  if (!query || typeof query !== 'object') {
    return false;
  }

  const { signature, ...params } = query;

  if (!signature || typeof signature !== 'string') {
    return false;
  }

  // Resolve the secret key from parameters or environment variables
  // Post-2026/modern dashboards name it SHOPIFY_CLIENT_SECRET or SHOPIFY_API_SECRET
  const secret = apiSecret || process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;

  if (!secret || typeof secret !== 'string') {
    console.error('[verifyProxy] Missing Shopify client secret key environment variable.');
    return false;
  }

  // 1. Sort query parameters lexicographically by key
  const sortedKeys = Object.keys(params).sort();

  // Helper to format values: handles single values and joins arrays with commas
  const getParamValue = (val) => {
    if (Array.isArray(val)) {
      return val.join(',');
    }
    return String(val);
  };

  // Helper to format key=value pair
  const formatPair = (key, val) => {
    return `${key}=${val}`;
  };

  // Attempt 1: Reconstruct using standard decoded parameters (if already parsed by Vercel)
  const messageDecoded = sortedKeys
    .map((key) => formatPair(key, getParamValue(params[key])))
    .join('');

  // Attempt 2: Reconstruct using RFC 3986 percent-encoded values
  // Shopify calculates the signature on raw URL-encoded query parameters.
  const rfc3986Encode = (str) => {
    return encodeURIComponent(str)
      .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  };

  const messageEncoded = sortedKeys
    .map((key) => {
      const rawVal = getParamValue(params[key]);
      return formatPair(key, rfc3986Encode(rawVal));
    })
    .join('');

  // Attempt 3: Reconstruct using '+' for spaces (common in form submissions)
  const messageEncodedPlus = sortedKeys
    .map((key) => {
      const rawVal = getParamValue(params[key]);
      return formatPair(key, rfc3986Encode(rawVal).replace(/%20/g, '+'));
    })
    .join('');

  // 2. Compute HMAC-SHA256 signatures for each candidate format
  const hashDecoded = crypto.createHmac('sha256', secret).update(messageDecoded, 'utf-8').digest('hex');
  const hashEncoded = crypto.createHmac('sha256', secret).update(messageEncoded, 'utf-8').digest('hex');
  const hashEncodedPlus = crypto.createHmac('sha256', secret).update(messageEncodedPlus, 'utf-8').digest('hex');

  // 3. Constant-time secure comparison
  const compare = (computed) => {
    try {
      const a = Buffer.from(computed, 'hex');
      const b = Buffer.from(signature, 'hex');

      if (a.length !== b.length) {
        return false;
      }

      return crypto.timingSafeEqual(a, b);
    } catch (err) {
      return false;
    }
  };

  // Validate if any candidate formatting matches the signature
  return compare(hashDecoded) || compare(hashEncoded) || compare(hashEncodedPlus);
}

module.exports = { verifyProxySignature };
