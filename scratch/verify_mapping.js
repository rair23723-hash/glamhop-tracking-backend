const assert = require('assert');
const { getTrackingByAWB } = require('../lib/shiprocket');

// Setup mock axios for testing mapping
const axios = require('axios');
const originalGet = axios.get;

const mockShiprocketResponse = {
  tracking_data: {
    track_status: 1,
    shipment_status: 7,
    shipment_track: [{
      awb_code: '370604336417',
      courier_name: 'Amazon Shipping Surface 1kg',
      destination: 'Faizabad',
      origin: 'Faizabad',
      delivered_to: 'Faizabad'
    }],
    shipment_track_activities: [
      {
        date: '2026-07-07 12:42:50',
        status: 'Delivered',
        activity: 'Delivered',
        location: 'NA', // Amazon style location
        'sr-status-label': 'DELIVERED'
      },
      {
        date: '2026-07-07 12:39:48',
        status: 'Departed',
        activity: 'Departed',
        location: 'Delhi Hub, Delhi, IND', // Normal location string
        'sr-status-label': 'IN TRANSIT'
      },
      {
        date: '2026-07-07 12:36:57',
        status: 'Arrived',
        activity: 'Arrived',
        city: 'Mumbai', // Separate fields style
        state: 'Maharashtra',
        country: 'IN',
        'sr-status-label': 'IN TRANSIT'
      },
      {
        date: '2026-07-07 12:30:00',
        status: 'Pickup',
        activity: 'Pickup',
        location: 'NA', // Genuinely empty but no fallback context
        'sr-status-label': 'PICKUP'
      }
    ]
  }
};

// Shopify style shipping address fallback context
const mockShippingAddress = {
  city: 'Faizabad',
  province: 'Uttar Pradesh',
  country_code: 'IND'
};

async function runTest() {
  console.log('--- STARTING LOCATION MAPPING VERIFICATION TESTS ---');

  // Stub axios.get to return our mock tracking response
  axios.get = async function (url) {
    return {
      status: 200,
      data: mockShiprocketResponse
    };
  };

  // Test 1: Full flow with Shopify shipping address fallback
  console.log('\nTest 1: Check mapping with Shopify shipping address fallback');
  const result = await getTrackingByAWB('370604336417', mockShippingAddress);
  const events = result.events;

  // 1st event: should fallback to Shopify shipping address
  console.log('Event 0 Location:', JSON.stringify(events[0].location));
  assert.strictEqual(events[0].location, 'Faizabad, Uttar Pradesh, IND', 'Event 0 should fall back to Shopify shipping address');
  assert.strictEqual(events[0].city, 'Faizabad');
  assert.strictEqual(events[0].state, 'Uttar Pradesh');
  assert.strictEqual(events[0].country, 'IND');

  // 2nd event: should use its own location
  console.log('Event 1 Location:', JSON.stringify(events[1].location));
  assert.strictEqual(events[1].location, 'Delhi Hub, Delhi, IND', 'Event 1 should use its own location string');
  assert.strictEqual(events[1].city, 'Delhi Hub');
  assert.strictEqual(events[1].state, 'Delhi');
  assert.strictEqual(events[1].country, 'IND');

  // 3rd event: should combine separate city/state/country fields
  console.log('Event 2 Location:', JSON.stringify(events[2].location));
  assert.strictEqual(events[2].location, 'Mumbai, Maharashtra, IN', 'Event 2 should combine Mumbai, Maharashtra, IN');
  assert.strictEqual(events[2].city, 'Mumbai');
  assert.strictEqual(events[2].state, 'Maharashtra');
  assert.strictEqual(events[2].country, 'IN');

  // Test 2: Full flow WITHOUT Shopify shipping address fallback (Direct AWB Lookup style)
  console.log('\nTest 2: Check mapping without Shopify shipping address (falls back to Shiprocket destination)');
  const resultNoAddress = await getTrackingByAWB('370604336417', null);
  const eventsNoAddress = resultNoAddress.events;

  // 1st event: should fallback to Shiprocket destination (Faizabad) + default country (India)
  console.log('Event 0 (No Shopify context) Location:', JSON.stringify(eventsNoAddress[0].location));
  assert.strictEqual(eventsNoAddress[0].location, 'Faizabad, India', 'Event 0 should fall back to Shiprocket destination and default country');
  assert.strictEqual(eventsNoAddress[0].city, 'Faizabad');
  assert.strictEqual(eventsNoAddress[0].state, '');
  assert.strictEqual(eventsNoAddress[0].country, 'India');

  // Test 3: Genuinely empty case (no activity location, no shippingAddress, no shipmentTrack0 destination)
  console.log('\nTest 3: Genuinely empty case (should result in empty location string, hiding it in UI)');
  const emptyResponse = {
    tracking_data: {
      shipment_track: [],
      shipment_track_activities: [{
        date: '2026-07-07 12:42:50',
        status: 'Delivered',
        activity: 'Delivered',
        location: 'NA'
      }]
    }
  };
  axios.get = async function() {
    return { status: 200, data: emptyResponse };
  };

  const resultEmpty = await getTrackingByAWB('370604336417', null);
  console.log('Event 0 (Genuinely Empty) Location:', JSON.stringify(resultEmpty.events[0].location));
  assert.strictEqual(resultEmpty.events[0].location, '', 'Genuinely empty location should be empty string (not NA/null)');
  assert.strictEqual(resultEmpty.events[0].city, '');
  assert.strictEqual(resultEmpty.events[0].state, '');
  assert.strictEqual(resultEmpty.events[0].country, '');

  console.log('\n✅ ALL MAPPING VERIFICATION TESTS PASSED SUCCESSFULLY!');
}

runTest().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
