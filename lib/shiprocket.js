const axios = require('axios');

const SHIPROCKET_BASE_URL = 'https://apiv2.shiprocket.in/v1/external';
const TOKEN_EXPIRY_MS = 23 * 60 * 60 * 1000; // 23 hours (Shiprocket tokens last 24hr)
const REQUEST_TIMEOUT_MS = 10000; // 10 seconds
const MAX_RETRIES = 2;

/**
 * In-memory token cache.
 *
 * Vercel serverless functions share state within a warm instance.
 * On a cold start (new instance), the cache is empty and one fresh login
 * is performed. All subsequent requests within that instance reuse the
 * cached token for the full 23-hour window without any additional logins.
 *
 * Concurrency note: if multiple requests arrive simultaneously on a cold
 * start, the in-flight lock below ensures only ONE login request is sent
 * to Shiprocket. All concurrent callers await the same promise.
 */
let tokenCache = {
  token: null,
  fetchedAt: null,
};

/**
 * In-flight lock: prevents duplicate simultaneous /auth/login calls.
 * If a login is already in progress, new callers await this promise
 * instead of triggering their own login.
 * @type {Promise<string>|null}
 */
let authInFlight = null;

/**
 * Check if the cached token is still valid (< 23 hours old).
 * Shiprocket tokens are valid for 24 hours; we use 23h for a safety margin.
 */
function isTokenValid() {
  if (!tokenCache.token || !tokenCache.fetchedAt) return false;
  return Date.now() - tokenCache.fetchedAt < TOKEN_EXPIRY_MS;
}

/**
 * Authenticate with Shiprocket and cache the JWT token.
 *
 * NEVER call this directly. Always use getToken() which:
 *   1. Returns the cached token if still valid (no network request).
 *   2. Joins an existing in-flight login if one is already running.
 *   3. Only triggers a NEW login if no valid token and no login in progress.
 *
 * @returns {Promise<string>} JWT token
 */
async function authenticate() {
  const email    = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;

  if (!email || !password) {
    const missing = [!email && 'SHIPROCKET_EMAIL', !password && 'SHIPROCKET_PASSWORD']
      .filter(Boolean).join(', ');
    const err = new Error(
      `[shiprocket] Missing required env vars: ${missing}. ` +
      `Set them in Vercel Dashboard → Project Settings → Environment Variables.`
    );
    err.statusCode = 503;
    throw err;
  }

  try {
    console.log('[shiprocket] 🔐 Performing fresh login to Shiprocket (email/password)...');
    const response = await axios.post(
      `${SHIPROCKET_BASE_URL}/auth/login`,
      { email, password },
      { timeout: REQUEST_TIMEOUT_MS }
    );

    const token = response.data?.token;
    if (!token) {
      throw new Error('[shiprocket] Auth response had HTTP 200 but contained no token field');
    }

    tokenCache = { token, fetchedAt: Date.now() };
    console.log('[shiprocket] ✅ Login succeeded. Token cached for 23 hours.');
    console.log('[shiprocket]    Token will NOT be refreshed again until it expires or a 401 is received.');
    return token;

  } catch (err) {
    if (err.statusCode === 503) throw err; // re-throw our own env-var error as-is

    const status  = err?.response?.status;
    const message = err?.response?.data?.message || err.message;
    console.error(`[shiprocket] ❌ Login FAILED (HTTP ${status}):`, message);
    console.error('[shiprocket]    Full auth error body:', JSON.stringify(err?.response?.data || '(none)'));

    const apiErr = new Error(`Shiprocket authentication failed (${status}): ${message}`);
    apiErr.statusCode = status || 503;
    throw apiErr;
  }
}

/**
 * Get a valid Shiprocket JWT token.
 *
 * Token lifecycle (verified by reading every code path):
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ CALL getToken()                                                 │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ isTokenValid()?                                                 │
 *   │  YES → return cached token immediately  (0 network requests)   │
 *   │  NO  → authInFlight already running?                           │
 *   │         YES → await existing promise    (0 extra logins)        │
 *   │         NO  → kick off authenticate()   (1 login, then cache)  │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Result: at most ONE /auth/login call per 23-hour window per instance,
 * regardless of how many concurrent requests arrive.
 *
 * @returns {Promise<string>} JWT token
 */
async function getToken() {
  // Fast path: valid cached token — no I/O at all
  if (isTokenValid()) {
    console.log('[shiprocket] 🔑 Using cached token (no login needed)');
    return tokenCache.token;
  }

  // Slow path: need a new token.
  // Use the in-flight lock so concurrent requests share one login.
  if (!authInFlight) {
    authInFlight = authenticate().finally(() => {
      authInFlight = null; // release lock once complete (success or failure)
    });
    // Prevent unhandled promise rejection crashes in Node.js runtime
    authInFlight.catch(() => {});
  } else {
    console.log('[shiprocket] ⏳ Login already in progress — awaiting existing request instead of starting a new one');
  }

  return authInFlight;
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

    // ── 401: token rejected by Shiprocket — re-auth ONCE then retry ──────────
    // IMPORTANT: we only allow ONE re-auth on 401, never more.
    // Allowing multiple re-auths would send multiple email/password logins
    // to Shiprocket in quick succession, risking account lock.
    if (status === 401 && attempt === 1) {
      console.warn('[shiprocket] ⚠️  Received 401 — token was rejected. Invalidating cache and re-authenticating ONCE.');
      tokenCache = { token: null, fetchedAt: null }; // force fresh login
      authInFlight = null;                           // release in-flight lock so authenticate() can run
      return shiprocketGet(endpoint, 2);             // retry with attempt=2 (will NOT re-auth again on another 401)
    }

    // ── 401 on attempt 2: re-auth already happened and still failing ─────────
    if (status === 401 && attempt >= 2) {
      console.error('[shiprocket] ❌ Still receiving 401 after token refresh. NOT retrying again (account lock prevention).');
      console.error('[shiprocket]    Possible causes: wrong credentials, account suspended, IP blocked.');
    }

    // Transient server errors — retry
    if ((status === 500 || status === 503 || err.code === 'ECONNABORTED') && attempt <= MAX_RETRIES) {
      console.warn(`[shiprocket] Transient error (${status || err.code}) on attempt ${attempt} — retrying`);
      await new Promise((r) => setTimeout(r, 1000 * attempt)); // exponential backoff
      return shiprocketGet(endpoint, attempt + 1);
    }

    const message = err?.response?.data?.message || err.message;
    const statusCode = status || 0;
    console.error(`[shiprocket] ❌ GET ${endpoint} FAILED`);
    console.error(`[shiprocket]    HTTP Status   : ${statusCode}`);
    console.error(`[shiprocket]    Error message : ${message}`);
    console.error(`[shiprocket]    Full response body:`);
    console.error(JSON.stringify(err?.response?.data || '(no response body)', null, 2));
    // Attach statusCode so callers can distinguish 401/403/404/5xx
    const apiErr = new Error(`Shiprocket API error: ${message}`);
    apiErr.statusCode = statusCode;
    throw apiErr;
  }
}

/**
 * Look up the AWB for an order by its Shopify order name (e.g. "#1003").
 * Queries Shiprocket's orders list filtered by channel_order_id.
 * Used as a fallback when Shopify fulfillments[] has no tracking_number
 * because the order was shipped via the Shiprocket dashboard (not Shopify native).
 *
 * @param {string} orderName - Shopify order name, e.g. "#1003" or "1003"
 * @returns {{ awb: string, courier: string }|null}
 */
async function getAWBByOrderNumber(orderName) {
  // Normalise: Shiprocket stores as plain number, strip leading #
  const cleanNumber = orderName.replace(/^#/, '').trim();
  console.log(`[shiprocket] Looking up AWB for Shopify order "${cleanNumber}" via Shiprocket orders API`);

  // Shiprocket: GET /orders?search=<order_number>
  // channel_order_id is the field Shiprocket stores the Shopify order name in.
  const data = await shiprocketGet(`/orders?search=${encodeURIComponent(cleanNumber)}&per_page=10`);

  const orders = data?.data || [];
  console.log(`[shiprocket] Orders API returned ${orders.length} result(s) for "${cleanNumber}"`);

  if (orders.length === 0) return null;

  // Find the matching order by channel_order_id
  const matched = orders.find(
    (o) =>
      String(o.channel_order_id).replace(/^#/, '') === cleanNumber ||
      String(o.id) === cleanNumber
  );

  if (!matched) {
    console.log(`[shiprocket] No exact channel_order_id match for "${cleanNumber}" among results`);
    console.log('[shiprocket] channel_order_ids in results:', orders.map((o) => o.channel_order_id));
    return null;
  }

  const awb     = matched.awb_code || matched.awb || null;
  const courier = matched.courier_name || matched.courier || 'Shiprocket';

  console.log(`[shiprocket] ✅ Found AWB: ${awb}, Courier: ${courier} for order "${cleanNumber}"`);
  return awb ? { awb, courier } : null;
}

/**
 * Exhaustively search a Shiprocket tracking_data object for checkpoint activities.
 *
 * Shiprocket uses different field names and nesting depending on the courier:
 *
 *  ┌─────────────────────────────────────────────────────────────────────────┐
 *  │ COURIER VARIANTS DISCOVERED                                             │
 *  ├────────────────────────────┬────────────────────────────────────────────┤
 *  │ Delhivery, Bluedart, Ekart │ tracking_data.shipment_track_activities    │
 *  │ Amazon Easy Ship           │ tracking_data.shipment_track[0]            │
 *  │                            │   .shipment_track_activities               │
 *  │ XpressBees, Shadowfax      │ tracking_data.shipment_track[0].activities │
 *  │ Some couriers              │ tracking_data.shipment_activities           │
 *  │ Others                     │ tracking_data.activities                    │
 *  │ Legacy format              │ tracking_data.tracking_history              │
 *  │ Raw format                 │ tracking_data.checkpoints                   │
 *  └────────────────────────────┴────────────────────────────────────────────┘
/**
 * Exhaustively search a Shiprocket tracking_data object for checkpoint activities.
 * If one field is empty, automatically try the others before returning an empty timeline.
 *
 * @param {object} data - The raw HTTP response object from Shiprocket
 * @param {object} trackingData - The raw tracking_data object from Shiprocket
 * @param {object} shipmentTrack0 - trackingData.shipment_track[0] (if present)
 * @returns {{ activities: Array, detectedField: string }}
 */
function detectActivities(data, trackingData, shipmentTrack0) {
  const getArray = (val) => {
    return Array.isArray(val) && val.length > 0 ? val : null;
  };

  const candidates = [
    // --- Priority 1: Activity fields under tracking_data or shipment_track[0] ---
    { name: 'tracking_data.shipment_track_activities', arr: getArray(trackingData?.shipment_track_activities) },
    { name: 'tracking_data.shipment_track[0].shipment_track_activities', arr: getArray(shipmentTrack0?.shipment_track_activities) },
    { name: 'tracking_data.shipment_track[0].activities', arr: getArray(shipmentTrack0?.activities) },
    { name: 'tracking_data.shipment_track[0].events', arr: getArray(shipmentTrack0?.events) },
    { name: 'tracking_data.shipment_track[0].scans', arr: getArray(shipmentTrack0?.scans) },
    { name: 'tracking_data.shipment_track[0].history', arr: getArray(shipmentTrack0?.history) },
    { name: 'tracking_data.activities', arr: getArray(trackingData?.activities) },
    { name: 'tracking_data.events', arr: getArray(trackingData?.events) },
    { name: 'tracking_data.scans', arr: getArray(trackingData?.scans) },
    { name: 'tracking_data.history', arr: getArray(trackingData?.history) },

    // --- Priority 2: Root level activity fields ---
    { name: 'shipment_track_activities', arr: getArray(data?.shipment_track_activities) },
    { name: 'activities', arr: getArray(data?.activities) },
    { name: 'events', arr: getArray(data?.events) },
    { name: 'scans', arr: getArray(data?.scans) },
    { name: 'history', arr: getArray(data?.history) },

    // --- Priority 3: Header/fallbacks (check last to prevent false positives) ---
    { name: 'tracking_data.shipment_track', arr: getArray(trackingData?.shipment_track) },
    { name: 'shipment_track', arr: getArray(data?.shipment_track) }
  ];

  console.log('[shiprocket] ═══ ACTIVITY FIELD DETECTION ═══');
  for (const c of candidates) {
    const isArr = Array.isArray(c.arr);
    const count = isArr ? c.arr.length : 'none';
    console.log(`[shiprocket]   Checking ${c.name}: ${isArr ? count + ' item(s)' : count}`);
    if (c.arr) {
      console.log(`[shiprocket] ✅ Selected event field: "${c.name}" with ${count} items`);
      return { activities: c.arr, detectedField: c.name };
    }
  }

  console.warn('[shiprocket] ⚠️  NO checkpoint activities found in ANY candidate fields.');
  return { activities: [], detectedField: 'none' };
}

function normalizeEventStatus(rawStatus) {
  if (!rawStatus) return 'Update';
  
  const s = String(rawStatus).trim().toLowerCase().replace(/[\s_-]+/g, '');

  if (s.includes('readyforreceive')) {
    return 'Shipping soon';
  }
  if (s.includes('pickupdone') || s === 'pickedup' || s.includes('pickedup')) {
    return 'Picked up';
  }
  if (s.includes('arrivedatcarrierfacility') || s.includes('reachedcarrierfacility')) {
    return 'Reached carrier facility';
  }
  if (s.includes('arrivedatdestinationhub') || s.includes('reacheddestinationhub')) {
    return 'Reached destination hub';
  }
  if (s.includes('outfordelivery') || s === 'out') {
    return 'Out for delivery';
  }
  if (s.includes('delivered')) {
    return 'Delivered';
  }
  if (s.includes('intransit') || s === 'transit') {
    return 'In transit';
  }
  if (s.includes('exception')) {
    return 'Shipment exception';
  }

  // Common fallbacks
  if (s.includes('depart')) return 'In transit';
  if (s.includes('arrive')) return 'Reached carrier facility';
  if (s.includes('pickup')) return 'Picked up';
  if (s.includes('cancel')) return 'Cancelled';
  
  return rawStatus;
}

function getOverallStatus(eventStatus, rawShipmentStatus) {
  const s = (eventStatus || rawShipmentStatus || '').toLowerCase().replace(/[\s_-]+/g, '');

  if (s.includes('delivered')) {
    return 'Delivered';
  }
  if (s.includes('outfordelivery') || s.includes('out') || s === 'ofd') {
    return 'Out for delivery';
  }
  if (s.includes('transit') || s.includes('depart') || s.includes('pickup') || s.includes('arrived') || s.includes('reached')) {
    return 'In transit';
  }
  if (s.includes('shippingsoon') || s.includes('shipped') || s.includes('readyforreceive') || s.includes('dispatch')) {
    return 'Shipping soon';
  }
  if (s.includes('exception') || s.includes('failed') || s.includes('undelivered')) {
    return 'Exception';
  }
  if (s.includes('cancel') || s.includes('rto')) {
    return 'Cancelled';
  }
  return 'Pending';
}

/**
 * Normalize a single Shiprocket activity object into our clean event schema.
 *
 * Search all possible Shiprocket/Amazon tracking fields for the checkpoint location,
 * including nested structures. Normalize all carriers (Amazon, Delhivery, XpressBees,
 * Ekart, BlueDart, DTDC).
 *
 * @param {object} activity  - Raw activity object from Shiprocket
 * @param {string} courierFromTrack - Courier name from shipment_track[0] (fallback)
 * @param {object} [shipmentTrack0] - Primary shipment track info for fallback
 * @param {object} [shippingAddress] - Shopify order shipping address for fallback
 * @returns {object} Normalized event
 */
function normalizeActivity(activity, courierFromTrack, shipmentTrack0, shippingAddress) {
  if (!activity) {
    return {
      status:      'Update',
      sr_status:   '',
      description: '',
      location:    '',
      city:        '',
      state:       '',
      country:     '',
      date:        '',
    };
  }

  // ── Date normalization ──────────────────────────────────────────────────────
  let rawDate = String(
    activity.date        ||
    activity.ScanDate    ||
    activity.scan_date   ||
    activity.DateTime    ||
    ''
  ).trim();

  const rawTime = String(activity.ScanTime || activity.scan_time || '').trim();
  if (rawTime && rawDate && !rawDate.includes(':')) {
    rawDate = `${rawDate} ${rawTime}`;
  }

  let isoDate = '';
  if (rawDate) {
    if (/^\d{4}-\d{2}-\d{2}T/.test(rawDate)) {
      isoDate = rawDate.includes('+') || rawDate.endsWith('Z') ? rawDate : rawDate + '+05:30';
    } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(rawDate)) {
      isoDate = rawDate.replace(' ', 'T') + '+05:30';
    } else {
      const parsed = new Date(rawDate);
      if (!isNaN(parsed)) {
        isoDate = rawDate;
      } else {
        isoDate = rawDate;
      }
    }
  }

  // ── Location normalization ──────────────────────────────────────────────────
  const clean = (val) => {
    if (val === undefined || val === null) return '';
    const s = String(val).trim();
    const upper = s.toUpperCase();
    if (!s || upper === 'NA' || upper === 'N/A' || upper === 'N A' || upper === 'NOT AVAILABLE') return '';
    return s;
  };

  const parts = [];
  const added = new Set();
  
  const addPart = (val) => {
    const cleaned = clean(val);
    if (!cleaned) return;
    const lower = cleaned.toLowerCase();
    if (!added.has(lower)) {
      // Check if this part is already contained in or contains any already added part to prevent duplicates
      let isDup = false;
      for (const existing of added) {
        if (existing.includes(lower) || lower.includes(existing)) {
          isDup = true;
          break;
        }
      }
      if (!isDup) {
        parts.push(cleaned);
        added.add(lower);
      }
    }
  };

  // Priority location candidate check:
  const locCandidates = [
    'location',
    'Location',
    'current_location',
    'currentLocation',
    'CurrentLocation',
    'location_name',
    'locationName',
    'LocationName',
    'place',
    'Place',
    'address',
    'Address',
    'scan_location',
    'ScanLocation',
    'scanLocation',
    'hub',
    'Hub',
    'branch',
    'Branch',
    'event_location',
    'EventLocation',
    'eventLocation'
  ];

  let rawLocation = '';
  for (const candidateKey of locCandidates) {
    const val = clean(activity[candidateKey]);
    if (val) {
      rawLocation = val;
      break;
    }
  }

  // Deduplicating priority joiner: location -> city -> state -> country
  addPart(rawLocation);
  addPart(activity.city || activity.City);
  addPart(activity.state || activity.State);
  addPart(activity.country || activity.Country);

  let finalLocation = parts.join(', ');

  // Fallback 1: Shopify order shipping address
  if (!finalLocation && shippingAddress) {
    addPart(shippingAddress.city);
    addPart(shippingAddress.province || shippingAddress.state);
    addPart(shippingAddress.country_code || shippingAddress.country);
    finalLocation = parts.join(', ');
  }

  // Fallback 2: Shiprocket destination details
  if (!finalLocation && shipmentTrack0) {
    addPart(shipmentTrack0.delivered_to || shipmentTrack0.destination || shipmentTrack0.origin);
    finalLocation = parts.join(', ');
  }

  // Default country to India if we have city/state but no country
  if (parts.length > 0 && !added.has('india') && !added.has('ind')) {
    addPart('India');
    finalLocation = parts.join(', ');
  }

  // Extract separate city, state, country for frontend compatibility
  let city    = clean(activity.city    || activity.City);
  let state   = clean(activity.state   || activity.State);
  let country = clean(activity.country || activity.Country);

  if (!city && !state && finalLocation.includes(',')) {
    const locParts = finalLocation.split(',').map((s) => s.trim());
    if (locParts.length >= 1) city = locParts[0];
    if (locParts.length >= 2) state = locParts[1];
    if (locParts.length >= 3) country = locParts[2];
  }

  // ── Status / activity text ──────────────────────────────────────────────────
  const srStatusLabel = String(activity['sr-status-label'] || activity.sr_status_label || '').trim();
  const activityText  = String(activity.activity || activity.Activity || activity.ScanType || activity.description || '').trim();

  let rawStatus = srStatusLabel || activityText || 'Update';
  if (rawStatus.toUpperCase() === 'NA' || rawStatus.toUpperCase() === 'N/A') {
    rawStatus = activity.status || activityText || 'Update';
  }
  
  const normalizedStatus = normalizeEventStatus(rawStatus);

  // ── Description Fallback & Mapping ──────────────────────────────────────────
  let description = clean(activity.description || activity.Activity || activity.ScanType || activity.activity);
  
  const rawApiMap = {
    'readyforreceive': 'Shipment received',
    'pickupdone': 'Shipment picked up',
    'pickedup': 'Shipment picked up',
    'arrivedatcarrierfacility': 'Reached carrier facility',
    'arrivedatdestinationhub': 'Reached destination hub',
    'outfordelivery': 'Out for delivery',
    'delivered': 'Delivered successfully',
    'intransit': 'Departed facility',
    'exception': 'Shipment exception'
  };

  const cleanDesc = description.toLowerCase().replace(/[\s_-]+/g, '');
  if (rawApiMap[cleanDesc]) {
    description = rawApiMap[cleanDesc];
  }

  if (!description) {
    const statusLower = normalizedStatus.toLowerCase();
    if (statusLower.includes('delivered')) {
      description = 'Delivered successfully';
    } else if (statusLower.includes('out for delivery')) {
      description = 'Out for delivery';
    } else if (statusLower.includes('destination hub')) {
      description = 'Reached destination hub';
    } else if (statusLower.includes('carrier facility')) {
      description = 'Reached carrier facility';
    } else if (statusLower.includes('picked up')) {
      description = 'Shipment picked up';
    } else if (statusLower.includes('shipping soon')) {
      description = 'Shipment received';
    } else if (statusLower.includes('transit')) {
      description = 'Departed facility';
    } else {
      description = 'Shipment status updated';
    }
  }

  const normalizedEvent = {
    status:      normalizedStatus,
    sr_status:   String(activity['sr-status'] || activity.sr_status || '').trim(),
    description,
    location:    finalLocation,
    city,
    state,
    country,
    date:        isoDate,
  };

  console.log('[shiprocket] --- TIMELINE EVENT DEBUG LOG ---');
  console.log('raw event:', JSON.stringify(activity, null, 2));
  console.log('normalized event:', JSON.stringify(normalizedEvent, null, 2));
  console.log('resolved location:', finalLocation || '(none)');
  console.log('resolved description:', description || '(none)');
  console.log('----------------------------------------------\n');

  return normalizedEvent;
}

/**
 * Fetch tracking details for a given AWB number.
 * Normalizes the Shiprocket response into a clean, consistent format.
 *
 * @param {string} awb - Air Waybill number from Shopify fulfillment
 * @param {object} [shippingAddress] - Optional Shopify order shipping address
 * @returns {object} normalized tracking object
 */
async function getTrackingByAWB(awb, shippingAddress) {
  if (!awb) throw new Error('AWB number is required');

  const data = await shiprocketGet(`/courier/track/awb/${awb}`);

  // ── Extract tracking_data ───────────────────────────────────────────────────
  const trackingData = data?.tracking_data;

  if (!trackingData) {
    // Shiprocket returned 200 but no tracking_data — AWB not in system
    console.error('[shiprocket] ❌ tracking_data is missing from response. Full response:', JSON.stringify(data));
    const err = new Error('AWB not found in Shiprocket (no tracking_data in response)');
    err.statusCode = 404;
    throw err;
  }

  // ── shipment_track[0] — primary source for courier info + some couriers' activities ──
  const shipmentTrack0 = Array.isArray(trackingData.shipment_track) && trackingData.shipment_track.length > 0
    ? trackingData.shipment_track[0]
    : null;

  console.log('[shiprocket] shipment_track[0]:', JSON.stringify(shipmentTrack0).slice(0, 500));

  // ── Detect activities using exhaustive field search ─────────────────────────
  const { activities: rawActivities, detectedField } = detectActivities(data, trackingData, shipmentTrack0);

  console.log(`[shiprocket] ═══ MAPPING SUMMARY ═══`);
  console.log(`[shiprocket]   Detected field  : ${detectedField}`);
  console.log(`[shiprocket]   Total checkpoints: ${rawActivities.length}`);

  // ── Normalize all activities into clean event objects ───────────────────────
  const courierFromTrack = shipmentTrack0?.courier_name || '';
  const events = rawActivities.map((activity) =>
    normalizeActivity(activity, courierFromTrack, shipmentTrack0, shippingAddress)
  );

  console.log(`[shiprocket]   Mapped events   : ${events.length}`);
  if (events.length > 0) {
    console.log('[shiprocket]   First event     :', JSON.stringify(events[0]));
  } else {
    console.warn('[shiprocket] ⚠️  Mapped events = 0. Possible causes:');
    console.warn('[shiprocket]   1. AWB was assigned but courier has not yet scanned the parcel');
    console.warn('[shiprocket]   2. Courier-specific field name not yet covered — check the RAW RESPONSE above');
    console.warn('[shiprocket]   3. track_status =', trackingData.track_status, '(0 = no scan data yet)');
  }

  // ── Current status ──────────────────────────────────────────────────────────
  let currentStatus = '';
  if (events.length > 0) {
    currentStatus = getOverallStatus(events[0].status, shipmentTrack0?.current_status);
  } else if (shipmentTrack0) {
    currentStatus = getOverallStatus('', shipmentTrack0.current_status);
  }
  if (!currentStatus || currentStatus === 'Pending') {
    currentStatus = trackingData.track_url ? 'In transit' : 'Pending';
  }

  // ── Estimated delivery ──────────────────────────────────────────────────────
  const etd =
    shipmentTrack0?.etd         ||
    shipmentTrack0?.estimated_delivery_date ||
    trackingData.etd            ||
    null;

  const normalizedResult = {
    courier:            shipmentTrack0?.courier_name  || courierFromTrack || 'Shiprocket',
    awb:                shipmentTrack0?.awb_code       || awb,
    current_status:     currentStatus,
    tracking_url:       trackingData.track_url         || `https://shiprocket.co/tracking/${awb}`,
    estimated_delivery: etd,
    origin_timezone:    'Asia/Kolkata',
    events,
  };

  // Determine progress stage selected (emulating frontend logic)
  const getProgressStage = (status) => {
    const s = (status || '').toLowerCase().replace(/\s+/g, '');
    if (s.includes('delivered')) return 'Stage 5 (Delivered)';
    if (s.includes('out') || s.includes('outfordelivery')) return 'Stage 4 (Out for Delivery)';
    if (s.includes('transit') || s.includes('depart') || s.includes('pickup') || s.includes('arrived')) return 'Stage 3 (In Transit)';
    if (s.includes('shippingsoon') || s.includes('shipped') || s.includes('readyforreceive') || s.includes('dispatch')) return 'Stage 2 (Shipping Soon)';
    if (s.includes('pack') || s.includes('prepar') || s.includes('process')) return 'Stage 1 (Processing)';
    return 'Stage 0 (Pending)';
  };
  const progressStage = getProgressStage(currentStatus);

  console.log('\n=== DETAILED BACKEND LOGS ===');
  console.log('Raw Shiprocket response:', JSON.stringify(data, null, 2));
  console.log('Which event field was selected:', detectedField);
  console.log('Number of events found:', events.length);
  console.log('Mapped Shipment Status:', currentStatus);
  console.log('Progress Stage Selected:', progressStage);
  console.log('Final normalized object:', JSON.stringify(normalizedResult, null, 2));
  console.log('=============================\n');

  return normalizedResult;
}

module.exports = { getTrackingByAWB, getAWBByOrderNumber };
