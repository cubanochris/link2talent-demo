/**
 * Vercel Serverless Function: Appointment Handler
 *
 * Receives appointment data from Retell webhook
 * Validates, parses, and stores appointments
 */

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

const REQUIRED_FIELDS = ['customer_name', 'customer_phone', 'appointment_time'];
const APPOINTMENT_STATUS = {
  PENDING_CONFIRMATION: 'pending_confirmation',
  CONFIRMED: 'confirmed',
  CALENDAR_SYNCED: 'calendar_synced',
  FAILED: 'failed'
};

// In-memory storage (replace with database for production)
let appointmentStore = [];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function generateAppointmentId() {
  return `apt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function parseAppointmentData(payload) {
  return {
    agent_id: payload.agent_id,
    call_id: payload.call_id,
    customer_name: payload.custom_fields?.customer_name || 'Unknown',
    customer_phone: payload.custom_fields?.customer_phone || null,
    customer_email: payload.custom_fields?.customer_email || null,
    service_type: payload.custom_fields?.service_type || 'Consultation',
    appointment_time: payload.custom_fields?.appointment_time || null,
    duration_minutes: payload.custom_fields?.duration_minutes || 30,
    location: payload.custom_fields?.location || null,
    notes: payload.custom_fields?.notes || null,
    timezone: payload.custom_fields?.timezone || 'America/New_York'
  };
}

function validateAppointment(appointment) {
  const errors = [];

  // Check required fields
  for (const field of REQUIRED_FIELDS) {
    if (!appointment[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Validate timestamp
  if (appointment.appointment_time) {
    const timestamp = new Date(appointment.appointment_time).getTime();
    if (isNaN(timestamp)) {
      errors.push(`Invalid appointment_time format: ${appointment.appointment_time}`);
    }
    if (timestamp < Date.now()) {
      errors.push(`appointment_time is in the past: ${appointment.appointment_time}`);
    }
  }

  // Validate phone
  if (appointment.customer_phone && !/^\+?[0-9\s\-()]+$/.test(appointment.customer_phone)) {
    errors.push(`Invalid phone format: ${appointment.customer_phone}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

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
  console.log(`[appointmentHandler] Stored appointment: ${record.id}`);

  return record;
}

function getAllAppointments(status = null) {
  if (status) {
    return appointmentStore.filter(apt => apt.status === status);
  }
  return appointmentStore;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

module.exports = async (req, res) => {
  try {
    // Only accept POST for webhook, GET for queries
    if (req.method === 'POST') {
      return handlePostAppointment(req, res);
    } else if (req.method === 'GET') {
      return handleGetAppointments(req, res);
    } else {
      return res.status(405).json({
        success: false,
        error: 'Method not allowed. Use POST or GET.'
      });
    }

  } catch (error) {
    console.error('[appointmentHandler Error]', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
};

function handlePostAppointment(req, res) {
  try {
    // Parse request body
    const payload = req.body;

    if (!payload || !payload.agent_id) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payload. Expected { agent_id, call_id, custom_fields, ... }'
      });
    }

    console.log(`[appointmentHandler] Received webhook from agent: ${payload.agent_id}`);

    // Parse appointment data
    const appointmentData = parseAppointmentData(payload);

    // Validate appointment
    const validation = validateAppointment(appointmentData);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: validation.errors
      });
    }

    // Store appointment
    const storedAppointment = storeAppointment(appointmentData, APPOINTMENT_STATUS.PENDING_CONFIRMATION);

    // Return success
    return res.status(201).json({
      success: true,
      message: 'Appointment received and queued for calendar sync',
      appointment_id: storedAppointment.id,
      status: storedAppointment.status
    });

  } catch (error) {
    console.error('[handlePostAppointment Error]', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
}

function handleGetAppointments(req, res) {
  try {
    const status = req.query?.status;
    const appointments = getAllAppointments(status);

    return res.status(200).json({
      success: true,
      count: appointments.length,
      status: status || 'all',
      appointments
    });

  } catch (error) {
    console.error('[handleGetAppointments Error]', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
}
