/**
 * Appointment Handler for Retell AI
 *
 * Receives appointment data from Retell webhook → parses → stores → prepares for calendar
 * Works with both Express.js and serverless (Vercel/Netlify/AWS Lambda)
 *
 * Webhook Flow:
 * Retell sends POST → appointmentHandler → validate → store → emit to calendar service
 *
 * Environment Variables Required:
 * - RETELL_WEBHOOK_SECRET (for signature verification)
 * - DATABASE_URL (or use in-memory store for now)
 * - GOOGLE_CALENDAR_SERVICE_ACCOUNT (for calendar integration later)
 */

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

const REQUIRED_FIELDS = ['agent_id', 'call_id', 'customer_name', 'customer_phone', 'appointment_time'];
const OPTIONAL_FIELDS = ['customer_email', 'service_type', 'duration_minutes', 'notes', 'location'];
const ALL_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

// Appointment statuses
const APPOINTMENT_STATUS = {
  PENDING_CONFIRMATION: 'pending_confirmation',
  CONFIRMED: 'confirmed',
  CALENDAR_SYNCED: 'calendar_synced',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

// ============================================================================
// IN-MEMORY STORAGE (Replace with DB for production)
// ============================================================================

let appointmentStore = [];

function generateAppointmentId() {
  return `apt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================================================
// VALIDATION & PARSING
// ============================================================================

/**
 * Validate webhook signature (Retell standard)
 * Prevents unauthorized requests
 */
function validateWebhookSignature(req) {
  const secret = process.env.RETELL_WEBHOOK_SECRET || 'dev-secret-key';
  const signature = req.headers['x-retell-signature'];

  if (!signature) {
    console.warn('[appointmentHandler] Missing webhook signature');
    return process.env.NODE_ENV === 'development'; // Allow in dev, require in prod
  }

  // TODO: Implement HMAC-SHA256 signature verification when Retell provides docs
  // For now, accept signature if present
  return true;
}

/**
 * Parse appointment data from Retell webhook payload
 * Retell sends: { agent_id, call_id, transcript, custom_fields: {...} }
 * We extract appointment details from transcript or custom_fields
 */
function parseAppointmentData(payload) {
  const data = {
    agent_id: payload.agent_id,
    call_id: payload.call_id,
    transcript: payload.transcript || null,
    custom_fields: payload.custom_fields || {}
  };

  // Extract appointment details (could come from transcript analysis or structured fields)
  const extracted = {
    agent_id: data.agent_id,
    call_id: data.call_id,

    // Try custom_fields first, fall back to defaults
    customer_name: data.custom_fields.customer_name || 'Unknown',
    customer_phone: data.custom_fields.customer_phone || null,
    customer_email: data.custom_fields.customer_email || null,
    service_type: data.custom_fields.service_type || 'Consultation',
    appointment_time: data.custom_fields.appointment_time || null,
    duration_minutes: data.custom_fields.duration_minutes || 30,
    location: data.custom_fields.location || null,
    notes: data.custom_fields.notes || null,
    timezone: data.custom_fields.timezone || 'America/New_York'
  };

  return extracted;
}

/**
 * Validate parsed appointment has all required fields
 */
function validateAppointment(appointment) {
  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (!appointment[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Validate appointment_time is valid ISO or unix timestamp
  if (appointment.appointment_time) {
    const timestamp = new Date(appointment.appointment_time).getTime();
    if (isNaN(timestamp)) {
      errors.push(`Invalid appointment_time format: ${appointment.appointment_time}`);
    }

    // Check it's not in the past
    if (timestamp < Date.now()) {
      errors.push(`appointment_time is in the past: ${appointment.appointment_time}`);
    }
  }

  // Validate phone format (basic)
  if (appointment.customer_phone && !/^\+?[0-9\s\-()]+$/.test(appointment.customer_phone)) {
    errors.push(`Invalid phone format: ${appointment.customer_phone}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// ============================================================================
// STORAGE & RETRIEVAL
// ============================================================================

/**
 * Store appointment for later calendar sync
 */
function storeAppointment(appointment, status = APPOINTMENT_STATUS.PENDING_CONFIRMATION) {
  const record = {
    id: generateAppointmentId(),
    ...appointment,
    status,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    calendar_event_id: null,
    error_message: null
  };

  appointmentStore.push(record);
  console.log(`[appointmentHandler] Stored appointment: ${record.id}`, record);

  return record;
}

/**
 * Retrieve appointments by status
 */
function getAppointmentsByStatus(status) {
  return appointmentStore.filter(apt => apt.status === status);
}

/**
 * Update appointment status and calendar event ID
 */
function updateAppointment(appointmentId, updates) {
  const index = appointmentStore.findIndex(apt => apt.id === appointmentId);
  if (index === -1) return null;

  appointmentStore[index] = {
    ...appointmentStore[index],
    ...updates,
    updated_at: new Date().toISOString()
  };

  console.log(`[appointmentHandler] Updated appointment: ${appointmentId}`, appointmentStore[index]);
  return appointmentStore[index];
}

/**
 * Get all appointments (for testing/dashboard)
 */
function getAllAppointments() {
  return appointmentStore;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Main webhook handler for Retell appointments
 * Signature:
 * - Express: (req, res) => void
 * - Serverless: (req, res) => void (same interface)
 */
async function appointmentHandler(req, res) {
  // Ensure we're looking at a POST request
  if (req.method !== 'POST') {
    return sendResponse(res, 405, {
      success: false,
      error: 'Method not allowed. Use POST.'
    });
  }

  try {
    // Step 1: Validate webhook signature
    if (!validateWebhookSignature(req)) {
      return sendResponse(res, 401, {
        success: false,
        error: 'Invalid or missing webhook signature'
      });
    }

    // Step 2: Parse request body
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    if (!payload || !payload.agent_id) {
      return sendResponse(res, 400, {
        success: false,
        error: 'Invalid payload. Expected { agent_id, call_id, custom_fields, ... }'
      });
    }

    console.log(`[appointmentHandler] Received webhook from agent: ${payload.agent_id}`);

    // Step 3: Parse appointment from Retell payload
    const appointmentData = parseAppointmentData(payload);

    // Step 4: Validate appointment
    const validation = validateAppointment(appointmentData);
    if (!validation.valid) {
      return sendResponse(res, 400, {
        success: false,
        error: 'Validation failed',
        details: validation.errors
      });
    }

    // Step 5: Store appointment
    const storedAppointment = storeAppointment(appointmentData, APPOINTMENT_STATUS.PENDING_CONFIRMATION);

    // Step 6: Emit to calendar service (async, don't wait)
    // This triggers the next phase: calendar integration
    emitToCalendarService(storedAppointment).catch(err => {
      console.error(`[appointmentHandler] Failed to emit to calendar:`, err);
      updateAppointment(storedAppointment.id, {
        status: APPOINTMENT_STATUS.FAILED,
        error_message: err.message
      });
    });

    // Step 7: Return success response
    return sendResponse(res, 201, {
      success: true,
      message: 'Appointment received and queued for calendar sync',
      appointment_id: storedAppointment.id,
      status: storedAppointment.status
    });

  } catch (error) {
    console.error(`[appointmentHandler] Error processing webhook:`, error);
    return sendResponse(res, 500, {
      success: false,
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// ============================================================================
// CALENDAR SERVICE INTEGRATION (Placeholder)
// ============================================================================

/**
 * Emit appointment to calendar service
 * Next phase: Connect Google Calendar API here
 * For now: Just log that it would be sent
 */
async function emitToCalendarService(appointment) {
  console.log(`[appointmentHandler] Would emit to calendar service:`, {
    appointment_id: appointment.id,
    customer_name: appointment.customer_name,
    appointment_time: appointment.appointment_time,
    duration_minutes: appointment.duration_minutes
  });

  // Placeholder: Later, this will:
  // 1. Call Google Calendar API to create event
  // 2. Send confirmation email via Gmail
  // 3. Update appointment.calendar_event_id
  // 4. Update status to CALENDAR_SYNCED

  return {
    calendar_event_id: `gcal_${Date.now()}`, // Mock
    confirmation_sent: true
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Send HTTP response (works with Express and serverless)
 */
function sendResponse(res, statusCode, body) {
  const contentType = 'application/json';
  const responseBody = JSON.stringify(body);

  // Express.js style
  if (typeof res.status === 'function') {
    return res.status(statusCode).set('Content-Type', contentType).send(responseBody);
  }

  // Serverless style (Vercel/Netlify)
  res.status = statusCode;
  res.headers = res.headers || {};
  res.headers['Content-Type'] = contentType;
  return responseBody;
}

/**
 * Health check endpoint (for testing deployment)
 */
async function healthCheck(req, res) {
  return sendResponse(res, 200, {
    success: true,
    message: 'Appointment handler is running',
    appointments_queued: appointmentStore.length,
    pending: getAppointmentsByStatus(APPOINTMENT_STATUS.PENDING_CONFIRMATION).length
  });
}

/**
 * Get appointments endpoint (for dashboard/testing)
 */
async function getAppointments(req, res) {
  const status = req.query?.status;

  let appointments;
  if (status) {
    appointments = getAppointmentsByStatus(status);
  } else {
    appointments = getAllAppointments();
  }

  return sendResponse(res, 200, {
    success: true,
    count: appointments.length,
    appointments
  });
}

// ============================================================================
// ROUTER (Express.js compatible)
// ============================================================================

/**
 * Route appointments to correct handler
 * POST /api/appointments → appointmentHandler
 * GET /api/appointments → getAppointments
 * GET /health → healthCheck
 */
function routeRequest(req, res) {
  const { pathname } = new URL(req.url || '', 'http://localhost');

  if (pathname === '/api/appointments' && req.method === 'POST') {
    return appointmentHandler(req, res);
  }

  if (pathname === '/api/appointments' && req.method === 'GET') {
    return getAppointments(req, res);
  }

  if (pathname === '/health' || pathname === '/api/health') {
    return healthCheck(req, res);
  }

  return sendResponse(res, 404, {
    success: false,
    error: 'Endpoint not found',
    available: [
      'POST /api/appointments (webhook from Retell)',
      'GET /api/appointments (retrieve appointments)',
      'GET /health (health check)'
    ]
  });
}

// ============================================================================
// EXPORTS (for both Node.js and serverless)
// ============================================================================

module.exports = {
  // Main handlers
  appointmentHandler,
  healthCheck,
  getAppointments,
  routeRequest,

  // Utilities (for testing)
  parseAppointmentData,
  validateAppointment,
  storeAppointment,
  updateAppointment,
  getAllAppointments,
  getAppointmentsByStatus,

  // Constants
  APPOINTMENT_STATUS,
  REQUIRED_FIELDS,
  OPTIONAL_FIELDS
};

// ============================================================================
// QUICK START
// ============================================================================

/**
 * EXPRESS.JS SETUP:
 *
 * const express = require('express');
 * const { appointmentHandler, healthCheck, getAppointments } = require('./appointmentHandler');
 *
 * const app = express();
 * app.use(express.json());
 *
 * app.post('/api/appointments', appointmentHandler);
 * app.get('/api/appointments', getAppointments);
 * app.get('/health', healthCheck);
 *
 * app.listen(3001, () => console.log('Server running on :3001'));
 *
 * ---
 *
 * VERCEL SERVERLESS SETUP (api/appointments.js):
 *
 * const { appointmentHandler } = require('../appointmentHandler');
 *
 * module.exports = appointmentHandler;
 *
 * ---
 *
 * NETLIFY SERVERLESS SETUP (functions/appointments.js):
 *
 * const { routeRequest } = require('../appointmentHandler');
 *
 * exports.handler = async (event, context) => {
 *   const req = {
 *     method: event.httpMethod,
 *     url: event.path,
 *     body: event.body ? JSON.parse(event.body) : {},
 *     query: event.queryStringParameters || {},
 *     headers: event.headers || {}
 *   };
 *
 *   let res = {};
 *   await routeRequest(req, res);
 *
 *   return {
 *     statusCode: res.status || 200,
 *     headers: { 'Content-Type': 'application/json' },
 *     body: res.body || '{}'
 *   };
 * };
 */
