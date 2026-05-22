/**
 * Vercel Serverless Function: Appointment Handler
 *
 * Receives appointment data from Retell webhook
 * Validates, parses, and stores appointments
 */

const REQUIRED_FIELDS = ['customer_name', 'customer_phone', 'appointment_time'];
const APPOINTMENT_STATUS = {
  PENDING_CONFIRMATION: 'pending_confirmation',
  CONFIRMED: 'confirmed',
  CALENDAR_SYNCED: 'calendar_synced',
  FAILED: 'failed'
};

let appointmentStore = [];

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

  for (const field of REQUIRED_FIELDS) {
    if (!appointment[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (appointment.appointment_time) {
    const timestamp = new Date(appointment.appointment_time).getTime();
    if (isNaN(timestamp)) {
      errors.push(`Invalid appointment_time format`);
    }
    if (timestamp < Date.now()) {
      errors.push(`appointment_time is in the past`);
    }
  }

  if (appointment.customer_phone && !/^\+?[0-9\s\-()]+$/.test(appointment.customer_phone)) {
    errors.push(`Invalid phone format`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function storeAppointment(appointment) {
  const record = {
    id: generateAppointmentId(),
    ...appointment,
    status: APPOINTMENT_STATUS.PENDING_CONFIRMATION,
    created_at: new Date().toISOString(),
    calendar_event_id: null
  };

  appointmentStore.push(record);
  console.log(`Stored appointment: ${record.id}`);

  return record;
}

module.exports = async (req, res) => {
  // Set CORS headers to allow Retell
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Retell-Signature');
  res.setHeader('Content-Type', 'application/json');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // POST: Receive webhook from Retell
    if (req.method === 'POST') {
      const payload = req.body;

      if (!payload || !payload.agent_id) {
        return res.status(400).json({
          success: false,
          error: 'Invalid payload'
        });
      }

      console.log(`Webhook from agent: ${payload.agent_id}`);

      // Parse and validate
      const appointmentData = parseAppointmentData(payload);
      const validation = validateAppointment(appointmentData);

      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: validation.errors
        });
      }

      // Store
      const stored = storeAppointment(appointmentData);

      return res.status(201).json({
        success: true,
        message: 'Appointment received',
        appointment_id: stored.id,
        status: stored.status
      });
    }

    // GET: Query appointments
    if (req.method === 'GET') {
      const status = req.query?.status;
      const filtered = status
        ? appointmentStore.filter(apt => apt.status === status)
        : appointmentStore;

      return res.status(200).json({
        success: true,
        count: filtered.length,
        appointments: filtered
      });
    }

    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });

  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
};
