/**
 * RAW SHIPROCKET AUDIT SCRIPT
 * Run: node scratch/audit_shiprocket.js
 */
const axios = require('axios');
require('dotenv').config({ path: '.env.local' });

async function test() {
  console.log('=== SHIPROCKET RAW RESPONSE AUDIT ===');
  console.log('Email:', process.env.SHIPROCKET_EMAIL);
  console.log('Password set:', !!process.env.SHIPROCKET_PASSWORD);
  console.log('');

  // Step 1: Authenticate
  let token;
  try {
    const authRes = await axios.post('https://apiv2.shiprocket.in/v1/external/auth/login', {
      email: process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD
    }, { timeout: 15000 });
    token = authRes.data?.token;
    console.log('AUTH SUCCESS. Token prefix:', token?.slice(0, 30));
  } catch (e) {
    console.error('AUTH FAILED:', e?.response?.status, JSON.stringify(e?.response?.data));
    return;
  }

  // Step 2: Track AWB 370604336417
  const awb = '370604336417';
  console.log('');
  console.log('=== TRACKING AWB:', awb, '===');
  try {
    const trackRes = await axios.get(
      'https://apiv2.shiprocket.in/v1/external/courier/track/awb/' + awb,
      {
        headers: { Authorization: 'Bearer ' + token },
        timeout: 15000
      }
    );
    console.log('HTTP STATUS:', trackRes.status);
    console.log('FULL RAW RESPONSE:');
    console.log(JSON.stringify(trackRes.data, null, 2));

    // Audit every possible field
    const td = trackRes.data?.tracking_data;
    console.log('');
    console.log('=== FIELD AUDIT ===');
    console.log('tracking_data exists:', !!td);
    if (td) {
      console.log('ALL KEYS in tracking_data:', Object.keys(td));
      console.log('shipment_track length:', Array.isArray(td.shipment_track) ? td.shipment_track.length : 'NOT ARRAY / MISSING');
      if (Array.isArray(td.shipment_track) && td.shipment_track.length > 0) {
        console.log('shipment_track[0] keys:', Object.keys(td.shipment_track[0]));
        console.log('shipment_track[0]:', JSON.stringify(td.shipment_track[0]).slice(0, 500));
      }
      console.log('shipment_track_activities:', Array.isArray(td.shipment_track_activities) ? td.shipment_track_activities.length + ' entries' : JSON.stringify(td.shipment_track_activities)?.slice(0, 100));
      console.log('shipment_activities:', Array.isArray(td.shipment_activities) ? td.shipment_activities.length + ' entries' : JSON.stringify(td.shipment_activities)?.slice(0, 100));
      console.log('activities:', Array.isArray(td.activities) ? td.activities.length + ' entries' : JSON.stringify(td.activities)?.slice(0, 100));
      console.log('tracking_history:', Array.isArray(td.tracking_history) ? td.tracking_history.length + ' entries' : JSON.stringify(td.tracking_history)?.slice(0, 100));
      console.log('checkpoints:', Array.isArray(td.checkpoints) ? td.checkpoints.length + ' entries' : JSON.stringify(td.checkpoints)?.slice(0, 100));
      console.log('track_status:', td.track_status);
      console.log('track_url:', td.track_url);
    }
  } catch (e) {
    console.error('TRACK FAILED HTTP STATUS:', e?.response?.status);
    console.error('TRACK FAILED BODY:', JSON.stringify(e?.response?.data, null, 2));
    console.error('TRACK FAILED ERROR:', e.message);
  }
}
test();
