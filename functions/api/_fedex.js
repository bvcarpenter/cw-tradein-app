/**
 * FedEx REST API helper for Cloudflare Workers.
 *
 * Handles OAuth2 token acquisition and Ship API calls.
 * Uses FedEx Express Saver One Rate, Extra Large Box, 5 lbs.
 *
 * Required env vars:
 *   FEDEX_API_KEY, FEDEX_SECRET_KEY, FEDEX_ACCOUNT_NUMBER
 */

// Set FEDEX_SANDBOX=true in Cloudflare vars to use sandbox endpoints
function fedexBaseUrl(env) {
  return env.FEDEX_SANDBOX === 'true'
    ? 'https://apis-sandbox.fedex.com'
    : 'https://apis.fedex.com';
}

/**
 * Destination store addresses — update with real addresses.
 */
const STORE_ADDRESSES = {
  'San Francisco': {
    streetLines: ['120 Maiden Ln'],
    city: 'San Francisco',
    stateOrProvinceCode: 'CA',
    postalCode: '94108',
    countryCode: 'US',
    residential: false,
    contact: { personName: 'Camera West SF', phoneNumber: '9259351424', companyName: 'Camera West' },
  },
  'Palm Springs': {
    streetLines: ['70177 CA-111'],
    city: 'Rancho Mirage',
    stateOrProvinceCode: 'CA',
    postalCode: '92270',
    countryCode: 'US',
    residential: false,
    contact: { personName: 'Camera West PS', phoneNumber: '7609925422', companyName: 'Camera West' },
  },
  'SoHo — New York': {
    streetLines: ['460 W Broadway'],
    city: 'New York',
    stateOrProvinceCode: 'NY',
    postalCode: '10012',
    countryCode: 'US',
    residential: false,
    contact: { personName: 'Camera West SoHo', phoneNumber: '6464762308', companyName: 'Camera West' },
  },
  'Leica SF': {
    streetLines: ['463 Bush St'],
    city: 'San Francisco',
    stateOrProvinceCode: 'CA',
    postalCode: '94108',
    countryCode: 'US',
    residential: false,
    contact: { personName: 'Leica Store SF', phoneNumber: '4158015066', companyName: 'Leica Store San Francisco' },
  },
};

/**
 * Get an OAuth2 access token from FedEx.
 */
async function getFedExToken(env) {
  const res = await fetch(fedexBaseUrl(env) + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.FEDEX_API_KEY,
      client_secret: env.FEDEX_SECRET_KEY,
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`FedEx auth failed: ${data.errors?.[0]?.message || JSON.stringify(data)}`);
  }
  return data.access_token;
}

/**
 * Create a FedEx shipment and return the label.
 *
 * @param {object} env          — Cloudflare env bindings
 * @param {object} shipper      — { name, phone, street, city, state, zip }
 * @param {string} destStore    — Store name key from STORE_ADDRESSES
 * @param {string} [reference]  — Optional reference (e.g. CM number)
 * @returns {{ trackingNumber, labelPdf, totalCharge }}
 */
export async function createFedExLabel(env, shipper, destStore, reference) {
  const dest = STORE_ADDRESSES[destStore];
  if (!dest) {
    throw new Error(`Unknown destination store: "${destStore}". Valid: ${Object.keys(STORE_ADDRESSES).join(', ')}`);
  }

  const token = await getFedExToken(env);

  const shipmentPayload = {
    labelResponseOptions: 'LABEL',
    accountNumber: { value: env.FEDEX_ACCOUNT_NUMBER },
    requestedShipment: {
      shipper: {
        address: {
          streetLines: [shipper.street],
          city: shipper.city,
          stateOrProvinceCode: shipper.state,
          postalCode: shipper.zip,
          countryCode: 'US',
          residential: true,
        },
        contact: {
          personName: shipper.name,
          phoneNumber: shipper.phone || '0000000000',
        },
      },
      recipients: [{
        address: {
          streetLines: dest.streetLines,
          city: dest.city,
          stateOrProvinceCode: dest.stateOrProvinceCode,
          postalCode: dest.postalCode,
          countryCode: dest.countryCode,
          residential: dest.residential,
        },
        contact: {
          personName: dest.contact.personName,
          phoneNumber: dest.contact.phoneNumber,
          companyName: dest.contact.companyName,
        },
      }],
      pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      serviceType: 'FEDEX_EXPRESS_SAVER',
      packagingType: 'FEDEX_EXTRA_LARGE_BOX',
      shippingChargesPayment: {
        paymentType: 'SENDER',
        payor: {
          responsibleParty: {
            accountNumber: { value: env.FEDEX_ACCOUNT_NUMBER },
          },
        },
      },
      labelSpecification: {
        labelFormatType: 'COMMON2D',
        imageType: 'PDF',
        labelStockType: 'PAPER_85X11_TOP_HALF_LABEL',
      },
      rateRequestType: ['ACCOUNT'],
      requestedPackageLineItems: [{
        weight: {
          units: 'LB',
          value: 5,
        },
      }],
      shipmentSpecialServices: {
        specialServiceTypes: ['FEDEX_ONE_RATE'],
      },
    },
  };

  // Add reference if provided (e.g. Credit Memo number)
  if (reference) {
    shipmentPayload.requestedShipment.requestedPackageLineItems[0].customerReferences = [{
      customerReferenceType: 'CUSTOMER_REFERENCE',
      value: reference,
    }];
  }

  const res = await fetch(fedexBaseUrl(env) + '/ship/v1/shipments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(shipmentPayload),
  });

  const data = await res.json();

  if (!res.ok || data.errors?.length) {
    const msg = data.errors?.map(e => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`FedEx Ship API: ${msg}`);
  }

  const piece = data.output?.transactionShipments?.[0]?.pieceResponses?.[0]
    || data.output?.transactionShipments?.[0]?.shipmentDocuments?.[0];

  const shipment = data.output?.transactionShipments?.[0];
  const trackingNumber = shipment?.masterTrackingNumber?.trackingNumber
    || piece?.trackingNumber
    || 'UNKNOWN';

  // Label PDF is base64-encoded in the response
  const labelDoc = shipment?.shipmentDocuments?.find(d => d.contentType === 'LABEL')
    || shipment?.pieceResponses?.[0]?.packageDocuments?.find(d => d.contentType === 'LABEL');
  const labelPdf = labelDoc?.encodedLabel || labelDoc?.parts?.[0]?.image || null;

  const totalCharge = shipment?.completedShipmentDetail?.shipmentRating?.shipmentRateDetails?.[0]?.totalNetCharge?.amount || null;

  return { trackingNumber, labelPdf, totalCharge };
}

/**
 * Track a FedEx shipment by tracking number.
 *
 * @param {object} env            — Cloudflare env bindings
 * @param {string} trackingNumber — FedEx tracking number
 * @returns {{ status: string, statusDetail: string, delivered: boolean }}
 */
export async function trackFedExShipment(env, trackingNumber) {
  const token = await getFedExToken(env);

  const res = await fetch(fedexBaseUrl(env) + '/track/v1/trackingnumbers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      includeDetailedScans: false,
      trackingInfo: [{
        trackingNumberInfo: { trackingNumber },
      }],
    }),
  });

  const data = await res.json();

  if (!res.ok || data.errors?.length) {
    const msg = data.errors?.map(e => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`FedEx Track API: ${msg}`);
  }

  const result = data.output?.completeTrackResults?.[0]?.trackResults?.[0];
  if (!result) throw new Error('No tracking result returned');

  const statusCode = result.latestStatusDetail?.code || '';
  const statusDesc = result.latestStatusDetail?.description || result.latestStatusDetail?.statusByLocale || '';
  const delivered = statusCode === 'DL';

  return { status: statusCode, statusDetail: statusDesc, delivered };
}
