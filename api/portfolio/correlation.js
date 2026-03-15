import { createClient } from 'redis';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const client = createClient({ url: process.env.REDIS_URL });
    await client.connect();
    
    // Fetch the matrix saved by generate-correlation.js
    const data = await client.get('portfolio_correlation');
    await client.quit();

    if (data) {
      return res.status(200).json(JSON.parse(data));
    } else {
      return res.status(404).json({ error: 'Correlation matrix not found in database.' });
    }
  } catch (error) {
    console.error('Redis fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch correlation data' });
  }
}
