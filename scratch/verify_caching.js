const assert = require('assert');
const axios = require('axios');

// Mock implementation of axios
const originalPost = axios.post;
const originalGet = axios.get;

let loginCalls = 0;
let getCalls = 0;

// Setup environmental variables for testing
process.env.SHIPROCKET_EMAIL = 'test@example.com';
process.env.SHIPROCKET_PASSWORD = 'password123';

// Mock axios.post and axios.get
axios.post = async function (url, data, config) {
  if (url.endsWith('/auth/login')) {
    loginCalls++;
    console.log(`[Mock Axios] POST /auth/login called (${loginCalls} times)`);
    // Simulate slight delay
    await new Promise(r => setTimeout(r, 50));
    return {
      status: 200,
      data: { token: `mock_jwt_token_attempt_${loginCalls}` }
    };
  }
  return originalPost.apply(this, arguments);
};

axios.get = async function (url, config) {
  getCalls++;
  console.log(`[Mock Axios] GET ${url} called (${getCalls} times)`);
  return {
    status: 200,
    data: {
      tracking_data: {
        shipment_track: [{ courier_name: 'Delhivery', awb_code: '12345' }],
        shipment_track_activities: []
      }
    }
  };
};

// Require the shiprocket module
const shiprocket = require('../lib/shiprocket');

async function testCacheAndReuse() {
  console.log('--- STARTING VERIFICATION TESTS ---');

  // Test 1: First call should trigger login
  console.log('\nTest 1: Call getTrackingByAWB first time');
  await shiprocket.getTrackingByAWB('12345');
  assert.strictEqual(loginCalls, 1, 'Should have called login once');
  assert.strictEqual(getCalls, 1, 'Should have called get once');

  // Test 2: Second call should reuse the cached token (no login call)
  console.log('\nTest 2: Call getTrackingByAWB second time (should reuse token)');
  await shiprocket.getTrackingByAWB('12345');
  assert.strictEqual(loginCalls, 1, 'Should NOT have called login again');
  assert.strictEqual(getCalls, 2, 'Should have called get twice');

  // Test 3: Concurrent calls should trigger only one login
  console.log('\nTest 3: Invalidate cache and trigger concurrent calls');
  // We can force expiry/invalidation by hacking the internal token cache via triggering a mock 401 error or modifying variables.
  // Since tokenCache is in module closure, let's trigger a 401 error from axios.get to force invalidation.
  let return401Once = true;
  axios.get = async function (url, config) {
    if (return401Once) {
      return401Once = false;
      console.log('[Mock Axios] GET returning 401 Unauthorized to trigger invalidation');
      const err = new Error('Request failed with status code 401');
      err.response = { status: 401, data: { message: 'Unauthorized' } };
      throw err;
    }
    getCalls++;
    console.log(`[Mock Axios] GET ${url} called (${getCalls} times)`);
    return {
      status: 200,
      data: {
        tracking_data: {
          shipment_track: [{ courier_name: 'Delhivery', awb_code: '12345' }],
          shipment_track_activities: []
        }
      }
    };
  };

  // Reset loginCalls counter to 0 for clear count
  loginCalls = 0;

  // Run three concurrent tracking requests. They should all wait on the single login call.
  console.log('Triggering 3 concurrent tracking calls...');
  const promises = [
    shiprocket.getTrackingByAWB('12345'),
    shiprocket.getTrackingByAWB('12345'),
    shiprocket.getTrackingByAWB('12345')
  ];

  await Promise.all(promises);

  console.log(`Summary of login calls after 401 and concurrency: ${loginCalls}`);
  assert.strictEqual(loginCalls, 1, 'Should have only performed ONE login call for all concurrent requests after 401 invalidation');

  console.log('\n✅ ALL VERIFICATION TESTS PASSED SUCCESSFULLY! Shiprocket token cache works perfectly.');
}

testCacheAndReuse().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
