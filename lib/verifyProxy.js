const crypto = require('crypto');

/**
 * Verifies the Shopify App Proxy signature.
 * Follows the official Shopify App Proxy signature verification specification.
 * Supports both raw request object (req) and pre-parsed query object.
 *
 * @param {Object} reqOrQuery - The Node.js request object (req) or query parameters object.
 * @param {string} [apiSecret] - Optional Shopify App Client Secret (Shared Secret).
 * @returns {boolean} True if the signature is valid, false otherwise.
 */
function verifyProxySignature(reqOrQuery, apiSecret) {
  if (!reqOrQuery) {
    return false;
  }

  let query = reqOrQuery;
  let rawParams = null;

  // 1. Detect if the parameter is the request object (req) by checking for 'url' property
  if (reqOrQuery.url && typeof reqOrQuery.url === 'string') {
    query = reqOrQuery.query || {};
    try {
      const urlParts = reqOrQuery.url.split('?');
      if (urlParts.length >= 2) {
        const queryString = urlParts[1];
        rawParams = {};
        const pairs = queryString.split('&');
        for (const pair of pairs) {
          const eqIdx = pair.indexOf('=');
          if (eqIdx === -1) continue;
          const key = pair.substring(0, eqIdx);
          const val = pair.substring(eqIdx + 1);
          
          const decodedKey = decodeURIComponent(key);
          // Keep the raw, URL-encoded value as received
          rawParams[decodedKey] = val;
        }
      }
    } catch (e) {
      console.error('[verifyProxy] Error parsing raw query string:', e.message);
    }
  }

  // Fallback to query object if raw parsing failed or wasn't a req object
  const targetParams = rawParams || query;

  const { signature, ...params } = targetParams;

  if (!signature || typeof signature !== 'string') {
    console.warn('[verifyProxy] Signature parameter is missing or invalid.');
    return false;
  }

  // Resolve secret key
  const secret = apiSecret || process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;
  if (!secret || typeof secret !== 'string') {
    console.error('[verifyProxy] Missing Shopify client secret key environment variable.');
    return false;
  }

  const sortedKeys = Object.keys(params).sort();

  // Helper to format values: joins arrays with commas
  const getParamValue = (val) => {
    if (Array.isArray(val)) {
      return val.join(',');
    }
    return String(val);
  };

  const formatPair = (key, val) => {
    return `${key}=${val}`;
  };

  // Reconstruct candidate message strings
  // Format A: Standard values (decoded strings)
  const messageDecoded = sortedKeys
    .map((key) => formatPair(key, getParamValue(params[key])))
    .join('');

  // Format B: Percent-encoded values (RFC 3986)
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

  // Format C: Percent-encoded values using '+' for spaces
  const messageEncodedPlus = sortedKeys
    .map((key) => {
      const rawVal = getParamValue(params[key]);
      return formatPair(key, rfc3986Encode(rawVal).replace(/%20/g, '+'));
    })
    .join('');

  // Compute candidates
  const hashDecoded = crypto.createHmac('sha256', secret).update(messageDecoded, 'utf-8').digest('hex');
  const hashEncoded = crypto.createHmac('sha256', secret).update(messageEncoded, 'utf-8').digest('hex');
  const hashEncodedPlus = crypto.createHmac('sha256', secret).update(messageEncodedPlus, 'utf-8').digest('hex');

  // Secure comparison helper
  const compare = (computed) => {
    try {
      const a = Buffer.from(computed, 'hex');
      const b = Buffer.from(signature, 'hex');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  };

  const isValid = compare(hashDecoded) || compare(hashEncoded) || compare(hashEncodedPlus);

  // Debug logging
  const obfuscateSecret = (s) => (s && s.length > 4 ? `*...*${s.substring(s.length - 4)}` : 'missing');
  console.log('[verifyProxy] Verification Audit Details:');
  console.log(`  - Parameters Used:`, JSON.stringify(params));
  console.log(`  - Secret Key:`, obfuscateSecret(secret));
  console.log(`  - Format A (Decoded String): "${messageDecoded}" -> HMAC: "${hashDecoded}"`);
  console.log(`  - Format B (Encoded String): "${messageEncoded}" -> HMAC: "${hashEncoded}"`);
  console.log(`  - Received Signature: "${signature}"`);
  console.log(`  - Verification Result: ${isValid ? 'PASSED' : 'FAILED'}`);

  return isValid;
}

module.exports = { verifyProxySignature };
