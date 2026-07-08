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
 *
 * @param {object} trackingData - The raw tracking_data object from Shiprocket
 * @param {object} shipmentTrack0 - trackingData.shipment_track[0] (if present)
 * @returns {{ activities: Array, detectedField: string }}
 */
function detectActivities(trackingData, shipmentTrack0) {
  const candidates = [
    // Priority 1: top-level (most common — Delhivery, BlueDart, etc.)
    { field: 'tracking_data.shipment_track_activities',          arr: trackingData.shipment_track_activities },
    // Priority 2: NESTED inside shipment_track[0] (Amazon Easy Ship, etc.)
    { field: 'tracking_data.shipment_track[0].shipment_track_activities', arr: shipmentTrack0?.shipment_track_activities },
    // Priority 3: nested .activities (XpressBees, Shadowfax, etc.)
    { field: 'tracking_data.shipment_track[0].activities',       arr: shipmentTrack0?.activities },
    // Priority 4: top-level .activities
    { field: 'tracking_data.activities',                         arr: trackingData.activities },
    // Priority 5: top-level .shipment_activities
    { field: 'tracking_data.shipment_activities',                arr: trackingData.shipment_activities },
    // Priority 6: legacy tracking_history
    { field: 'tracking_data.tracking_history',                   arr: trackingData.tracking_history },
    // Priority 7: checkpoints
    { field: 'tracking_data.checkpoints',                        arr: trackingData.checkpoints },
    // Priority 8: scan_history (some courier portals)
    { field: 'tracking_data.scan_history',                       arr: trackingData.scan_history },
    // Priority 9: nested scan_history in shipment_track[0]
    { field: 'tracking_data.shipment_track[0].scan_history',     arr: shipmentTrack0?.scan_history },
  ];

  console.log('[shiprocket] ═══ ACTIVITY FIELD DETECTION ═══');
  let detected = null;

  for (const c of candidates) {
    const isArr     = Array.isArray(c.arr);
    const count     = isArr ? c.arr.length : (c.arr === null ? 'null' : (c.arr === undefined ? 'undefined' : typeof c.arr));
    const hasItems  = isArr && c.arr.length > 0;
    console.log(`[shiprocket]   ${c.field}: ${isArr ? count + ' item(s)' : count}`);
    if (hasItems && !detected) {
      detected = { activities: c.arr, detectedField: c.field };
    }
  }

  if (detected) {
    console.log(`[shiprocket] ✅ Detected checkpoint field: "${detected.detectedField}" with ${detected.activities.length} checkpoint(s)`);
    console.log('[shiprocket]    First activity sample:', JSON.stringify(detected.activities[0]).slice(0, 300));
  } else {
    console.warn('[shiprocket] ⚠️  NO checkpoint activities found in ANY known field.');
    console.log('[shiprocket]    Full tracking_data keys:', Object.keys(trackingData).join(', '));
    if (shipmentTrack0) {
      console.log('[shiprocket]    shipment_track[0] keys:', Object.keys(shipmentTrack0).join(', '));
    }
  }

  return detected || { activities: [], detectedField: 'none' };
}

/**
 * Normalize a single Shiprocket activity object into our clean event schema.
 *
 * Handles field name variations across couriers:
 *  - Amazon:     { date, activity, location, "sr-status-label", "sr-status", city, state }
 *  - Delhivery:  { date, activity, location, "sr-status-label", "sr-status", city, state }
 *  - XpressBees: { date, activity, location, city, state, country }
 *  - Ekart:      { ScanDate, ScanTime, ScanType, Location, City, State }   (different casing!)
 *  - BlueDart:   { date, location, activity, "sr-status-label" }
 *
 * @param {object} activity  - Raw activity object from Shiprocket
 * @param {string} courierFromTrack - Courier name from shipment_track[0] (fallback)
 * @returns {object} Normalized event
 */
function normalizeActivity(activity, courierFromTrack) {
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
  // Shiprocket date formats vary by courier:
  //   Format A: "2026-07-06 16:12:00"       → YYYY-MM-DD HH:mm:ss (most common)
  //   Format B: "Jul 06 2026 04:12 PM"       → Mon DD YYYY HH:MM AM/PM
  //   Format C: "2026-07-06T16:12:00"        → ISO already
  //   Format D: "2026-07-06T16:12:00+05:30"  → ISO with offset
  //   Ekart: date + time are separate fields

  let rawDate = String(
    activity.date        ||
    activity.ScanDate    ||
    activity.scan_date   ||
    activity.DateTime    ||
    ''
  ).trim();

  // Ekart / some couriers split date and time
  const rawTime = String(activity.ScanTime || activity.scan_time || '').trim();
  if (rawTime && rawDate && !rawDate.includes(':')) {
    rawDate = `${rawDate} ${rawTime}`;
  }

  let isoDate = '';
  if (rawDate) {
    if (/^\d{4}-\d{2}-\d{2}T/.test(rawDate)) {
      // Already ISO — ensure timezone
      isoDate = rawDate.includes('+') || rawDate.endsWith('Z') ? rawDate : rawDate + '+05:30';
    } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(rawDate)) {
      // Format A: "2026-07-06 16:12:00" → treat as IST
      isoDate = rawDate.replace(' ', 'T') + '+05:30';
    } else {
      // Format B or unknown: try Date() parsing
      const parsed = new Date(rawDate);
      if (!isNaN(parsed)) {
        isoDate = rawDate; // keep as-is; browser Date() handles "Jul 06 2026 04:12 PM"
      } else {
        isoDate = rawDate; // pass through — UI gracefully shows '—' for unparseable dates
      }
    }
  }

  // ── Location normalization ──────────────────────────────────────────────────
  let city    = String(activity.city    || activity.City    || '').trim();
  let state   = String(activity.state   || activity.State   || '').trim();
  let country = String(activity.country || activity.Country || '').trim();

  const rawLoc = String(
    activity.location ||
    activity.Location ||
    activity.ScanLocation ||
    activity.scan_location ||
    ''
  ).trim();

  // If city/state are missing, try to parse from "City, State" location string
  if (!city && !state && rawLoc.includes(',')) {
    const parts = rawLoc.split(',').map((s) => s.trim());
    city  = parts[0] || '';
    state = parts[1] || '';
  }

  // Default country to India if we have any India-specific location data
  if (!country && (city || state)) {
    country = 'India';
  }

  // ── Status / activity text ──────────────────────────────────────────────────
  const srStatusLabel = String(activity['sr-status-label'] || activity.sr_status_label || '').trim();
  const activityText  = String(activity.activity || activity.Activity || activity.ScanType || activity.description || '').trim();

  return {
    status:      srStatusLabel || activityText || 'Update',
    sr_status:   String(activity['sr-status'] || activity.sr_status || '').trim(),
    description: activityText,
    location:    rawLoc,
    city,
    state,
    country,
    date:        isoDate,
  };
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

  // ── Log the FULL raw Shiprocket response before any processing ──────────────
  console.log('[shiprocket] ═══ RAW SHIPROCKET RESPONSE ═══');
  console.log(JSON.stringify(data, null, 2));

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
  const { activities: rawActivities, detectedField } = detectActivities(trackingData, shipmentTrack0);

  console.log(`[shiprocket] ═══ MAPPING SUMMARY ═══`);
  console.log(`[shiprocket]   Detected field  : ${detectedField}`);
  console.log(`[shiprocket]   Total checkpoints: ${rawActivities.length}`);

  // ── Normalize all activities into clean event objects ───────────────────────
  const courierFromTrack = shipmentTrack0?.courier_name || '';
  const events = rawActivities.map((activity) => normalizeActivity(activity, courierFromTrack));

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
  const currentStatus =
    shipmentTrack0?.['current-status'] ||
    shipmentTrack0?.current_status ||
    (trackingData.track_url ? 'In Transit' : 'Pending');

  // ── Estimated delivery ──────────────────────────────────────────────────────
  const etd =
    shipmentTrack0?.etd         ||
    shipmentTrack0?.estimated_delivery_date ||
    trackingData.etd            ||
    null;

  return {
    courier:            shipmentTrack0?.courier_name  || courierFromTrack || 'Shiprocket',
    awb:                shipmentTrack0?.awb_code       || awb,
    current_status:     currentStatus,
    tracking_url:       trackingData.track_url         || `https://shiprocket.co/tracking/${awb}`,
    estimated_delivery: etd,
    origin_timezone:    'Asia/Kolkata',
    events,
  };
}

module.exports = { getTrackingByAWB, getAWBByOrderNumber };
