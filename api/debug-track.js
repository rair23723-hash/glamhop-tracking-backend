/**
 * /api/debug-track — Temporary diagnostic endpoint.
 *
 * Returns the COMPLETE raw Shiprocket response without any processing,
 * so we can see exactly which fields are present in the real API response.
 *
 * Usage (after deploying):
 *   GET https://<your-vercel-url>/api/debug-track?awb=370604336417&token=ghdbg2024
 *
 * Protected by token param. DELETE this file after debugging is complete.
 */

const axios = require('axios');

const SHIPROCKET_BASE_URL = 'https://apiv2.shiprocket.in/v1/external';
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || 'ghdbg2024';

module.exports = async function handler(req, res) {
  if (req.query.token !== DEBUG_TOKEN) {
    return res.status(403).json({ error: 'Forbidden — pass ?token=ghdbg2024' });
  }

  const awb = (req.query.awb || '').trim();
  if (!awb) {
    return res.status(400).json({ error: '?awb= param required' });
  }

  const email    = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;

  const envCheck = {
    SHIPROCKET_EMAIL:    email    ? `✅ set (${email.length} chars)`    : '❌ MISSING',
    SHIPROCKET_PASSWORD: password ? `✅ set (${password.length} chars)` : '❌ MISSING',
    SHOPIFY_SHOP_DOMAIN: process.env.SHOPIFY_SHOP_DOMAIN ? '✅ set' : '❌ MISSING',
    SHOPIFY_API_SECRET:  process.env.SHOPIFY_API_SECRET  ? '✅ set' : '❌ MISSING',
  };

  if (!email || !password) {
    return res.status(503).json({ error: 'Missing Shiprocket credentials', envCheck });
  }

  // Step 1: authenticate
  let token;
  let authStatus;
  try {
    const authRes = await axios.post(
      `${SHIPROCKET_BASE_URL}/auth/login`,
      { email, password },
      { timeout: 10000 }
    );
    token      = authRes.data?.token;
    authStatus = { http: authRes.status, token_present: !!token };
    if (!token) throw new Error('No token in auth response');
  } catch (err) {
    return res.status(500).json({
      step: 'shiprocket_auth',
      error: err.message,
      http_status: err?.response?.status,
      body: err?.response?.data,
      envCheck,
    });
  }

  // Step 2: call tracking endpoint — return full raw response
  let raw;
  let trackHttpStatus;
  try {
    const trackRes = await axios.get(
      `${SHIPROCKET_BASE_URL}/courier/track/awb/${awb}`,
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
    raw             = trackRes.data;
    trackHttpStatus = trackRes.status;
  } catch (err) {
    return res.status(500).json({
      step: 'shiprocket_track',
      error: err.message,
      http_status: err?.response?.status,
      body: err?.response?.data,
      awb,
      envCheck,
    });
  }

  // Step 3: Audit every possible activity field
  const td  = raw?.tracking_data;
  const st0 = Array.isArray(td?.shipment_track) && td.shipment_track.length > 0
    ? td.shipment_track[0]
    : null;

  const audit = !td ? '⚠️ tracking_data is null/missing in response' : {
    'tracking_data_TOP_LEVEL_KEYS': Object.keys(td),
    'shipment_track.length':        Array.isArray(td.shipment_track) ? td.shipment_track.length : 'not array',
    'shipment_track[0]_keys':       st0 ? Object.keys(st0) : '(shipment_track[0] does not exist)',

    // All 9 candidate fields + lengths
    'td.shipment_track_activities':      toDesc(td.shipment_track_activities),
    'td.activities':                     toDesc(td.activities),
    'td.shipment_activities':            toDesc(td.shipment_activities),
    'td.tracking_history':               toDesc(td.tracking_history),
    'td.checkpoints':                    toDesc(td.checkpoints),
    'td.scan_history':                   toDesc(td.scan_history),
    'st0.shipment_track_activities':     st0 ? toDesc(st0.shipment_track_activities) : 'n/a',
    'st0.activities':                    st0 ? toDesc(st0.activities) : 'n/a',
    'st0.scan_history':                  st0 ? toDesc(st0.scan_history) : 'n/a',

    // All keys on st0 that we haven't listed above (any unknown field):
    'st0_unknown_fields': st0 ? Object.keys(st0).filter(k => ![
      'awb_code','courier_name','current-status','current_status','id',
      'shipment_id','shipment_status','status','etd','estimated_delivery_date',
      'routing_code','shiprocket_order_id','channel_order_id','channel_name',
      'tracking_url','track_url','shipment_track_activities','activities','scan_history',
      'pickup_date','delivered_date','edd','promise_date',
    ].includes(k)) : 'n/a',
  };

  // Samples from first activity in any non-empty field
  const samples = {};
  if (td) {
    if (Array.isArray(td.shipment_track_activities) && td.shipment_track_activities[0])
      samples['td.shipment_track_activities[0]'] = td.shipment_track_activities[0];
    if (st0 && Array.isArray(st0.shipment_track_activities) && st0.shipment_track_activities[0])
      samples['st0.shipment_track_activities[0]'] = st0.shipment_track_activities[0];
    if (st0 && Array.isArray(st0.activities) && st0.activities[0])
      samples['st0.activities[0]'] = st0.activities[0];
    if (Array.isArray(td.activities) && td.activities[0])
      samples['td.activities[0]'] = td.activities[0];
    if (Array.isArray(td.tracking_history) && td.tracking_history[0])
      samples['td.tracking_history[0]'] = td.tracking_history[0];
  }

  return res.status(200).json({
    awb,
    envCheck,
    shiprocket_auth:         authStatus,
    shiprocket_track_http:   trackHttpStatus,
    activity_field_audit:    audit,
    first_activity_samples:  samples,
    shipment_track_0_summary: st0 ? {
      awb_code:        st0.awb_code,
      courier_name:    st0.courier_name,
      current_status:  st0['current-status'] || st0.current_status,
      etd:             st0.etd || st0.estimated_delivery_date,
      ALL_KEYS:        Object.keys(st0),
    } : null,
    FULL_RAW_RESPONSE: raw,
  });
};

function toDesc(val) {
  if (Array.isArray(val)) return `array(${val.length})${val.length > 0 ? ' ✅ HAS DATA' : ' — empty []'}`;
  if (val === null)        return 'null';
  if (val === undefined)   return 'undefined (key not present)';
  return `${typeof val}: ${JSON.stringify(val).slice(0, 80)}`;
}
