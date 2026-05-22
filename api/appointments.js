module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    return res.status(200).json({
      success: true,
      message: 'Webhook received'
    });
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      success: true,
      message: 'Appointments endpoint working'
    });
  }

  return res.status(405).json({
    success: false,
    error: 'Method not allowed'
  });
};
