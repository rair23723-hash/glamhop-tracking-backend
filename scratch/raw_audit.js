/**
 * Pure Node.js (https built-in) Shiprocket audit — no dotenv needed
 * Run: node scratch/raw_audit.js
 */
const https = require('https');

const EMAIL    = 'rair23723@gmail.com';
const PASSWORD = 'Ravirai@123';
const AWB      = '370604336417';

function post(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 20000
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(payload);
    req.end();
  });
}

function get(hostname, path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 20000
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

async function run() {
  console.log('=== STEP 1: AUTHENTICATE ===');
  let token;
  try {
    const r = await post('apiv2.shiprocket.in', '/v1/external/auth/login', { email: EMAIL, password: PASSWORD });
    console.log('Auth HTTP Status:', r.status);
    if (r.status === 200 && r.data.token) {
      token = r.data.token;
      console.log('Auth SUCCESS. Token (first 40 chars):', token.slice(0, 40));
    } else {
      console.error('Auth FAILED. Response:', JSON.stringify(r.data));
      return;
    }
  } catch(e) {
    console.error('Auth request THREW:', e.message);
    return;
  }

  console.log('\n=== STEP 2: TRACK AWB', AWB, '===');
  try {
    const r = await get('apiv2.shiprocket.in', `/v1/external/courier/track/awb/${AWB}`, token);
    console.log('Track HTTP Status:', r.status);
    console.log('\n=== FULL RAW RESPONSE ===');
    console.log(JSON.stringify(r.data, null, 2));

    const td = r.data?.tracking_data;
    console.log('\n=== FIELD AUDIT ===');
    console.log('tracking_data exists:', !!td);
    if (td) {
      console.log('ALL KEYS in tracking_data:', Object.keys(td).join(', '));
      console.log('\n--- shipment_track ---');
      console.log('Type:', typeof td.shipment_track, '| isArray:', Array.isArray(td.shipment_track));
      if (Array.isArray(td.shipment_track)) {
        console.log('Length:', td.shipment_track.length);
        if (td.shipment_track[0]) console.log('Keys in [0]:', Object.keys(td.shipment_track[0]).join(', '));
      }
      console.log('\n--- shipment_track_activities ---');
      console.log('Type:', typeof td.shipment_track_activities, '| isArray:', Array.isArray(td.shipment_track_activities));
      console.log('Value:', JSON.stringify(td.shipment_track_activities)?.slice(0, 300));
      
      console.log('\n--- shipment_activities ---');
      console.log('Type:', typeof td.shipment_activities, '| isArray:', Array.isArray(td.shipment_activities));
      console.log('Value:', JSON.stringify(td.shipment_activities)?.slice(0, 300));

      console.log('\n--- activities ---');
      console.log('Type:', typeof td.activities, '| isArray:', Array.isArray(td.activities));
      console.log('Value:', JSON.stringify(td.activities)?.slice(0, 300));

      console.log('\n--- track_status ---');
      console.log('Value:', td.track_status, '| type:', typeof td.track_status);

      console.log('\n--- track_url ---');
      console.log('Value:', td.track_url);

      // Print FIRST activity structure if any exist
      const activities = td.shipment_track_activities || td.shipment_activities || td.activities || [];
      if (Array.isArray(activities) && activities.length > 0) {
        console.log('\n=== FIRST ACTIVITY FULL STRUCTURE ===');
        console.log(JSON.stringify(activities[0], null, 2));
        console.log('\nAll keys in first activity:', Object.keys(activities[0]).join(', '));
      }
    }
  } catch(e) {
    console.error('Track request THREW:', e.message);
  }
}

run().catch(console.error);
