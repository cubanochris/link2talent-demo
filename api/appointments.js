/**
 * Vercel Serverless Function: Appointment Handler
 *
 * Wraps appointmentHandler.js for Vercel's request/response format
 */

const { appointmentHandler } = require('../Backend/appointmentHandler');

module.exports = async (req, res) => {
  try {
    // Vercel passes req and res directly to the handler
    // appointmentHandler expects (req, res) with Express-like methods

    // Ensure res has required methods
    if (!res.status) {
      res.status = function(code) {
        this.statusCode = code;
        return this;
      };
    }

    if (!res.set) {
      res.set = function(key, value) {
        this.headers = this.headers || {};
        this.headers[key] = value;
        return this;
      };
    }

    if (!res.send) {
      res.send = function(body) {
        if (typeof body === 'string') {
          this.body = body;
        } else {
          this.body = JSON.stringify(body);
        }
        return this;
      };
    }

    // Call the handler
    await appointmentHandler(req, res);

    // Vercel expects explicit response
    if (!res.statusCode) {
      res.statusCode = 200;
    }

    res.setHeader = res.setHeader || function(key, value) {
      this.headers = this.headers || {};
      this.headers[key] = value;
    };

    res.setHeader('Content-Type', 'application/json');

    // Send response
    res.end(res.body || '{"success": false}');

  } catch (error) {
    console.error('[Vercel Handler Error]', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: false,
      error: 'Internal server error',
      message: error.message
    }));
  }
};
