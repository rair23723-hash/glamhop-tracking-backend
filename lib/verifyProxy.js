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
  console.log('[verifyProxy] Starting proxy signature audit...');

  if (!reqOrQuery) {
    console.error('[verifyProxy] FAILED: reqOrQuery is null or undefined.');
    return false;
  }

  let query = reqOrQuery;
  let rawParams = null;
  let sourceMethod = 'Pre-parsed req.query';

  // 1. Detect if the parameter is the request object (req)
  if (reqOrQuery.url && typeof reqOrQuery.url === 'string') {
    sourceMethod = `Raw URL parsing from req.url ("${reqOrQuery.url}")`;
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
          rawParams[decodedKey] = val;
        }
      }
    } catch (e) {
      console.error('[verifyProxy] Error parsing raw query string:', e.message);
    }
  }

  const targetParams = rawParams || query;
  const { signature, ...params } = targetParams;

  // Log received signature
  console.log(`[verifyProxy] Received Signature: "${signature || 'MISSING'}"`);

  if (!signature || typeof signature !== 'string') {
    console.error('[verifyProxy] FAILED: signature parameter is missing or not a string.');
    return false;
  }

  // 2. Identify and log which environment secret is being used
  let secretSource = 'Passed via argument';
  let secret = apiSecret;

  if (!secret) {
    if (process.env.SHOPIFY_CLIENT_SECRET) {
      secret = process.env.SHOPIFY_CLIENT_SECRET;
      secretSource = 'process.env.SHOPIFY_CLIENT_SECRET';
    } else if (process.env.SHOPIFY_API_SECRET) {
      secret = process.env.SHOPIFY_API_SECRET;
      secretSource = 'process.env.SHOPIFY_API_SECRET';
    } else {
      secretSource = 'NONE (Both SHOPIFY_CLIENT_SECRET and SHOPIFY_API_SECRET are missing)';
    }
  }

  const obfuscate = (s) => (s && s.length > 4 ? `*...*${s.substring(s.length - 4)} (length: ${s.length})` : 'invalid');
  console.log(`[verifyProxy] Env Secret Used: ${secretSource} -> ${obfuscate(secret)}`);

  if (!secret || typeof secret !== 'string') {
    console.error('[verifyProxy] FAILED: Shopify App Client Secret is missing or empty.');
    return false;
  }

  // 3. Sort parameters lexicographically by key
  const sortedKeys = Object.keys(params).sort();
  console.log(`[verifyProxy] Parameter Source Method: ${sourceMethod}`);
  console.log(`[verifyProxy] Raw Parameters Used:`, JSON.stringify(params));

  const getParamValue = (val) => {
    if (Array.isArray(val)) {
      return val.join(',');
    }
    return String(val);
  };

  const formatPair = (key, val) => {
    return `${key}=${val}`;
  };

  // Reconstruct candidate messages for HMAC
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

  // Compute HMAC candidate signatures
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

  const isDecodedValid = compare(hashDecoded);
  const isEncodedValid = compare(hashEncoded);
  const isEncodedPlusValid = compare(hashEncodedPlus);
  const isValid = isDecodedValid || isEncodedValid || isEncodedPlusValid;

  // Log canonical strings and computed hashes
  console.log(`[verifyProxy] Candidate HMAC Computations:`);
  console.log(`  - Format A (Decoded String): "${messageDecoded}" -> Calculated HMAC: "${hashDecoded}" -> Match: ${isDecodedValid}`);
  console.log(`  - Format B (Encoded String): "${messageEncoded}" -> Calculated HMAC: "${hashEncoded}" -> Match: ${isEncodedValid}`);
  console.log(`  - Format C (Encoded Plus):   "${messageEncodedPlus}" -> Calculated HMAC: "${hashEncodedPlus}" -> Match: ${isEncodedPlusValid}`);

  if (isValid) {
    console.log('[verifyProxy] SUCCESS: Signature verification PASSED.');
  } else {
    console.warn('[verifyProxy] FAILED: Signature verification FAILED. Received signature does not match any candidate HMACs.');
    console.log(`[verifyProxy] Mismatch analysis: Expected signature to match one of the calculated HMACs using Client Secret.`);
  }

  return isValid;
}

module.exports = { verifyProxySignature };
