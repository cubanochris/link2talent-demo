/**
 * Vercel Serverless Function: Appointment Handler
 * Receives appointment data from Retell webhook
 */

// In-memory storage
let appointmentStore = [];

function generateAppointmentId() {
  return `apt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // POST: Receive webhook from Retell
    if (req.method === 'POST') {
      const payload = req.body;

      // Validate payload has required fields
      if (!payload || !payload.agent_id) {
        return res.status(400).json({
          success: false,
          error: 'Missing agent_id in payload'
        });
      }

      // Extract appointment data
      const customFields = payload.custom_fields || {};
      const appointment = {
        id: generateAppointmentId(),
        agent_id: payload.agent_id,
        call_id: payload.call_id,
        customer_name: customFields.customer_name || 'Unknown',
        customer_phone: customFields.customer_phone,
        customer_email: customFields.customer_email,
        appointment_time: customFields.appointment_time,
        service_type: customFields.service_type,
        duration_minutes: customFields.duration_minutes || 30,
        location: customFields.location,
        notes: customFields.notes,
        timezone: customFields.timezone || 'America/New_York',
        status: 'pending_confirmation',
        created_at: new Date().toISOString()
      };

      // Store appointment
      appointmentStore.push(appointment);

      return res.status(201).json({
        success: true,
        message: 'Appointment received and stored',
        appointment_id: appointment.id,
        status: appointment.status,
        created_at: appointment.created_at
      });
    }

    // GET: Query stored appointments
    if (req.method === 'GET') {
      const status = req.query?.status;
      const filtered = status
        ? appointmentStore.filter(apt => apt.status === status)
        : appointmentStore;

      return res.status(200).json({
        success: true,
        count: filtered.length,
        status: status || 'all',
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
