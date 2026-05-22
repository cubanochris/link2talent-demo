/**
 * Debug: Log everything Retell sends
 */

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Log the raw request
  console.log('METHOD:', req.method);
  console.log('URL:', req.url);
  console.log('HEADERS:', JSON.stringify(req.headers));
  console.log('BODY TYPE:', typeof req.body);
  console.log('BODY:', JSON.stringify(req.body));

  // Handle OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Accept any POST and return 200
  if (req.method === 'POST') {
    console.log('✓ POST accepted');
    return res.status(200).json({
      success: true,
      received: req.body
    });
  }

  // GET
  if (req.method === 'GET') {
    return res.status(200).json({
      success: true,
      message: 'Working'
    });
  }

  return res.status(405).json({
    error: 'Method not allowed'
  });
};
