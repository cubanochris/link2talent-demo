/**
 * Vercel Serverless Function: Appointment Handler
 *
 * Simple test to verify function works, then integrate appointmentHandler
 */

module.exports = async (req, res) => {
  try {
    // Test: Return basic response
    res.status(200).json({
      success: true,
      message: 'Appointment handler is running',
      method: req.method,
      path: req.url
    });

  } catch (error) {
    console.error('[Vercel Error]', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
